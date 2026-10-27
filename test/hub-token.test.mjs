import test, { after } from 'node:test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManager, atomicPrivateJson } from '../lib/hub-token.mjs';
const HUB_ID = '11111111-2222-3333-4444-555555555555';
const HUB_HOST = '127.0.0.1';

const certDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-cert-test-'));
after(() => fs.rm(certDir, { recursive: true, force: true }));
const certFile = path.join(certDir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', path.join(certDir, 'key.pem'), '-out', certFile, '-subj', '/CN=test',
  '-addext', `subjectAltName=DNS:svc-hla-tcp.hub-${HUB_ID}.smartthings`], { stdio: 'ignore' });
const CERTIFICATE = await fs.readFile(certFile, 'utf8');
const NOW = Date.parse('2026-10-26T18:00:00.000Z');
const SECOND = NOW / 1000;
const HOUR = 3600;
const AUTH_ORIGIN = 'https://eu-auth2.samsungosp.com';

function jwt(exp, marker = 'fixture') {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ device_id: HUB_ID, exp })}.${marker}`;
}
function samsung(overrides = {}) {
  return { version: 1, clientId: '6iado3s6jc', authServerUrl: AUTH_ORIGIN, apiServerUrl: AUTH_ORIGIN,
    access_token: 'synthetic-sa-access-old', refresh_token: 'synthetic-sa-refresh-old',
    receivedAt: new Date(NOW).toISOString(), accessTokenExpiresAt: SECOND + HOUR,
    refreshTokenExpiresAt: SECOND + 30 * 24 * HOUR, ...overrides };
}
function hub(overrides = {}) {
  return { hubId: HUB_ID, hubHost: HUB_HOST, issuedAt: new Date(NOW).toISOString(),
    access_token: jwt(SECOND + HOUR, 'old'), public_certificate: CERTIFICATE, ...overrides };
}
function issuedHub() {
  return { status: 200, data: { access_token: jwt(SECOND + 24 * HOUR, 'new'), public_certificate: CERTIFICATE } };
}
function refreshedSamsung(overrides = {}) {
  return { status: 200, data: { access_token: 'synthetic-sa-access-new', refresh_token: 'synthetic-sa-refresh-new',
    access_token_expires_in: '3600', refresh_token_expires_in: '2592000', ...overrides } };
}
function isRefresh(request) { return request.url === `${AUTH_ORIGIN}/auth/oauth2/token`; }
async function fixture(t, { sa = samsung(), savedHub = hub(), request, probe } = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-st-hub-token-test-'));
  await fs.chmod(stateDir, 0o700);
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const saFile = path.join(stateDir, 'samsung-account-token.json');
  const hubFile = path.join(stateDir, 'hub-local-token.json');
  if (sa) await fs.writeFile(saFile, JSON.stringify(sa), { mode: 0o600 });
  if (savedHub) await fs.writeFile(hubFile, JSON.stringify(savedHub), { mode: 0o600 });
  const calls = [];
  const manager = createManager({ stateDir, hubId: HUB_ID, hubHost: HUB_HOST, now: () => NOW,
    request: async value => {
      calls.push(value);
      return request ? request(value, calls.length) : issuedHub();
    }, probe: probe ?? (async () => ({ status: 200, certificateVerified: true, alpn: 'h2' })) });
  return { stateDir, saFile, hubFile, calls, manager,
    readSa: async () => JSON.parse(await fs.readFile(saFile, 'utf8')),
    readHub: async () => JSON.parse(await fs.readFile(hubFile, 'utf8')) };
}

test('rotation is durable before hub failure, and retry uses saved access token without another refresh', async t => {
  let f;
  f = await fixture(t, { sa: samsung({ accessTokenExpiresAt: SECOND - 1 }),
    request: async (request, count) => {
      if (count === 1) {
        assert.ok(isRefresh(request));
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'synthetic-sa-refresh-old');
        return refreshedSamsung();
      }
      const saved = await f.readSa();
      assert.equal(saved.refresh_token, 'synthetic-sa-refresh-new');
      assert.equal(saved.access_token, 'synthetic-sa-access-new');
      assert.equal(saved.accessTokenExpiresAt, SECOND + HOUR);
      assert.equal(request.headers.Authorization, 'Bearer synthetic-sa-access-new');
      if (count === 2) return { status: 500, data: { message: 'untrusted synthetic response' } };
      assert.equal(isRefresh(request), false);
      return issuedHub();
    } });
  const oldHub = await fs.readFile(f.hubFile, 'utf8');
  await assert.rejects(f.manager.run(), error => error.code === 'UpstreamRejected' && error.details.stage === 'hub-issuance');
  assert.equal(await fs.readFile(f.hubFile, 'utf8'), oldHub);
  assert.equal((await f.readSa()).refresh_token, 'synthetic-sa-refresh-new');
  const result = await f.manager.run();
  assert.equal(result.status, 'renewed');
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(isRefresh).length, 1);
  assert.equal((await f.readHub()).access_token, jwt(SECOND + 24 * HOUR, 'new'));
  assert.equal((await fs.stat(f.saFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.hubFile)).mode & 0o777, 0o600);
});

test('hub renewal boundary is inclusive at six hours', async t => {
  for (const [remaining, expectedCalls, status] of [[6 * HOUR + 1, 0, 'not_due'], [6 * HOUR, 1, 'renewed']]) {
    await t.test(`${remaining} seconds left`, async t => {
      const f = await fixture(t, { savedHub: hub({ access_token: jwt(SECOND + remaining) }) });
      assert.equal((await f.manager.run()).status, status);
      assert.equal(f.calls.length, expectedCalls);
    });
  }
});

test('Samsung refresh boundary is inclusive at five minutes', async t => {
  for (const [remaining, refreshCount] of [[301, 0], [300, 1]]) {
    await t.test(`${remaining} seconds left`, async t => {
      const f = await fixture(t, { sa: samsung({ accessTokenExpiresAt: SECOND + remaining }),
        request: async request => isRefresh(request) ? refreshedSamsung() : issuedHub() });
      assert.equal((await f.manager.run()).status, 'renewed');
      assert.equal(f.calls.filter(isRefresh).length, refreshCount);
    });
  }
});

test('force-hub preserves a healthy Samsung pair; force-refresh renews both', async t => {
  for (const [options, refreshCount] of [[{ forceHub: true }, 0], [{ forceRefresh: true }, 1]]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, { savedHub: hub({ access_token: jwt(SECOND + 24 * HOUR) }),
        request: async request => isRefresh(request) ? refreshedSamsung() : issuedHub() });
      assert.equal((await f.manager.run(options)).status, 'renewed');
      assert.equal(f.calls.filter(isRefresh).length, refreshCount);
      assert.equal(f.calls.length, refreshCount + 1);
    });
  }
});

test('failed Samsung refresh preserves both credential files and marks reauthentication', async t => {
  const f = await fixture(t, { sa: samsung({ accessTokenExpiresAt: SECOND - 1 }),
    request: async () => ({ status: 400, data: { error: 'invalid_grant', error_description: 'must not escape' } }) });
  const oldSa = await fs.readFile(f.saFile, 'utf8');
  const oldHub = await fs.readFile(f.hubFile, 'utf8');
  await assert.rejects(f.manager.run(), error => {
    assert.equal(error.details.reauthRequired, true);
    assert.equal(JSON.stringify(error.details).includes('must not escape'), false);
    return error.code === 'UpstreamRejected';
  });
  assert.equal(f.calls.length, 1);
  assert.equal(await fs.readFile(f.saFile, 'utf8'), oldSa);
  assert.equal(await fs.readFile(f.hubFile, 'utf8'), oldHub);
});

test('local validation failure preserves old hub token and durable Samsung rotation', async t => {
  for (const [label, probe] of [
    ['TLS failure', async () => { throw new Error('synthetic local TLS mismatch'); }],
    ['HTTP 401', async () => ({ status: 401, certificateVerified: true, alpn: 'h2' })],
  ]) {
    await t.test(label, async t => {
      const f = await fixture(t, { sa: samsung({ accessTokenExpiresAt: SECOND - 1 }),
        request: async request => isRefresh(request) ? refreshedSamsung() : issuedHub(), probe });
      const oldHub = await fs.readFile(f.hubFile, 'utf8');
      const result = await f.manager.run();
      assert.equal(result.status, 'hub_validation_failed');
      assert.equal(result.hubTokenSaved, false);
      assert.equal((await f.readSa()).refresh_token, 'synthetic-sa-refresh-new');
      assert.equal(await fs.readFile(f.hubFile, 'utf8'), oldHub);
      if (label === 'TLS failure') assert.deepEqual(result.localPing, { error: 'LocalPingFailed' });
      else assert.equal(result.localPing.status, 401);
    });
  }
});

test('atomic replacement failure preserves previous JSON and removes incomplete temporary file', async t => {
  const f = await fixture(t);
  const previous = await fs.readFile(f.saFile, 'utf8');
  await assert.rejects(atomicPrivateJson(f.saFile, { refresh_token: 'synthetic-never-committed' }, {
    rename: async () => { const error = new Error('injected rename failure'); error.code = 'EIO'; throw error; },
  }), { code: 'EIO' });
  assert.equal(await fs.readFile(f.saFile, 'utf8'), previous);
  assert.equal((await fs.readdir(f.stateDir)).some(name => name.startsWith('.token-write-')), false);
});

test('unsafe credential permissions and symlinks are rejected before requests', async t => {
  await t.test('world-readable state directory', async t => {
    const f = await fixture(t);
    await fs.chmod(f.stateDir, 0o755);
    await assert.rejects(f.manager.run(), { code: 'UnsafeStateDirectory' });
    assert.equal(f.calls.length, 0);
  });
  await t.test('world-readable Samsung file', async t => {
    const f = await fixture(t);
    await fs.chmod(f.saFile, 0o644);
    await assert.rejects(f.manager.run(), { code: 'UnsafeCredentialFile' });
    assert.equal(f.calls.length, 0);
  });
  await t.test('Samsung file symlink', async t => {
    const f = await fixture(t);
    const target = path.join(f.stateDir, 'private-target.json');
    await fs.rename(f.saFile, target);
    await fs.symlink(target, f.saFile);
    await assert.rejects(f.manager.run(), error => ['ELOOP', 'UnsafeCredentialFile'].includes(error.code));
    assert.equal(f.calls.length, 0);
  });
  await t.test('hub output symlink', async t => {
    const f = await fixture(t);
    const target = path.join(f.stateDir, 'original-hub.json');
    await fs.rename(f.hubFile, target);
    await fs.symlink(target, f.hubFile);
    const oldTarget = await fs.readFile(target, 'utf8');
    await assert.rejects(atomicPrivateJson(f.hubFile, { access_token: 'synthetic-replacement' }), { code: 'UnsafeCredentialFile' });
    assert.equal(await fs.readFile(target, 'utf8'), oldTarget);
  });
});

test('import normalizes both expiry fields and status discloses no tokens', async t => {
  const f = await fixture(t, { sa: null });
  const input = path.join(f.stateDir, 'synthetic-oauth-result.json');
  await fs.writeFile(input, JSON.stringify({ clientId: '6iado3s6jc', authServerUrl: AUTH_ORIGIN,
    apiServerUrl: AUTH_ORIGIN, access_token: 'synthetic-imported-access', refresh_token: 'synthetic-imported-refresh',
    access_token_expires_in: '3600', refresh_token_expires_in: '2592000', receivedAt: new Date(NOW).toISOString() }), { mode: 0o600 });
  await f.manager.importCredentials(input);
  const saved = await f.readSa();
  assert.equal(saved.accessTokenExpiresAt, SECOND + HOUR);
  assert.equal(saved.refreshTokenExpiresAt, SECOND + 30 * 24 * HOUR);
  const status = JSON.stringify(await f.manager.status());
  assert.equal(status.includes('synthetic-imported-access'), false);
  assert.equal(status.includes('synthetic-imported-refresh'), false);
  assert.equal(f.calls.length, 0);
});

test('an uncertain refresh blocks another rotation across restarts', async t => {
  const f = await fixture(t, { sa: samsung({ accessTokenExpiresAt: SECOND - 1 }),
    request: async () => { throw new Error('response lost'); } });
  await assert.rejects(f.manager.run(), { code: 'RefreshOutcomeUnknown' });
  assert.equal(f.calls.length, 1);
  const pending = JSON.parse(await fs.readFile(path.join(f.stateDir, 'samsung-refresh-pending.json'), 'utf8'));
  assert.equal(pending.previousRefreshHash, crypto.createHash('sha256').update('synthetic-sa-refresh-old').digest('hex'));
  assert.equal(JSON.stringify(pending).includes('synthetic-sa-refresh-old'), false);
  await assert.rejects(f.manager.run(), { code: 'RefreshOutcomeUnknown' });
  assert.equal(f.calls.length, 1);
});

test('a saved rotated token clears a pending marker after a crash', async t => {
  const f = await fixture(t);
  const marker = path.join(f.stateDir, 'samsung-refresh-pending.json');
  await fs.writeFile(marker, JSON.stringify({ version: 1,
    previousRefreshHash: crypto.createHash('sha256').update('synthetic-previous-refresh').digest('hex') }), { mode: 0o600 });
  assert.equal((await f.manager.run()).status, 'renewed');
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('malformed refresh responses save any rotated refresh before failing', async t => {
  const f = await fixture(t, { sa: samsung({ accessTokenExpiresAt: SECOND - 1 }),
    request: async () => ({ status: 200, data: { refresh_token: 'synthetic-sa-refresh-new' } }) });
  await assert.rejects(f.manager.run(), { code: 'InvalidRefreshResponse' });
  assert.equal((await f.readSa()).refresh_token, 'synthetic-sa-refresh-new');
  await assert.rejects(fs.access(path.join(f.stateDir, 'samsung-refresh-pending.json')), { code: 'ENOENT' });
});

test('a second process cannot run renewal while the lock is held', async t => {
  if (!['linux', 'darwin'].includes(process.platform)) {
    t.skip('OS lock helper is available on Linux and macOS');
    return;
  }
  const expiry = Math.floor(Date.now() / 1000) + 24 * HOUR;
  const f = await fixture(t, { savedHub: hub({ access_token: jwt(expiry) }) });
  const lock = path.join(f.stateDir, 'hub-token.lock');
  await fs.writeFile(lock, '', { mode: 0o600 });
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : '/usr/bin/flock';
  const lockArgs = process.platform === 'darwin' ? ['-k', lock] : [lock];
  const holder = spawn(command, [...lockArgs, process.execPath, '-e',
    "process.stdout.write('ready'); process.stdin.on('data', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { if (!holder.stdin.writableEnded) holder.stdin.end('release'); });
  await once(holder.stdout, 'data');
  const worker = path.resolve('lib/hub-token.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, [worker, 'run', f.hubFile]);
  assert.deepEqual(JSON.parse(stdout), { status: 'busy' });
  holder.stdin.end('release');
  await once(holder, 'close');
  const unlocked = await promisify(execFile)(process.execPath, [worker, 'run', f.hubFile]);
  assert.equal(JSON.parse(unlocked.stdout).status, 'not_due');
});
