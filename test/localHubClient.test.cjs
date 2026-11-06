const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http2 = require('node:http2');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tls = require('node:tls');
const { LocalHubClient, LocalHubUnavailableError } = require('../dist/localHubClient');

const hubId = '11111111-2222-3333-4444-555555555555';
const tlsName = `svc-hla-tcp.hub-${hubId}.smartthings`;

function makeCertificate(dir, name) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', `/CN=${name}-test-authority`,
    '-addext', `subjectAltName=DNS:${tlsName}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,cRLSign',
  ], { stdio: 'ignore' });
  return { key, cert };
}

async function makeSignedCertificate(dir, authority) {
  const key = path.join(dir, 'signed.key');
  const csr = path.join(dir, 'signed.csr');
  const cert = path.join(dir, 'signed.pem');
  const extensions = path.join(dir, 'extensions.cnf');
  await fs.writeFile(extensions, `subjectAltName=DNS:${tlsName}\nbasicConstraints=CA:FALSE\n` +
    'keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${tlsName}`,
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'x509', '-req', '-in', csr, '-CA', authority.cert, '-CAkey', authority.key,
    '-CAcreateserial', '-days', '1', '-extfile', extensions, '-out', cert,
  ], { stdio: 'ignore' });
  return { key, cert };
}

test('local hub client verifies TLS, reads devices and reloads the token', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-hub-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const trusted = makeCertificate(dir, 'trusted');
  const wrong = makeCertificate(dir, 'wrong');
  const trustedPem = await fs.readFile(trusted.cert, 'utf8');
  const receivedTokens = [];
  let sessions = 0;
  const server = http2.createSecureServer({
    key: await fs.readFile(trusted.key),
    cert: trustedPem,
  });
  server.on('sessionError', () => {});
  server.on('session', () => { sessions++; });
  server.on('tlsClientError', () => {});
  server.on('stream', (stream, headers) => {
    receivedTokens.push(headers.authorization);
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify(headers[':path'] === '/devices'
      ? { items: [{ deviceId: 'device-1', locationId: 'location-1' }] }
      : { components: { main: { switch: { switch: { value: 'on' } } } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tokenFile = path.join(dir, 'hub.json');
  const credentials = {
    hubId,
    hubHost: '127.0.0.1',
    hubPort: server.address().port,
    access_token: 'first-test-token',
    public_certificate: trustedPem,
  };
  await fs.writeFile(tokenFile, JSON.stringify(credentials));
  const client = new LocalHubClient(tokenFile);
  t.after(() => { client.close(); return new Promise(resolve => server.close(resolve)); });

  assert.deepEqual(await client.getDeviceIds(), new Set(['device-1']));
  assert.deepEqual(await client.get('/devices/device-1/status'), {
    components: { main: { switch: { switch: { value: 'on' } } } },
  });
  credentials.access_token = 'second-test-token';
  await fs.writeFile(tokenFile, JSON.stringify(credentials));
  await client.getDeviceIds();
  assert.deepEqual(receivedTokens, ['Bearer first-test-token', 'Bearer first-test-token', 'Bearer second-test-token']);
  assert.equal(sessions, 1, 'sequential reads and renewed tokens reuse the pinned session');

  credentials.public_certificate = await fs.readFile(wrong.cert, 'utf8');
  await fs.writeFile(tokenFile, JSON.stringify(credentials));
  await assert.rejects(client.getDeviceIds(), /Local hub connection failed|Local hub TLS verification failed/);
  assert.equal(receivedTokens.length, 3, 'token must not reach an untrusted server');

  // A different certificate signed by the trusted CA passes chain and hostname
  // validation, but must still fail the hub's peer fingerprint check.
  const signed = await makeSignedCertificate(dir, trusted);
  const signedServer = http2.createSecureServer({
    key: await fs.readFile(signed.key), cert: await fs.readFile(signed.cert),
  });
  signedServer.on('sessionError', () => {});
  signedServer.on('stream', (stream, headers) => {
    receivedTokens.push(headers.authorization);
    stream.respond({ ':status': 200 });
    stream.end('{}');
  });
  await new Promise(resolve => signedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => signedServer.close(resolve)));
  await new Promise((resolve, reject) => {
    const socket = tls.connect(signedServer.address().port, '127.0.0.1', {
      ca: trustedPem, servername: tlsName, ALPNProtocols: ['h2'],
    }, () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  });
  credentials.public_certificate = trustedPem;
  credentials.hubPort = signedServer.address().port;
  await fs.writeFile(tokenFile, JSON.stringify(credentials));
  await assert.rejects(client.getDeviceIds(), /Local hub TLS verification failed/);
  assert.equal(receivedTokens.length, 3, 'token must not reach a server with a different peer certificate');
});

test('commands use the pinned HTTP/2 connection and validate every result without retry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-hub-command-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const trusted = makeCertificate(dir, 'commands');
  const trustedPem = await fs.readFile(trusted.cert, 'utf8');
  const requests = [];
  let reply = { results: [{ id: 'result-1', status: 'ACCEPTED' }] };
  let httpStatus = 200;
  let abort = false;
  const server = http2.createSecureServer({ key: await fs.readFile(trusted.key), cert: trustedPem });
  server.on('sessionError', () => {});
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('error', () => {});
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      if (abort) {
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        return;
      }
      stream.respond({ ':status': httpStatus, 'content-type': 'application/json' });
      stream.end(JSON.stringify(reply));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tokenFile = path.join(dir, 'hub.json');
  await fs.writeFile(tokenFile, JSON.stringify({ hubId, hubHost: '127.0.0.1', hubPort: server.address().port,
    access_token: 'command-test-token', public_certificate: trustedPem }));
  const client = new LocalHubClient(tokenFile);
  t.after(() => { client.close(); return new Promise(resolve => server.close(resolve)); });

  await client.executeCommands('device-1', [{ capability: 'switch', command: 'on' }]);
  assert.equal(requests[0].headers[':method'], 'POST');
  assert.equal(requests[0].headers[':path'], '/devices/device-1/commands');
  assert.equal(requests[0].headers.authorization, 'Bearer command-test-token');
  assert.equal(requests[0].headers['x-hub-identifier'], hubId);
  assert.equal(requests[0].headers['content-type'], 'application/json');
  assert.deepEqual(requests[0].body, { commands: [
    { component: 'main', capability: 'switch', command: 'on', arguments: [] },
  ] });
  reply = { results: [{ id: 'one', status: 'COMPLETED' }, { id: 'two', status: 'ACCEPTED' }] };
  await client.executeCommands('device-1', [
    { component: 'secondary', capability: 'switchLevel', command: 'setLevel', arguments: [30, 0] },
    { capability: 'switch', command: 'on' },
  ]);
  assert.equal(requests[1].body.commands[0].component, 'secondary');
  assert.deepEqual(requests[1].body.commands[0].arguments, [30, 0], 'the JSON request preserves an explicit zero rate');

  for (const invalidReply of [
    {}, { results: [] }, { results: [{ id: 'one', status: 'FAILED' }] },
    { results: [{ id: 'one', status: 'UNKNOWN' }] }, { results: [{ status: 'ACCEPTED' }] },
  ]) {
    reply = invalidReply;
    await assert.rejects(client.executeCommands('device-1', [{ capability: 'switch', command: 'on' }]),
      /did not accept every command/);
  }
  const beforeValidation = requests.length;
  await assert.rejects(client.executeCommands('../bad', [{ capability: 'switch', command: 'on' }]), /Invalid/);
  await assert.rejects(client.executeCommands('device-1', []), /Invalid/);
  await assert.rejects(client.executeCommands('device-1', [{ capability: 'switch', command: 'on',
    arguments: ['x'.repeat(65536)] }]), /size limit/);
  assert.equal(requests.length, beforeValidation);
  httpStatus = 403;
  await assert.rejects(client.executeCommands('device-1', [{ capability: 'switch', command: 'on' }]),
    { message: 'Local hub returned HTTP 403', statusCode: 403 });
  assert.equal(requests.length, beforeValidation + 1, 'a forbidden POST must not be retried');
  httpStatus = 200;
  abort = true;
  await assert.rejects(client.executeCommands('device-1', [{ capability: 'switch', command: 'on' }]));
  assert.equal(requests.length, beforeValidation + 2, 'an uncertain POST must never be retried');
});

async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function hubFixture(t, handler, callbacks = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-hub-shared-'));
  const trusted = makeCertificate(dir, 'shared');
  const credentials = { hubId, hubHost: '127.0.0.1', access_token: 'shared-test-token',
    public_certificate: await fs.readFile(trusted.cert, 'utf8') };
  const sessions = [], requests = [];
  const server = http2.createSecureServer({ key: await fs.readFile(trusted.key), cert: credentials.public_certificate });
  server.on('sessionError', () => {});
  server.on('session', session => { sessions.push(session); });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    stream.resume();
    stream.on('end', () => {
      const respond = () => {
        stream.respond({ ':status': 200 });
        stream.end(JSON.stringify(headers[':method'] === 'POST'
          ? { results: [{ id: 'accepted', status: 'ACCEPTED' }] } : { ok: true }));
      };
      requests.push({ stream, headers, respond });
      handler?.(requests.at(-1), requests);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  credentials.hubPort = server.address().port;
  const tokenFile = path.join(dir, 'hub.json');
  await fs.writeFile(tokenFile, JSON.stringify(credentials));
  const client = new LocalHubClient(tokenFile, callbacks);
  t.after(async () => {
    client.close();
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { client, credentials, tokenFile, requests, sessions };
}

const switchOn = [{ capability: 'switch', command: 'on' }];

test('simultaneous group commands share one connection and run as concurrent streams', async t => {
  const f = await hubFixture(t);
  const commands = Promise.all(['a', 'b', 'c', 'd'].map(id => f.client.executeCommands(id, switchOn)));
  await until(() => f.requests.length === 4, 'all group commands arrive before any response');
  assert.equal(f.sessions.length, 1, 'cold concurrent requests share one TLS handshake');
  assert.equal(new Set(f.requests.map(r => r.stream.id)).size, 4);
  for (const request of f.requests) request.respond();
  await commands;
  const next = f.client.executeCommands('e', switchOn);
  await until(() => f.requests.length === 5, 'next command');
  f.requests[4].respond();
  await next;
  assert.equal(f.sessions.length, 1, 'later groups reuse the connection');
});

test('queued commands precede queued reads while the concurrency limit stays at six', async t => {
  const f = await hubFixture(t);
  const initial = Array.from({ length: 6 }, (_, i) => f.client.get(`/initial-${i}`));
  await until(() => f.requests.length === 6, 'six active reads');
  const reads = [f.client.get('/queued-a'), f.client.get('/queued-b')];
  const commands = [f.client.executeCommands('a', switchOn), f.client.executeCommands('b', switchOn)];
  assert.equal(f.requests.length, 6, 'no seventh request starts before capacity is released');
  f.requests[0].respond();
  await until(() => f.requests.length === 7, 'first command admitted');
  assert.equal(f.requests[6].headers[':path'], '/devices/a/commands');
  f.requests[6].respond();
  await until(() => f.requests.length === 8, 'second command admitted');
  assert.equal(f.requests[7].headers[':path'], '/devices/b/commands');
  f.requests[7].respond();
  await until(() => f.requests.length === 9, 'first queued read admitted');
  assert.equal(f.requests[8].headers[':path'], '/queued-a');
  f.requests[8].respond();
  await until(() => f.requests.length === 10, 'second queued read admitted');
  assert.equal(f.requests[9].headers[':path'], '/queued-b');
  f.requests[9].respond();
  for (const request of f.requests.slice(1, 6)) request.respond();
  await Promise.all([...initial, ...reads, ...commands]);
  assert.equal(f.sessions.length, 1);
});

test('GOAWAY drains the old session and subsequent commands use a new verified connection', async t => {
  const f = await hubFixture(t, request => {
    if (request.headers[':path'] !== '/devices/draining/commands') request.respond();
  });
  await f.client.get('/initial');
  const draining = f.client.executeCommands('draining', switchOn);
  await until(() => f.requests.length === 2, 'command in flight before GOAWAY');
  const oldSession = f.sessions[0];
  const goaway = once(f.client.connection.session, 'goaway');
  oldSession.goaway(http2.constants.NGHTTP2_NO_ERROR, f.requests[1].stream.id);
  await goaway;
  await f.client.executeCommands('a', switchOn);
  f.requests[1].respond();
  await draining;
  assert.equal(f.sessions.length, 2);
  assert.equal(f.requests.length, 3);
});

test('a lost command response is never replayed and the next command reconnects', async t => {
  const f = await hubFixture(t, (request, requests) => {
    if (requests.length === 1) request.stream.session.destroy();
    else request.respond();
  });
  await assert.rejects(f.client.executeCommands('a', switchOn), /Local hub request/);
  assert.equal(f.requests.length, 1, 'the uncertain command is sent exactly once');
  await f.client.executeCommands('b', switchOn);
  assert.equal(f.requests.length, 2);
  assert.equal(f.sessions.length, 2);
});

test('a failed stream does not abort another device command or discard the shared session', async t => {
  const f = await hubFixture(t);
  const first = f.client.executeCommands('a', switchOn);
  const second = assert.rejects(f.client.executeCommands('b', switchOn), /Local hub request/);
  await until(() => f.requests.length === 2, 'parallel commands');
  f.requests.find(r => r.headers[':path'] === '/devices/b/commands').stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  await second;
  f.requests.find(r => r.headers[':path'] === '/devices/a/commands').respond();
  await first;
  const third = f.client.executeCommands('c', switchOn);
  await until(() => f.requests.length === 3, 'command after stream failure');
  f.requests[2].respond();
  await third;
  assert.equal(f.sessions.length, 1);
});

test('a changed hub destination and certificate create a new session while an old request drains', async t => {
  const oldHub = await hubFixture(t);
  const newHub = await hubFixture(t, request => request.respond());
  const oldRead = oldHub.client.get('/old');
  await until(() => oldHub.requests.length === 1, 'old request in flight');
  await fs.writeFile(oldHub.tokenFile, JSON.stringify(newHub.credentials));
  await oldHub.client.executeCommands('new', switchOn);
  assert.equal(newHub.requests.length, 1);
  assert.equal(oldHub.requests.length, 1, 'new token is sent only to the new verified hub');
  oldHub.requests[0].respond();
  assert.deepEqual(await oldRead, { ok: true });
});

test('closing the client cancels active and queued requests and rejects future work', async t => {
  const f = await hubFixture(t);
  const pending = Array.from({ length: 8 }, (_, i) => f.client.get(`/read-${i}`));
  pending.push(f.client.executeCommands('queued', switchOn));
  const outcomes = Promise.allSettled(pending);
  await until(() => f.requests.length === 6, 'active requests');
  f.client.close();
  assert.ok((await outcomes).every(result => result.status === 'rejected'));
  await assert.rejects(f.client.get('/after-close'), /client closed/);
  assert.equal(f.requests.length, 6, 'shutdown does not dispatch queued work');
});

test('a request timeout cancels only its stream and leaves the connection usable', async t => {
  const f = await hubFixture(t, request => {
    if (request.headers[':path'] !== '/slow') request.respond();
  });
  await f.client.get('/warm');
  const originalSetTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 15000 ? 100 : delay, ...args));
  const slow = assert.rejects(f.client.get('/slow'), /Local hub request timed out/);
  await until(() => f.requests.length === 2, 'slow stream opened');
  assert.deepEqual(await f.client.get('/fast'), { ok: true });
  await slow;
  await until(() => f.requests[1].stream.closed, 'timed out stream cancelled');
  await f.client.executeCommands('after-timeout', switchOn);
  assert.equal(f.sessions.length, 1, 'a timeout does not discard other devices shared connection');
  assert.equal(f.requests.length, 4, 'the timed out request is not replayed');
});

function failedConnection(error) {
  const session = new EventEmitter();
  session.destroy = () => {
    if (!session.destroyed) {
      session.destroyed = true;
      process.nextTick(() => session.emit('close'));
    }
  };
  session.close = session.destroy;
  process.nextTick(() => session.emit('error', error));
  return session;
}

test('one nested network outage pauses a burst, warns once, and recovers on demand without replaying commands', async t => {
  const warnings = [], recovered = [];
  const f = await hubFixture(t, request => request.respond(), {
    onUnavailable: code => warnings.push(code), onRestored: duration => recovered.push(duration),
  });
  let clock = Date.now(), failures = true, attempts = 0;
  t.mock.method(Date, 'now', () => clock);
  const connect = http2.connect;
  const systemError = Object.assign(new Error('private host and shared-test-token'), { code: 'ENETUNREACH' });
  const error = new Error('private aggregate details', { cause: new AggregateError([systemError, systemError]) });
  t.mock.method(http2, 'connect', (...args) => {
    attempts++;
    return failures ? failedConnection(error) : connect(...args);
  });
  const initial = [f.client.executeCommands('original', switchOn), ...Array.from({ length: 20 }, () => f.client.get('/devices'))];
  const results = await Promise.allSettled(initial);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.ok(result.reason instanceof LocalHubUnavailableError);
    assert.equal(result.reason.code, 'ENETUNREACH');
    assert.doesNotMatch(String(result.reason), /private|token|AggregateError/);
  }
  assert.equal(attempts, 1, 'only one shared handshake is attempted during the burst');
  assert.deepEqual(warnings, ['ENETUNREACH']);
  await assert.rejects(f.client.get('/paused'), LocalHubUnavailableError);
  await assert.rejects(f.client.executeCommands('paused', switchOn), LocalHubUnavailableError);
  assert.equal(attempts, 1, 'reads and commands fail immediately during the 30-second pause');
  clock += 5001;
  await assert.rejects(f.client.get('/still-paused'), LocalHubUnavailableError);
  assert.equal(attempts, 1, 'five seconds is not enough to start another connection');
  clock += 25000;
  await assert.rejects(f.client.get('/still-down'), LocalHubUnavailableError);
  assert.equal(attempts, 2);
  assert.deepEqual(warnings, ['ENETUNREACH'], 'a failed probe does not repeat the warning');
  clock += 30001;
  failures = false;
  await Promise.all([f.client.get('/recovered'), f.client.get('/also-recovered')]);
  assert.equal(attempts, 3);
  assert.deepEqual(recovered, [60002], 'a successful request reports recovery only once');
  assert.equal(f.client.unavailableError, undefined);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(r => r.headers[':method'] === 'GET'), 'commands rejected during the outage are never replayed');
  await f.client.executeCommands('new', switchOn);
  assert.equal(f.requests[2].headers[':path'], '/devices/new/commands');
});

test('TLS failures and mixed or cyclic error causes are not hidden as network outages', async t => {
  const warnings = [];
  const f = await hubFixture(t, undefined, { onUnavailable: code => warnings.push(code) });
  const unreachable = Object.assign(new Error('private address'), { code: 'ENETUNREACH' });
  const tlsError = Object.assign(new Error('private certificate'), { code: 'CERT_HAS_EXPIRED' });
  const cyclic = new Error('private cyclic details');
  cyclic.cause = cyclic;
  let error;
  t.mock.method(http2, 'connect', () => failedConnection(error));
  for (error of [tlsError, new AggregateError([unreachable, tlsError]), cyclic]) {
    await assert.rejects(f.client.get('/devices'), { message: 'Local hub connection failed' });
    assert.equal(f.client.unavailableError, undefined);
  }
  assert.deepEqual(warnings, []);
});

test('a network failure on an active shared session rejects commands once with a typed error', async t => {
  const warnings = [];
  const f = await hubFixture(t, undefined, { onUnavailable: code => warnings.push(code) });
  const commands = Promise.allSettled([f.client.executeCommands('a', switchOn), f.client.executeCommands('b', switchOn)]);
  await until(() => f.requests.length === 2, 'both commands sent before the connection fails');
  f.client.connection.session.destroy(Object.assign(new Error('private network detail'), { code: 'ENETUNREACH' }));
  const results = await commands;
  assert.ok(results.every(r => r.status === 'rejected' && r.reason instanceof LocalHubUnavailableError));
  assert.deepEqual(warnings, ['ENETUNREACH']);
  assert.equal(f.requests.length, 2, 'uncertain commands are never replayed');
  await assert.rejects(f.client.get('/paused'), LocalHubUnavailableError);
});
