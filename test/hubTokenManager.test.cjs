const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HubTokenManager } = require('../dist/hubTokenManager');

test('manager runs the locked worker without refreshing a valid hub token', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-token-manager-test-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = '11111111-2222-3333-4444-555555555555';
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${encode({ alg: 'RS256' })}.${encode({ device_id: id, exp: Math.floor(Date.now() / 1000) + 86400 })}.fake`;
  const tokenFile = path.join(dir, 'hub-local-token.json');
  await fs.writeFile(tokenFile, JSON.stringify({ hubId: id, hubHost: '127.0.0.1', access_token: jwt }), { mode: 0o600 });
  const manager = new HubTokenManager(tokenFile);
  const first = manager.runOnce();
  assert.equal(first, manager.runOnce(), 'concurrent callers share the same worker');
  const result = await first;
  assert.equal(result.status, 'not_due');
  assert.ok(result.hubExpiresAt);
  assert.equal(JSON.stringify(result).includes(jwt), false);
  const callback = await new Promise(resolve => manager.start(resolve));
  assert.equal(callback.status, 'not_due');
  manager.stop();
});

test('manager rejects relative paths without starting a worker', async () => {
  const manager = new HubTokenManager('relative.json');
  assert.deepEqual(await manager.runOnce(), { status: 'failed', code: 'InvalidTokenFilePath' });
});
