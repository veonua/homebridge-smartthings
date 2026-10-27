#!/usr/bin/env node
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import crypto, { X509Certificate } from 'node:crypto';
import http2 from 'node:http2';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const SCRIPT = fileURLToPath(import.meta.url);
const CLIENT_ID = '6iado3s6jc';
const AUTH_ORIGIN = 'https://eu-auth2.samsungosp.com';
const HUB_MARGIN = 6 * 3600;
const SA_MARGIN = 5 * 60;
const MAX_BYTES = 1024 * 1024;

export class SafeError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
function ensure(condition, code) { if (!condition) throw new SafeError(code); }
function seconds(value) {
  const parsed = Number(value);
  ensure(Number.isSafeInteger(parsed) && parsed > 0, 'InvalidTokenLifetime');
  return parsed;
}
async function secureDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const info = await fs.lstat(directory);
  ensure(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o077) === 0, 'UnsafeStateDirectory');
}
async function existingPrivateFile(file) {
  try {
    const info = await fs.lstat(file);
    ensure(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
      (info.mode & 0o077) === 0, 'UnsafeCredentialFile');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
async function privateJson(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    ensure(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 &&
      info.size <= MAX_BYTES, 'UnsafeCredentialFile');
    let value;
    try { value = JSON.parse(await handle.readFile('utf8')); } catch { throw new SafeError('InvalidPrivateJson'); }
    ensure(value && typeof value === 'object' && !Array.isArray(value), 'InvalidPrivateJson');
    return value;
  } finally { await handle.close(); }
}
export async function atomicPrivateJson(file, value, { rename = fs.rename } = {}) {
  const directory = path.dirname(file);
  await secureDirectory(directory);
  await existingPrivateFile(file);
  const temporary = path.join(directory, `.token-write-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, file);
    const parent = await fs.open(directory, constants.O_RDONLY);
    try { await parent.sync(); }
    catch (e) { if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
    finally { await parent.close(); }
  } finally {
    if (handle) await handle.close();
    try { await fs.unlink(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function validateSamsung(value) {
  ensure(value.clientId === CLIENT_ID && value.authServerUrl === AUTH_ORIGIN &&
    value.apiServerUrl === AUTH_ORIGIN, 'UnexpectedSamsungIdentity');
  ensure(typeof value.access_token === 'string' && value.access_token.length > 0 &&
    typeof value.refresh_token === 'string' && value.refresh_token.length > 0, 'MissingRenewalCredentials');
  ensure(Number.isSafeInteger(value.accessTokenExpiresAt) && Number.isSafeInteger(value.refreshTokenExpiresAt),
    'InvalidStoredExpiry');
}
function fromInitialResponse(value) {
  const received = Math.floor(Date.parse(value.receivedAt) / 1000);
  ensure(Number.isSafeInteger(received), 'InvalidCredentialTimestamp');
  const normalized = { version: 1, clientId: value.clientId, authServerUrl: value.authServerUrl,
    apiServerUrl: value.apiServerUrl, access_token: value.access_token, refresh_token: value.refresh_token,
    receivedAt: value.receivedAt,
    accessTokenExpiresAt: received + seconds(value.access_token_expires_in ?? value.expires_in),
    refreshTokenExpiresAt: received + seconds(value.refresh_token_expires_in) };
  validateSamsung(normalized);
  return normalized;
}
export function hubClaims(token, hubId) {
  let header, claims;
  try {
    const parts = token.split('.');
    ensure(parts.length === 3, 'InvalidHubJwt');
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new SafeError('InvalidHubJwt'); }
  ensure(header.alg === 'RS256' && claims.device_id === hubId && Number.isSafeInteger(claims.exp),
    'UnexpectedHubJwt');
  return { alg: header.alg, deviceId: claims.device_id, exp: claims.exp,
    expiresAt: new Date(claims.exp * 1000).toISOString() };
}
function certificatePem(value) {
  ensure(typeof value === 'string' && value.length > 0, 'MissingHubCertificate');
  if (value.includes('-----BEGIN CERTIFICATE-----')) return value;
  const base64 = value.replace(/\s/g, '');
  ensure(/^[A-Za-z0-9+/=]+$/.test(base64), 'InvalidHubCertificate');
  return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
async function defaultRequest({ url, method, headers, body }) {
  ensure(url === `${AUTH_ORIGIN}/auth/oauth2/token` ||
    /^https:\/\/client\.smartthings\.com\/hubdevices\/[0-9a-f-]{36}\/hedge\/auth$/i.test(url), 'UnexpectedRequestTarget');
  let response;
  try {
    response = await fetch(url, { method, body, headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch { throw new SafeError('NetworkRequestFailed'); }
  const chunks = []; let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new SafeError('ResponseTooLarge'); }
      chunks.push(Buffer.from(value));
    }
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
  return { status: response.status, data };
}
function httpFailure(stage, response) {
  const raw = response.data?.error?.code ?? response.data?.error ?? response.data?.errorCode ?? response.data?.code;
  const known = ['invalid_grant', 'invalid_token', 'AUT_1803', 'UnauthorizedError', 'ForbiddenError'];
  const serverCode = known.includes(raw) ? raw : 'UnclassifiedResponse';
  return new SafeError('UpstreamRejected', { stage, httpStatus: response.status, serverCode,
    reauthRequired: stage === 'samsung-refresh' && (response.status === 401 ||
      ['invalid_grant', 'AUT_1803'].includes(serverCode)) });
}
async function localPing(accessToken, pem, hubId, hubHost, hubPort) {
  const TLS_NAME = `svc-hla-tcp.hub-${hubId}.smartthings`;
  const expected = new X509Certificate(pem);
  ensure(expected.checkHost(TLS_NAME), 'UnexpectedCertificateHost');
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${isIP(hubHost) === 6 ? `[${hubHost}]` : hubHost}:${hubPort}`, { ca: pem, servername: TLS_NAME,
      rejectUnauthorized: true });
    let done = false;
    function finish(error, value) {
      if (done) return; done = true; session.destroy();
      if (error) reject(new SafeError('LocalPingFailed')); else resolve(value);
    }
    session.setTimeout(15000, () => finish(new Error()));
    session.on('error', e => finish(e));
    session.on('connect', () => {
      const socket = session.socket;
      if (!socket.authorized || socket.getPeerCertificate().fingerprint256 !== expected.fingerprint256 ||
          socket.alpnProtocol !== 'h2') { finish(new Error()); return; }
      const result = { certificateVerified: true, certificateFingerprint256: expected.fingerprint256,
        tls: socket.getProtocol(), alpn: socket.alpnProtocol, method: 'GET', path: '/util/ping' };
      const req = session.request({ ':method': 'GET', ':path': '/util/ping',
        authorization: `Bearer ${accessToken}`, 'x-hub-identifier': hubId,
        accept: 'application/vnd.smartthings+json;v=1' });
      let bytes = 0;
      req.on('response', headers => { result.status = headers[':status']; });
      req.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) finish(new Error()); });
      req.on('error', e => finish(e));
      req.on('end', () => finish(null, result)); req.end();
    });
  });
}
export function createManager({ stateDir, hubFile = path.join(stateDir, 'hub-local-token.json'), hubId, hubHost, hubPort = 8766,
  request = defaultRequest, probe = localPing, now = () => Date.now() }) {
  ensure(typeof hubId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hubId), 'InvalidHubId');
  ensure(typeof hubHost === 'string' && (isIP(hubHost) || /^[a-z0-9.-]+$/i.test(hubHost)), 'InvalidHubHost');
  ensure(Number.isInteger(hubPort) && hubPort > 0 && hubPort <= 65535, 'InvalidHubPort');
  const TLS_NAME = `svc-hla-tcp.hub-${hubId}.smartthings`;
  const HUB_ENDPOINT = `https://client.smartthings.com/hubdevices/${hubId}/hedge/auth`;
  const saFile = path.join(stateDir, 'samsung-account-token.json');
  const refreshMarker = path.join(stateDir, 'samsung-refresh-pending.json');
  async function clearRefreshMarker() {
    await fs.unlink(refreshMarker);
    const directory = await fs.open(stateDir, constants.O_RDONLY);
    try { await directory.sync(); }
    catch (e) { if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
    finally { await directory.close(); }
  }
  async function loadHub() {
    try {
      const value = await privateJson(hubFile);
      ensure(value.hubId === hubId && value.hubHost === hubHost && (value.hubPort ?? 8766) === hubPort, 'UnexpectedStoredHub');
      return { value, claims: hubClaims(value.access_token, hubId) };
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function status() {
    await secureDirectory(stateDir);
    let sa;
    try { sa = await privateJson(saFile); validateSamsung(sa); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const hub = await loadHub(); const current = Math.floor(now() / 1000);
    return { status: 'status', renewalCredentialsPresent: !!sa, hubTokenPresent: !!hub,
      hubExpiresAt: hub?.claims.expiresAt, hubRenewalDue: !hub || hub.claims.exp - current <= HUB_MARGIN,
      samsungAccessExpiresAt: sa ? new Date(sa.accessTokenExpiresAt * 1000).toISOString() : undefined,
      samsungRefreshExpiresAt: sa ? new Date(sa.refreshTokenExpiresAt * 1000).toISOString() : undefined };
  }
  async function importCredentials(file) {
    await secureDirectory(stateDir);
    ensure(path.resolve(file) !== path.resolve(saFile), 'SourceIsDestination');
    const value = fromInitialResponse(await privateJson(file));
    ensure(value.refreshTokenExpiresAt > Math.floor(now() / 1000), 'RefreshTokenExpired');
    await atomicPrivateJson(saFile, value);
    return { ...(await status()), status: 'credentials_saved', privateFile: saFile };
  }
  async function run({ forceRefresh = false, forceHub = false } = {}) {
    await secureDirectory(stateDir);
    let pending;
    try { pending = await privateJson(refreshMarker); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (pending) {
      const saved = await privateJson(saFile);
      validateSamsung(saved);
      const savedHash = crypto.createHash('sha256').update(saved.refresh_token).digest('hex');
      ensure(typeof pending.previousRefreshHash === 'string' && /^[0-9a-f]{64}$/.test(pending.previousRefreshHash),
        'RefreshOutcomeUnknown');
      // A changed refresh token proves that the new pair was durably saved.
      // An unchanged token cannot distinguish a lost response from no rotation.
      ensure(savedHash !== pending.previousRefreshHash, 'RefreshOutcomeUnknown');
      await clearRefreshMarker();
    }
    const current = Math.floor(now() / 1000);
    const hub = await loadHub();
    if (!forceRefresh && !forceHub && hub && hub.claims.exp - current > HUB_MARGIN) {
      return { status: 'not_due', hubExpiresAt: hub.claims.expiresAt, networkRequests: 0 };
    }
    let sa = await privateJson(saFile); validateSamsung(sa);
    let refresh;
    if (forceRefresh || sa.accessTokenExpiresAt - current <= SA_MARGIN) {
      ensure(sa.refreshTokenExpiresAt > current, 'RefreshTokenExpired');
      // Persist before issuing a potentially rotating refresh. If the process
      // crashes or the response is lost, never retry an uncertain old token.
      await atomicPrivateJson(refreshMarker, { version: 1,
        previousRefreshHash: crypto.createHash('sha256').update(sa.refresh_token).digest('hex') });
      let response;
      try {
        response = await request({ url: `${AUTH_ORIGIN}/auth/oauth2/token`, method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
            'x-osp-appId': CLIENT_ID, 'User-Agent': 'local-st-desktop/1.0' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sa.refresh_token,
            client_id: CLIENT_ID }).toString() });
      } catch { throw new SafeError('RefreshOutcomeUnknown'); }
      if (response.status >= 500) throw new SafeError('RefreshOutcomeUnknown');
      if (response.status < 200 || response.status >= 300) {
        const failure = httpFailure('samsung-refresh', response);
        if (failure.details.reauthRequired) await clearRefreshMarker();
        else throw new SafeError('RefreshOutcomeUnknown');
        throw failure;
      }
      const data = response.data;
      const refreshedAt = Math.floor(now() / 1000);
      const rotated = typeof data?.refresh_token === 'string' && data.refresh_token.length > 0;
      let next;
      try {
        ensure(typeof data?.access_token === 'string' && data.access_token.length > 0, 'MissingRefreshedAccessToken');
        next = { ...sa, access_token: data.access_token,
          accessTokenExpiresAt: refreshedAt + seconds(data.access_token_expires_in ?? data.expires_in),
          receivedAt: new Date(refreshedAt * 1000).toISOString() };
        if (rotated) {
          next.refresh_token = data.refresh_token;
          next.refreshTokenExpiresAt = data.refresh_token_expires_in === undefined ? sa.refreshTokenExpiresAt :
            refreshedAt + seconds(data.refresh_token_expires_in);
        }
        validateSamsung(next);
      } catch {
        // A malformed response may still contain a rotated refresh token. Keep it
        // before reporting failure; the prior access token is treated as expired.
        if (rotated) {
          try { await atomicPrivateJson(saFile, { ...sa, refresh_token: data.refresh_token, accessTokenExpiresAt: refreshedAt - 1 }); }
          catch { throw new SafeError('SamsungRotationSaveFailed'); }
          await clearRefreshMarker();
          throw new SafeError('InvalidRefreshResponse');
        }
        throw new SafeError('RefreshOutcomeUnknown');
      }
      // Commit rotation before the separate hub request. A hub failure must not lose renewal credentials.
      try { await atomicPrivateJson(saFile, next); }
      catch { throw new SafeError('SamsungRotationSaveFailed'); }
      await clearRefreshMarker();
      refresh = { httpStatus: response.status, refreshTokenReturned: rotated,
        refreshTokenChanged: next.refresh_token !== sa.refresh_token,
        accessExpiresAt: new Date(next.accessTokenExpiresAt * 1000).toISOString(),
        refreshExpiresAt: new Date(next.refreshTokenExpiresAt * 1000).toISOString() };
      sa = next;
    }
    const response = await request({ url: HUB_ENDPOINT, method: 'POST',
      headers: { Authorization: `Bearer ${sa.access_token}`, Accept: 'application/vnd.smartthings+json;v=1' } });
    if (response.status !== 200) throw httpFailure('hub-issuance', response);
    ensure(typeof response.data?.access_token === 'string', 'MissingHubJwt');
    const claims = hubClaims(response.data.access_token, hubId);
    ensure(claims.exp > Math.floor(now() / 1000), 'IssuedHubJwtExpired');
    const pem = certificatePem(response.data.public_certificate);
    const certificate = new X509Certificate(pem);
    ensure(certificate.checkHost(TLS_NAME), 'UnexpectedCertificateHost');
    let ping;
    try { ping = await probe(response.data.access_token, pem, hubId, hubHost, hubPort); }
    catch { ping = { error: 'LocalPingFailed' }; }
    if (ping.status === 200) {
      await atomicPrivateJson(hubFile, { hubId, hubHost, ...(hubPort !== 8766 ? { hubPort } : {}),
        issuedAt: new Date(now()).toISOString(), access_token: response.data.access_token, public_certificate: pem });
    }
    return { status: ping.status === 200 ? 'renewed' : 'hub_validation_failed', samsungRefresh: refresh,
      hubIssuanceHttpStatus: response.status, hubToken: claims, privateHubFile: hubFile,
      hubTokenSaved: ping.status === 200, localPing: ping };
  }
  return { importCredentials, status, run };
}

async function cli(argv) {
  const locked = argv[0] === '--locked';
  const args = locked ? argv.slice(1) : argv;
  ensure(args.length === 2 && args[0] === 'run' && path.isAbsolute(args[1]), 'InvalidArguments');
  const hubFile = args[1];
  const stateDir = path.dirname(hubFile);
  await secureDirectory(stateDir);
  if (!locked) {
    const lock = path.join(stateDir, 'hub-token.lock');
    try { const f = await fs.open(lock, 'wx', 0o600); await f.close(); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    await existingPrivateFile(lock);
    ensure(['linux', 'darwin'].includes(process.platform), 'UnsupportedLockPlatform');
    const lockingTool = process.platform === 'darwin' ? '/usr/bin/lockf' : '/usr/bin/flock';
    const lockArgs = process.platform === 'darwin' ? ['-s', '-k', '-t', '0', lock] : ['-n', '-E', '75', lock];
    const result = spawnSync(lockingTool, [...lockArgs, process.execPath, SCRIPT, '--locked', ...args], { stdio: 'inherit' });
    if (result.status === 75) { process.stdout.write('{"status":"busy"}\n'); return; }
    ensure(!result.error && result.status !== null, 'LockRunnerFailed');
    process.exitCode = result.status; return;
  }
  const current = await privateJson(hubFile);
  const manager = createManager({ stateDir, hubFile, hubId: current.hubId, hubHost: current.hubHost,
    hubPort: current.hubPort ?? 8766 });
  const result = await manager.run();
  // Only expose an allowlist of metadata; never print credentials or server response bodies.
  process.stdout.write(`${JSON.stringify({ status: result.status, hubExpiresAt: result.hubExpiresAt ?? result.hubToken?.expiresAt })}\n`);
  if (result.status === 'hub_validation_failed') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  process.umask(0o077);
  try { await cli(process.argv.slice(2)); }
  catch (e) {
    const result = e instanceof SafeError ? { status: 'failed', code: e.code, ...e.details } :
      { status: 'failed', code: ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(e.code) ? e.code : 'UnexpectedFailure' };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = 1;
  }
}
