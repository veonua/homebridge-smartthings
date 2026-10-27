const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const http2 = require('node:http2');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tls = require('node:tls');
const { LocalHubClient } = require('../dist/localHubClient');

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
  const server = http2.createSecureServer({
    key: await fs.readFile(trusted.key),
    cert: trustedPem,
  });
  server.on('sessionError', () => {});
  server.on('tlsClientError', () => {});
  server.on('stream', (stream, headers) => {
    receivedTokens.push(headers.authorization);
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify(headers[':path'] === '/devices'
      ? { items: [{ deviceId: 'device-1', locationId: 'location-1' }] }
      : { components: { main: { switch: { switch: { value: 'on' } } } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
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

  assert.deepEqual(await client.getDeviceIds(), new Set(['device-1']));
  assert.deepEqual(await client.get('/devices/device-1/status'), {
    components: { main: { switch: { switch: { value: 'on' } } } },
  });
  credentials.access_token = 'second-test-token';
  await fs.writeFile(tokenFile, JSON.stringify(credentials));
  await client.getDeviceIds();
  assert.deepEqual(receivedTokens, ['Bearer first-test-token', 'Bearer first-test-token', 'Bearer second-test-token']);

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
  t.after(() => new Promise(resolve => server.close(resolve)));
  const tokenFile = path.join(dir, 'hub.json');
  await fs.writeFile(tokenFile, JSON.stringify({ hubId, hubHost: '127.0.0.1', hubPort: server.address().port,
    access_token: 'command-test-token', public_certificate: trustedPem }));
  const client = new LocalHubClient(tokenFile);

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
    { component: 'secondary', capability: 'switchLevel', command: 'setLevel', arguments: [30] },
    { capability: 'switch', command: 'on' },
  ]);
  assert.equal(requests[1].body.commands[0].component, 'secondary');
  assert.deepEqual(requests[1].body.commands[0].arguments, [30]);

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
