const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http2 = require('node:http2');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalHubEvents, SseParser } = require('../dist/localHubEvents');

const hubId = '11111111-2222-3333-4444-555555555555';
const location = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const device = '99999999-2222-3333-4444-555555555555';
const tlsName = `svc-hla-tcp.hub-${hubId}.smartthings`;
function jwt(marker) {
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.${marker}`;
}
function cert(dir, prefix) {
  const key = path.join(dir, `${prefix}.key`), pem = path.join(dir, `${prefix}.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key,
    '-out', pem, '-subj', '/CN=test-authority', '-addext', `subjectAltName=DNS:${tlsName}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,cRLSign'],
  { stdio: 'ignore' });
  return { key, pem };
}
async function signedCert(dir, authority) {
  const key = path.join(dir, 'leaf.key'), csr = path.join(dir, 'leaf.csr'), pem = path.join(dir, 'leaf.pem');
  const extensions = path.join(dir, 'leaf.cnf');
  await fs.writeFile(extensions, `subjectAltName=DNS:${tlsName}\nbasicConstraints=CA:FALSE\n` +
    'keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr,
    '-subj', `/CN=${tlsName}`], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', authority.pem, '-CAkey', authority.key,
    '-CAcreateserial', '-days', '1', '-extfile', extensions, '-out', pem], { stdio: 'ignore' });
  return { key, pem };
}
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${label}`);
}
async function fixture(t, mode = 'normal') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-sse-test-'));
  await fs.chmod(dir, 0o700);
  const trusted = cert(dir, 'trusted');
  const wrong = cert(dir, 'wrong');
  const pem = await fs.readFile(trusted.pem, 'utf8');
  const serverCert = mode === 'fingerprint' ? await signedCert(dir, trusted) : trusted;
  const hub = { posts: 0, puts: 0, lookups: 0, deletes: 0, streams: 0, tokens: [], subscriptions: new Map() };
  const server = http2.createSecureServer({ key: await fs.readFile(serverCert.key), cert: await fs.readFile(serverCert.pem) });
  server.on('sessionError', () => {});
  server.on('tlsClientError', () => {});
  if (mode === 'idle-timeout') {
    server.on('session', session => {
      let active = 0, idleSince = Date.now();
      session.on('stream', stream => {
        active++;
        stream.on('close', () => { active--; idleSince = Date.now(); });
      });
      const timer = setInterval(() => {
        if (active === 0 && Date.now() - idleSince >= 70) session.destroy();
      }, 10);
      session.once('close', () => clearInterval(timer));
    });
  }
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    const method = headers[':method'], url = headers[':path'];
    hub.tokens.push(headers.authorization);
    const json = (status, data) => { stream.respond({ ':status': status, 'content-type': 'application/json' }); stream.end(JSON.stringify(data)); };
    if (method === 'POST' && url === '/subscriptions') {
      hub.posts++;
      let content = '';
      stream.on('data', chunk => { content += chunk; });
      stream.on('end', () => {
        const body = JSON.parse(content);
        const id = crypto.randomUUID();
        const sub = { ...body, subscriptionId: id,
          registrationUrl: mode === 'foreign' ? 'https://example.invalid/stolen' : `/push/${id}` };
        hub.subscriptions.set(id, sub);
        if (hub.dropReplacement && hub.posts > 1) { stream.destroy(); return; }
        if (mode === 'dropped') { stream.destroy(); return; }
        if (mode === 'status-400') { hub.subscriptions.delete(id); json(400, { error: 'private details' }); return; }
        if (mode === 'mismatch-create') { json(200, { ...sub, name: 'different name' }); return; }
        if (hub.delayReplacement && hub.posts > 1) {
          hub.releaseReplacement = () => json(200, sub);
        } else {
          json(200, sub);
        }
      });
    } else if (method === 'PUT' && url.startsWith('/subscriptions/')) {
      hub.puts++;
      let content = '';
      stream.on('data', chunk => { content += chunk; });
      stream.on('end', () => {
        const sub = hub.subscriptions.get(url.split('/').pop());
        if (!sub) { json(404, {}); return; }
        if (mode === 'filter-failed') { json(500, {}); return; }
        sub.subscriptionFilters = JSON.parse(content).subscriptionFilters;
        json(200, sub);
      });
    } else if (method === 'GET' && url.startsWith('/subscriptions/')) {
      hub.lookups++;
      const sub = hub.subscriptions.get(url.split('/').pop());
      json(sub ? 200 : 404, sub || {});
    } else if (method === 'GET' && url === '/devices') {
      json(200, { items: [] });
    } else if (method === 'DELETE' && url.startsWith('/subscriptions/')) {
      hub.deletes++;
      if (mode === 'deletion-denied') { json(500, {}); return; }
      hub.subscriptions.delete(url.split('/').pop());
      json(200, {});
    } else if (method === 'GET' && url.startsWith('/push/')) {
      hub.streams++;
      hub.activeStream = stream;
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      const payload = { eventType: 'DEVICE_EVENT', eventTime: 1793047774610,
        deviceEvent: { deviceId: device, locationId: location, componentId: 'main', capability: 'switch',
          attribute: 'switch', value: true, eventId: 'event-id', unit: null, data: { origin: 'test' } } };
      stream.write('event: CONTROL_EVENT\ndata: welcome\n\n');
      const frame = Buffer.from(`event: DEVICE_EVENT\ndata: ${JSON.stringify(payload)}\n\n`);
      stream.write(frame.subarray(0, 15));
      stream.write(frame.subarray(15));
    } else { json(404, {}); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tokenFile = path.join(dir, 'hub-local-token.json');
  const subscriptionFile = path.join(dir, 'homebridge-events-subscription.json');
  const credentials = { hubId, hubHost: '127.0.0.1', hubPort: server.address().port,
    access_token: jwt('first'), public_certificate: mode === 'wrong-cert' ? await fs.readFile(wrong.pem, 'utf8') : pem };
  await fs.writeFile(tokenFile, JSON.stringify(credentials), { mode: 0o600 });
  const observed = { connected: 0, disconnected: 0, events: [], errors: [] };
  const client = new LocalHubEvents({ tokenFile, subscriptionFile, locationIds: [location],
    onConnected: () => { observed.connected++; }, onDisconnected: () => { observed.disconnected++; },
    onDeviceEvent: event => { observed.events.push(event); }, onError: code => { observed.errors.push(code); } });
  t.after(async () => { await client.stop(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  return { hub, client, observed, tokenFile, subscriptionFile, credentials };
}

test('SSE parser handles split UTF-8, CRLF, comments and multiline data', () => {
  const received = [];
  const parser = new SseParser(message => received.push(message));
  const frame = Buffer.from(': comment\r\nevent: DEVICE_EVENT\r\nid: 12\r\ndata: hello\r\ndata: ø\r\n\r\n');
  for (const byte of frame) parser.push(Buffer.from([byte]));
  assert.deepEqual(received, [{ event: 'DEVICE_EVENT', id: '12', data: 'hello\nø' }]);
});

test('SSE parser limits the total size of multiline data', () => {
  const parser = new SseParser(() => {});
  assert.throws(() => parser.push(Buffer.from(`data: ${'x'.repeat(1024 * 1024)}\n`)), /EventTooLarge/);
});

test('unexpected stream failures report stage and allowlisted system code without error text', async t => {
  const f = await fixture(t);
  f.client.receive = async () => {
    throw Object.assign(new Error('private authorization and device data'), { code: 'ERR_HTTP2_INVALID_SESSION' });
  };
  f.client.start();
  await until(() => f.observed.errors.length, 'safe stream error');
  assert.equal(f.observed.errors[0], 'LocalEventsFailed_stream_ERR_HTTP2_INVALID_SESSION');
  assert.equal(JSON.stringify(f.observed.errors).includes('private'), false);
});

test('unexpected subscription failures report error type without arbitrary message or code', async t => {
  const f = await fixture(t);
  f.client.subscription = async () => {
    throw Object.assign(new TypeError('secret-value'), { code: 'secret-code' });
  };
  f.client.start();
  await until(() => f.observed.errors.length, 'safe subscription error');
  assert.equal(f.observed.errors[0], 'LocalEventsFailed_subscription_TypeError');
  assert.equal(JSON.stringify(f.observed.errors).includes('secret'), false);
});

test('immediate stop does not start a connection or create a subscription', async t => {
  const f = await fixture(t);
  f.client.start();
  await f.client.stop();
  assert.equal(f.hub.tokens.length, 0);
  assert.equal(f.hub.posts, 0);
});

test('creates once, streams typed events, reloads token and reuses owned subscription', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.events.length === 1, 'initial event');
  assert.equal(f.observed.connected, 1);
  assert.equal(f.hub.posts, 1);
  assert.ok(Number.isSafeInteger(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).lastRotationAt));
  assert.equal(f.observed.events[0].deviceEvent.value, true);
  assert.equal(f.observed.events[0].deviceEvent.eventId, 'event-id');
  assert.deepEqual(f.observed.events[0].deviceEvent.data, { origin: 'test' });
  f.credentials.access_token = jwt('second');
  await fs.writeFile(f.tokenFile, JSON.stringify(f.credentials), { mode: 0o600 });
  f.client.reconnect();
  await until(() => f.observed.events.length === 2, 'reconnected event');
  assert.equal(f.hub.posts, 1);
  assert.equal(f.hub.lookups, 1);
  assert.ok(f.hub.tokens.includes(`Bearer ${f.credentials.access_token}`));
  await f.client.stop();
  assert.equal(f.observed.disconnected, 2);
  f.client.start();
  await until(() => f.observed.events.length === 3, 'restart event');
  assert.equal(f.hub.posts, 1);
  await f.client.stop();
  await f.client.removeSubscription();
  assert.equal(f.hub.deletes, 1);
  assert.equal(f.hub.subscriptions.size, 0);
  await assert.rejects(fs.access(f.subscriptionFile), { code: 'ENOENT' });
});

test('GET 404 recreates an old missing owned subscription', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.connected === 1, 'first connection');
  await f.client.stop();
  const old = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  old.lastRotationAt = Date.now() - 5 * 60 * 60 * 1000;
  await fs.writeFile(f.subscriptionFile, JSON.stringify(old), { mode: 0o600 });
  const firstCreation = old.lastRotationAt;
  f.hub.subscriptions.clear();
  f.client.start();
  await until(() => f.observed.connected === 2, 'connection after 404');
  assert.equal(f.hub.posts, 2);
  assert.equal(f.hub.deletes, 0);
  const secondCreation = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).lastRotationAt;
  assert.ok(Number.isSafeInteger(firstCreation) && secondCreation >= firstCreation);
});

test('a broken stream reconnects using the saved subscription', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.connected === 1, 'first connection');
  f.hub.activeStream.close();
  await until(() => f.observed.connected === 2, 'automatic reconnect');
  assert.equal(f.hub.posts, 1);
  assert.ok(f.hub.lookups >= 1);
  assert.ok(f.observed.disconnected >= 1);
});

test('creates a replacement at 3 hours 55 minutes while retaining the active stream', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.connected === 1, 'first connection');
  await f.client.stop();
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  state.lastRotationAt = Date.now() - 235 * 60 * 1000 + 1000;
  await fs.writeFile(f.subscriptionFile, JSON.stringify(state), { mode: 0o600 });
  f.hub.delayReplacement = true;
  f.client.start();
  await until(() => f.observed.connected === 2, 'connection before rotation');
  assert.equal(f.client.scheduledRotation.at, state.lastRotationAt + 235 * 60 * 1000);
  const originalStream = f.hub.activeStream;
  await until(() => typeof f.hub.releaseReplacement === 'function', 'replacement request');
  assert.equal(originalStream.closed, false, 'old event stream stays open while POST is pending');
  f.hub.releaseReplacement();
  await until(() => f.observed.connected === 3, 'connection after rotation');
  assert.equal(f.hub.posts, 2);
  assert.equal(f.hub.deletes, 0);
  const updated = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.notEqual(updated.subscriptionId, state.subscriptionId);
});

test('an uncertain proactive POST keeps the old stream and prevents duplicate creation', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.connected === 1, 'first connection');
  await f.client.stop();
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  state.lastRotationAt = Date.now() - 235 * 60 * 1000 + 1000;
  await fs.writeFile(f.subscriptionFile, JSON.stringify(state), { mode: 0o600 });
  f.hub.dropReplacement = true;
  f.client.start();
  await until(() => f.observed.connected === 2, 'connection before rotation');
  const originalStream = f.hub.activeStream;
  await until(() => f.observed.errors.includes('SubscriptionCreationUnknown'), 'uncertain replacement');
  assert.equal(originalStream.closed, false);
  assert.equal(f.hub.posts, 2);
  assert.equal(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).stage, 'pending');
  f.hub.activeStream.close();
  await until(() => f.client.stopped, 'stop after pending marker');
  assert.equal(f.hub.posts, 2);
});

test('slow state locking does not leave an HTTP2 session idle', async t => {
  const f = await fixture(t, 'idle-timeout');
  const acquire = f.client.acquireStateLock.bind(f.client);
  f.client.acquireStateLock = async () => {
    const release = await acquire();
    await new Promise(resolve => setTimeout(resolve, 250));
    return async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      await release();
    };
  };
  f.client.start();
  await until(() => f.observed.events.length === 1, 'idle-safe connection');
  assert.equal(f.hub.posts, 1);
  assert.deepEqual(f.observed.errors, []);
});

test('a closed session before subscription lookup reconnects automatically', async t => {
  const f = await fixture(t);
  const id = crypto.randomUUID(), name = 'Existing subscription';
  f.hub.subscriptions.set(id, { subscriptionId: id, name, registrationUrl: `/push/${id}`,
    subscriptionFilters: [{ type: 'LOCATIONIDS', value: [location] }] });
  await fs.writeFile(f.subscriptionFile, JSON.stringify({ version: 1, hubId, locationIds: [location],
    name, stage: 'ready', ownership: 'external', subscriptionId: id }), { mode: 0o600 });
  const subscription = f.client.subscription.bind(f.client);
  let first = true;
  f.client.subscription = async (session, credentials) => {
    if (first) {
      first = false;
      session.destroy();
      await new Promise(resolve => setImmediate(resolve));
    }
    return subscription(session, credentials);
  };
  f.client.start();
  await until(() => f.observed.events.length === 1, 'closed session recovered');
  assert.equal(f.hub.posts, 0);
  assert.deepEqual(f.observed.errors, []);
});

test('a closed session before POST clears only the unsent marker and retries once', async t => {
  const f = await fixture(t);
  const json = f.client.json.bind(f.client);
  let first = true;
  f.client.json = async (session, credentials, method, endpoint, body) => {
    if (first && method === 'POST') {
      first = false;
      session.destroy();
      await new Promise(resolve => setImmediate(resolve));
    }
    return json(session, credentials, method, endpoint, body);
  };
  f.client.start();
  await until(() => f.observed.events.length === 1, 'unsent POST recovered');
  assert.equal(f.hub.posts, 1);
  assert.equal(f.hub.subscriptions.size, 1);
  assert.equal(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).stage, 'ready');
  assert.deepEqual(f.observed.errors, []);
});

test('concurrent clients share one created subscription', async t => {
  const f = await fixture(t);
  let secondConnected = false;
  const second = new LocalHubEvents({ tokenFile: f.tokenFile, subscriptionFile: f.subscriptionFile, locationIds: [location],
    onConnected: () => { secondConnected = true; }, onDisconnected: () => {}, onDeviceEvent: () => {}, onError: () => {} });
  t.after(() => second.stop());
  f.client.start();
  second.start();
  await until(() => f.observed.connected && secondConnected, 'both clients connected');
  assert.equal(f.hub.posts, 1);
  await second.stop();
});

test('a verified owned subscription updates its filter when locations change', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.connected === 1, 'initial connection');
  await f.client.stop();
  const old = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  const changedLocation = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  let connected = false;
  const errors = [];
  const next = new LocalHubEvents({ tokenFile: f.tokenFile, subscriptionFile: f.subscriptionFile,
    locationIds: [location, changedLocation], onConnected: () => { connected = true; }, onDisconnected: () => {},
    onDeviceEvent: () => {}, onError: code => { errors.push(code); } });
  t.after(() => next.stop());
  next.start();
  await until(() => connected || errors.length, 'connection with changed locations');
  assert.deepEqual(errors, []);
  assert.equal(connected, true);
  assert.equal(f.hub.posts, 1);
  assert.equal(f.hub.puts, 1);
  assert.equal(f.hub.deletes, 0);
  const current = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.deepEqual(current.locationIds.sort(), [location, changedLocation].sort());
  assert.equal(current.subscriptionId, old.subscriptionId);
  assert.equal(f.hub.subscriptions.size, 1);
  await next.stop();
});

test('a failed filter update does not create another subscription', async t => {
  const f = await fixture(t, 'filter-failed');
  f.client.start();
  await until(() => f.observed.connected === 1, 'initial connection');
  await f.client.stop();
  const old = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  const errors = [];
  const next = new LocalHubEvents({ tokenFile: f.tokenFile, subscriptionFile: f.subscriptionFile,
    locationIds: [location, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'], onConnected: () => {}, onDisconnected: () => {},
    onDeviceEvent: () => {}, onError: code => errors.push(code) });
  t.after(() => next.stop());
  next.start();
  await until(() => errors.includes('SubscriptionFilterUpdateFailed'), 'failed filter update');
  assert.equal(f.hub.posts, 1);
  assert.equal(f.hub.subscriptions.size, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')), old);
});

test('a changed external subscription is never replaced or deleted automatically', async t => {
  const f = await fixture(t);
  const id = crypto.randomUUID();
  const name = 'External logger';
  await fs.writeFile(f.subscriptionFile, JSON.stringify({ version: 1, hubId, locationIds: [location],
    name, ownership: 'external', stage: 'ready', subscriptionId: id }), { mode: 0o600 });
  f.hub.subscriptions.set(id, { subscriptionId: id, name, registrationUrl: `/push/${id}`,
    subscriptionFilters: [{ type: 'LOCATIONIDS', value: [location] }] });
  const errors = [];
  const next = new LocalHubEvents({ tokenFile: f.tokenFile, subscriptionFile: f.subscriptionFile,
    locationIds: [location, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'], onConnected: () => {}, onDisconnected: () => {},
    onDeviceEvent: () => {}, onError: code => { errors.push(code); } });
  t.after(() => next.stop());
  next.start();
  await until(() => errors.length, 'external filter changed');
  assert.deepEqual(errors, ['ExternalSubscriptionFilterChanged']);
  assert.equal(f.hub.posts, 0);
  assert.equal(f.hub.deletes, 0);
  assert.equal(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).subscriptionId, id);
  await next.stop();
});

test('subscription with mismatched owner or filter is never removed', async t => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.observed.connected === 1, 'connection');
  await f.client.stop();
  const subscription = f.hub.subscriptions.values().next().value;
  subscription.name = 'someone else';
  await assert.rejects(f.client.removeSubscription(), /SubscriptionMismatch/);
  assert.equal(f.hub.deletes, 0);
  f.client.start();
  await until(() => f.observed.errors.includes('SubscriptionMismatch'), 'owner mismatch');
  assert.equal(f.hub.posts, 1);
});

test('a failed delete retains the owned subscription record for later cleanup', async t => {
  const f = await fixture(t, 'deletion-denied');
  f.client.start();
  await until(() => f.observed.connected === 1, 'connection');
  await f.client.stop();
  await assert.rejects(f.client.removeSubscription(), /SubscriptionDeleteFailed/);
  assert.equal(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).stage, 'ready');
  assert.equal(f.hub.subscriptions.size, 1);
});

test('foreign registration URL never receives bearer and created subscription remains pending', async t => {
  const f = await fixture(t, 'foreign');
  f.client.start();
  await until(() => f.observed.errors.includes('SubscriptionCreationUnknown'), 'foreign URL rejected');
  assert.equal(f.hub.streams, 0);
  assert.equal(f.hub.deletes, 0);
  assert.equal(f.hub.subscriptions.size, 1);
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.equal(state.stage, 'pending');
  assert.equal(state.reason, 'InvalidRegistrationOrStateWrite');
  assert.ok(f.hub.subscriptions.has(state.subscriptionId));
  await f.client.stop();
  f.client.start();
  await until(() => f.observed.errors.length >= 2, 'pending after restart');
  assert.equal(f.hub.posts, 1);
});

test('a lost POST response leaves pending and never creates another subscription', async t => {
  const f = await fixture(t, 'dropped');
  f.client.start();
  await until(() => f.observed.errors.includes('SubscriptionCreationUnknown'), 'pending');
  await f.client.stop();
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.equal(state.stage, 'pending');
  assert.ok(['RequestFailed', 'RequestTimeout', 'PostOutcomeUnknown'].includes(state.reason));
  f.client.start();
  await until(() => f.observed.errors.length >= 2, 'pending after restart');
  assert.equal(f.hub.posts, 1);
  assert.equal(f.hub.deletes, 0);
});

test('candidate ID and ownership mismatch survive and permit verified cleanup', async t => {
  const f = await fixture(t, 'mismatch-create');
  f.client.start();
  await until(() => f.observed.errors.includes('SubscriptionCreationUnknown'), 'mismatch recorded');
  await f.client.stop();
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.equal(state.stage, 'pending');
  assert.equal(state.reason, 'OwnershipMismatch');
  assert.equal(state.httpStatus, 200);
  assert.ok(f.hub.subscriptions.has(state.subscriptionId));
  await f.client.removeSubscription();
  assert.equal(f.hub.deletes, 1);
  assert.equal(f.hub.subscriptions.size, 0);
});

test('HTTP errors retain status but never persist the response body', async t => {
  const f = await fixture(t, 'status-400');
  f.client.start();
  await until(() => f.observed.errors.includes('SubscriptionCreationUnknown'), 'HTTP 400 recorded');
  const stateText = await fs.readFile(f.subscriptionFile, 'utf8');
  const state = JSON.parse(stateText);
  assert.equal(state.reason, 'UnexpectedHttpStatus');
  assert.equal(state.httpStatus, 400);
  assert.equal(state.subscriptionId, undefined);
  assert.equal(stateText.includes('private details'), false);
});

test('explicit external subscription is used but never deleted or recreated', async t => {
  const f = await fixture(t);
  const id = crypto.randomUUID(), name = 'Kitchen Bottom Lights local logger';
  f.hub.subscriptions.set(id, { subscriptionId: id, name, registrationUrl: `/push/${id}`,
    subscriptionFilters: [{ type: 'LOCATIONIDS', value: [location], eventType: [], capability: [], attribute: [], component: [] }] });
  await fs.writeFile(f.subscriptionFile, JSON.stringify({ version: 1, hubId, locationIds: [location],
    name, stage: 'ready', ownership: 'external', subscriptionId: id }), { mode: 0o600 });
  f.client.start();
  await until(() => f.observed.connected === 1, 'external subscription connected');
  assert.equal(f.hub.posts, 0);
  await f.client.stop();
  await assert.rejects(f.client.removeSubscription(), /ExternalSubscriptionReadOnly/);
  assert.equal(f.hub.deletes, 0);
  f.hub.subscriptions.delete(id);
  f.client.start();
  await until(() => f.observed.errors.includes('ExternalSubscriptionMissing'), 'external subscription missing');
  assert.equal(f.hub.posts, 0);
  assert.equal(f.hub.deletes, 0);
  assert.equal(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')).subscriptionId, id);
});

test('external subscription filter mismatch is not accepted or modified', async t => {
  const f = await fixture(t);
  const id = crypto.randomUUID(), name = 'Existing subscription';
  f.hub.subscriptions.set(id, { subscriptionId: id, name, registrationUrl: `/push/${id}`,
    subscriptionFilters: [{ type: 'LOCATIONIDS', value: ['ffffffff-ffff-ffff-ffff-ffffffffffff'] }] });
  await fs.writeFile(f.subscriptionFile, JSON.stringify({ version: 1, hubId, locationIds: [location],
    name, stage: 'ready', ownership: 'external', subscriptionId: id }), { mode: 0o600 });
  f.client.start();
  await until(() => f.observed.errors.includes('SubscriptionMismatch'), 'external filter mismatch');
  assert.equal(f.hub.streams, 0);
  assert.equal(f.hub.posts, 0);
  assert.equal(f.hub.deletes, 0);
});

test('untrusted TLS certificate blocks every authorized request', async t => {
  const f = await fixture(t, 'wrong-cert');
  f.client.start();
  await until(() => f.observed.errors.length > 0, 'TLS failure');
  assert.equal(f.hub.tokens.length, 0);
  assert.equal(f.hub.posts, 0);
});

test('a trusted chain with the wrong peer fingerprint blocks authorization', async t => {
  const f = await fixture(t, 'fingerprint');
  f.client.start();
  await until(() => f.observed.errors.includes('CertificateVerificationFailed'), 'fingerprint failure');
  assert.equal(f.hub.tokens.length, 0);
});

async function rotationFixture(t, options = {}) {
  const f = await fixture(t);
  const oldId = crypto.randomUUID();
  const old = { version: 1, hubId, locationIds: [location], name: `Homebridge local events ${crypto.randomUUID()}`,
    stage: 'ready', subscriptionId: oldId, ...(options.external ? { ownership: 'external', name: 'External logger' } : {}),
    ...(options.lastRotationAt !== undefined ? { lastRotationAt: options.lastRotationAt } : {}) };
  await fs.writeFile(f.subscriptionFile, JSON.stringify(old), { mode: 0o600 });
  const mtime = new Date(options.mtime ?? Date.now() - 5 * 60 * 60 * 1000);
  await fs.utimes(f.subscriptionFile, mtime, mtime);
  f.client.stopped = false;
  f.calls = [];
  f.client.json = async (_session, _credentials, method, endpoint, body) => {
    f.calls.push({ method, endpoint });
    if (method === 'GET' && endpoint.startsWith('/subscriptions/')) return { status: options.lookupStatus ?? 403, data: {} };
    if (method === 'GET' && endpoint === '/devices') {
      return { status: options.devicesStatus ?? 200, data: options.devicesPayload ?? { items: [] } };
    }
    if (method === 'POST') {
      const pending = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
      assert.equal(pending.stage, 'pending', 'pending must be durable before POST');
      assert.equal(pending.previousArchive, undefined, 'replacement must not create an archive');
      if (options.dropPost) throw Error('RequestTimeout');
      const id = crypto.randomUUID();
      return { status: 200, data: { ...body, subscriptionId: id, registrationUrl: `/push/${id}` } };
    }
    throw Error('unexpected request');
  };
  return { ...f, old };
}
async function firstForbidden(f) {
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionLookupFailed/);
}
function ageForbidden(f) { f.client.forbidden.firstSeen -= 31000; }

test('two 403s replace an owned subscription once with a durable pending marker', async t => {
  const f = await rotationFixture(t);
  await firstForbidden(f);
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionLookupFailed/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0, 'recheck must respect backoff');
  ageForbidden(f);
  assert.match(await f.client.subscriptionLocked({}, f.credentials), /^\/push\//);
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.equal(state.stage, 'ready');
  assert.notEqual(state.subscriptionId, f.old.subscriptionId);
  assert.ok(Number.isSafeInteger(state.lastRotationAt));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  assert.deepEqual((await fs.readdir(path.dirname(f.subscriptionFile))).filter(x => x.startsWith('previous-')), []);
  f.client.forbidden = undefined;
  await firstForbidden(f);
  ageForbidden(f);
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionRotationLimited_Cooldown/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1, 'rotation limit persists in ready state');
});

test('a 403 after the observed four-hour lifetime replaces without the extra recheck delay', async t => {
  const f = await rotationFixture(t, { lastRotationAt: Date.now() - 4 * 60 * 60 * 1000 - 1000 });
  assert.match(await f.client.subscriptionLocked({}, f.credentials), /^\/push\//);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('ambiguous rotation POST retains pending and never retries', async t => {
  const f = await rotationFixture(t, { dropPost: true });
  await firstForbidden(f);
  ageForbidden(f);
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionCreationUnknown/);
  const pending = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.equal(pending.stage, 'pending');
  assert.equal(pending.reason, 'RequestTimeout');
  assert.equal(pending.previousArchive, undefined);
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionCreationUnknown/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
});

test('external subscriptions and failed hub authentication are not rotated', async t => {
  const external = await rotationFixture(t, { external: true });
  await firstForbidden(external);
  await firstForbidden(external);
  assert.equal(external.calls.filter(c => c.method === 'POST').length, 0);
  const failedAuth = await rotationFixture(t, { devicesStatus: 403 });
  await firstForbidden(failedAuth);
  ageForbidden(failedAuth);
  await assert.rejects(failedAuth.client.subscriptionLocked({}, failedAuth.credentials), /SubscriptionLookupFailed/);
  assert.equal(failedAuth.calls.filter(c => c.method === 'POST').length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(failedAuth.subscriptionFile, 'utf8')), failedAuth.old);
});

test('credentials must match between both forbidden lookups and authenticated discovery', async t => {
  const f = await rotationFixture(t);
  await firstForbidden(f);
  ageForbidden(f);
  const changed = { ...f.credentials, access_token: jwt('changed') };
  await assert.rejects(f.client.subscriptionLocked({}, changed), /SubscriptionLookupFailed/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  ageForbidden(f);
  // The on-disk credentials are still the original token: discovery must stop rotation.
  await assert.rejects(f.client.subscriptionLocked({}, changed), /SubscriptionLookupFailed/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('a recent or future rotation marker blocks a new POST across restart', async t => {
  for (const timestamp of [Date.now() - 1000, Date.now() + 3600000]) {
    const f = await rotationFixture(t, { lastRotationAt: timestamp });
    await firstForbidden(f);
    ageForbidden(f);
    const expected = timestamp > Date.now() ? /SubscriptionRotationLimited_InvalidTime/ : /SubscriptionRotationLimited_Cooldown/;
    await assert.rejects(f.client.subscriptionLocked({}, f.credentials), expected);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  }
});

test('a legacy state with a recent or future mtime blocks rotation', async t => {
  for (const mtime of [Date.now() - 1000, Date.now() + 3600000]) {
    const f = await rotationFixture(t, { mtime });
    await firstForbidden(f);
    ageForbidden(f);
    const expected = mtime > Date.now() ? /SubscriptionRotationLimited_InvalidTime/ : /SubscriptionRotationLimited_Cooldown/;
    await assert.rejects(f.client.subscriptionLocked({}, f.credentials), expected);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')), f.old);
  }
});

test('404 with a recent creation cannot bypass the one-minute cooldown', async t => {
  const f = await rotationFixture(t, { lookupStatus: 404, lastRotationAt: Date.now() - 1000 });
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionRotationLimited_Cooldown/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')), f.old);
});

test('replacement is allowed once the one-minute cooldown expires', async t => {
  const f = await rotationFixture(t, { lookupStatus: 404, lastRotationAt: Date.now() - 120000 });
  assert.match(await f.client.subscriptionLocked({}, f.credentials), /^\/push\//);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('404 for an old owned subscription persists pending before one POST', async t => {
  const f = await rotationFixture(t, { lookupStatus: 404 });
  assert.match(await f.client.subscriptionLocked({}, f.credentials), /^\/push\//);
  const ready = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  assert.equal(ready.stage, 'ready');
  assert.ok(Number.isSafeInteger(ready.lastRotationAt));
  assert.notEqual(ready.subscriptionId, f.old.subscriptionId);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
});

test('credential change after rotation pending restores the old ready state before POST', async t => {
  const f = await rotationFixture(t, { lookupStatus: 404 });
  let checks = 0;
  f.client.credentials = async () => ++checks === 1 ? f.credentials :
    { ...f.credentials, access_token: jwt('replaced-after-pending') };
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /RequestNotSent/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')), f.old);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('404 with rejected or invalid authenticated device discovery never changes state', async t => {
  for (const options of [
    { lookupStatus: 404, devicesStatus: 403 },
    { lookupStatus: 404, devicesPayload: {} },
    { lookupStatus: 404, devicesPayload: { items: [{ deviceId: '' }] } },
  ]) {
    const f = await rotationFixture(t, options);
    await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /SubscriptionLookupFailed/);
    assert.deepEqual(JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8')), f.old);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
    const archives = (await fs.readdir(path.dirname(f.subscriptionFile))).filter(name => name.startsWith('previous-'));
    assert.deepEqual(archives, []);
  }
});

test('credential change after initial pending safely removes the unsent marker', async t => {
  const f = await fixture(t);
  f.client.stopped = false;
  f.client.credentials = async () => ({ ...f.credentials, access_token: jwt('replaced-after-pending') });
  await assert.rejects(f.client.subscriptionLocked({}, f.credentials), /RequestNotSent/);
  await assert.rejects(fs.access(f.subscriptionFile), { code: 'ENOENT' });
  assert.equal(f.hub.posts, 0);
});

test('existing archive records do not block replacement or create new archives', async t => {
  for (const lookupStatus of [403, 404]) {
    const f = await rotationFixture(t, { lookupStatus });
    const directory = path.dirname(f.subscriptionFile);
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(directory, `previous-${crypto.randomUUID()}.json`), '{}', { mode: 0o600 });
    }
    const before = (await fs.readdir(directory)).filter(x => x.startsWith('previous-')).sort();
    const info = [];
    f.client.options.onInfo = message => info.push(message);
    if (lookupStatus === 403) { await firstForbidden(f); ageForbidden(f); }
    assert.match(await f.client.subscriptionLocked({}, f.credentials), /^\/push\//);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
    assert.deepEqual((await fs.readdir(directory)).filter(x => x.startsWith('previous-')).sort(), before);
    assert.match(info[0], new RegExp(`unavailable \\(hub HTTP ${lookupStatus}\\); creating a replacement`));
    assert.match(info[1], new RegExp(`created \\(hub HTTP ${lookupStatus}\\); successful replacements since plugin start: 1`));
  }
});

test('replacement count in logs reflects successful replacements during the current plugin run', async t => {
  const f = await rotationFixture(t, { lookupStatus: 404 });
  const info = [];
  f.client.options.onInfo = message => info.push(message);
  await f.client.subscriptionLocked({}, f.credentials);
  const state = JSON.parse(await fs.readFile(f.subscriptionFile, 'utf8'));
  state.lastRotationAt = Date.now() - 120000;
  await fs.writeFile(f.subscriptionFile, JSON.stringify(state), { mode: 0o600 });
  await f.client.subscriptionLocked({}, f.credentials);
  assert.match(info[1], /successful replacements since plugin start: 1/);
  assert.match(info[3], /successful replacements since plugin start: 2/);
});
