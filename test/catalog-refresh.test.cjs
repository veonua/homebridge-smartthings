'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { IKHomeBridgeHomebridgePlatform } = require('../dist/platform');
const { LocalHubHttpError } = require('../dist/localHubClient');

const device = deviceId => ({ deviceId, label: deviceId,
  components: [{ id: 'main', capabilities: [{ id: 'switch' }] }] });
const forbidden = () => Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, ids = ['kept', 'deleted']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartthings-catalog-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'smartthings-device-metadata.json');
  fs.writeFileSync(file, JSON.stringify(ids.map(device)));
  const api = new EventEmitter();
  api.hap = { Service: {}, Characteristic: {} };
  api.user = { storagePath: () => directory };
  const removed = [];
  api.unregisterPlatformAccessories = (_plugin, _platform, accessories) => removed.push(...accessories);
  const messages = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level =>
    [level, message => messages.push({ level, message })]));
  const platform = new IKHomeBridgeHomebridgePlatform(log, {
    BaseURL: 'https://example.invalid/v1/', AccessToken: 'unused', LocalHubTokenFile: '/unused/token',
  }, api);
  t.after(() => api.emit('shutdown'));
  platform.accessories.push(...ids.map(id => ({ UUID: id, context: { device: device(id) } })));
  platform.accessoryObjects = ids.map(id => ({ id }));
  platform.localDeviceIds = new Set(['kept']);
  const localCalls = [], cloudCalls = [], commands = [];
  platform.localHub = { getDeviceIds: async () => { localCalls.push('/devices'); return new Set(['kept']); } };
  const error = forbidden();
  platform.axInstance = {
    get: async endpoint => { cloudCalls.push(endpoint); throw error; },
    post: async endpoint => { commands.push(endpoint); throw error; },
  };
  return { platform, api, file, removed, messages, localCalls, cloudCalls, commands, error };
}

test('403 removes only the failing device absent from the local list, with cloud unavailable', async t => {
  const f = fixture(t, ['kept', 'deleted', 'cloud-only']);
  await assert.rejects(f.platform.getDeviceData('deleted', 'status'), error => error === f.error);
  await f.platform.catalogRefresh;
  assert.deepEqual(f.localCalls, ['/devices']);
  assert.deepEqual(f.cloudCalls, ['devices/deleted/status']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), ['kept', 'cloud-only'].map(device));
  assert.deepEqual(f.removed.map(a => a.UUID), ['deleted']);
  assert.deepEqual(f.platform.accessories.map(a => a.UUID), ['kept', 'cloud-only']);
  assert.deepEqual(f.platform.accessoryObjects.map(a => a.id), ['kept', 'cloud-only']);
  await assert.rejects(f.platform.getDeviceData('deleted', 'health'), /no longer in/);
  await assert.rejects(f.platform.sendDeviceCommands('deleted', [{ capability: 'switch', command: 'on' }]), /no longer in/);
  assert.deepEqual(f.commands, []);
  f.platform.discoverDevices([device('deleted')]);
  assert.deepEqual(f.platform.accessories.map(a => a.UUID), ['kept', 'cloud-only']);
});

test('concurrent 403s share one local request and remove each missing failing device', async t => {
  const f = fixture(t, ['kept', 'deleted', 'also-deleted', 'untouched']);
  let finish;
  f.platform.localHub.getDeviceIds = () => { f.localCalls.push('/devices'); return new Promise(resolve => { finish = resolve; }); };
  await Promise.all([
    assert.rejects(f.platform.getDeviceData('deleted', 'status')),
    assert.rejects(f.platform.getDeviceData('deleted', 'health')),
    assert.rejects(f.platform.getDeviceData('also-deleted', 'status')),
  ]);
  await flush();
  assert.deepEqual(f.localCalls, ['/devices']);
  assert.deepEqual(f.removed, []);
  finish(new Set(['kept']));
  await f.platform.catalogRefresh;
  assert.deepEqual(f.removed.map(a => a.UUID).sort(), ['also-deleted', 'deleted']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), ['kept', 'untouched'].map(device));
});

test('a 403 during cooldown schedules a refresh without requiring another error', async t => {
  const f = fixture(t, ['kept', 'deleted', 'also-deleted']);
  let now = 100000, scheduled;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    scheduled = { callback, delay, unref() {} };
    return scheduled;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  f.platform.refreshCatalogOnForbidden('deleted', f.error);
  await f.platform.catalogRefresh;
  f.platform.refreshCatalogOnForbidden('also-deleted', f.error);
  assert.equal(scheduled.delay, 30000);
  assert.deepEqual(f.removed.map(a => a.UUID), ['deleted']);
  now += scheduled.delay;
  scheduled.callback();
  await f.platform.catalogRefresh;
  assert.deepEqual(f.removed.map(a => a.UUID), ['deleted', 'also-deleted']);
  assert.equal(f.localCalls.length, 2);
});

test('a failing device still present in the local list is retained', async t => {
  const f = fixture(t);
  f.platform.localHub.getDeviceIds = async () => new Set(['kept', 'deleted']);
  await assert.rejects(f.platform.getDeviceData('deleted', 'health'));
  await f.platform.catalogRefresh;
  assert.deepEqual(f.removed, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), ['kept', 'deleted'].map(device));
});

test('failed local discovery preserves metadata and accessories, and can retry after cooldown', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  let now = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => now);
  f.platform.localHub.getDeviceIds = async () => { calls++; throw new Error('hub unavailable'); };
  f.platform.refreshCatalogOnForbidden('deleted', f.error);
  await f.platform.catalogRefresh;
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.removed, []);
  f.platform.refreshCatalogOnForbidden('deleted', f.error);
  assert.equal(calls, 1);
  now += 30000;
  f.platform.localHub.getDeviceIds = async () => { calls++; return new Set(['kept']); };
  f.platform.refreshCatalogOnForbidden('deleted', f.error);
  await f.platform.catalogRefresh;
  assert.equal(calls, 2);
  assert.deepEqual(f.removed.map(a => a.UUID), ['deleted']);
});

test('a cache write failure leaves accessories registered and prior metadata intact', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk unavailable'); });
  await assert.rejects(f.platform.getDeviceData('deleted', 'status'));
  await f.platform.catalogRefresh;
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['smartthings-device-metadata.json']);
  assert.deepEqual(f.removed, []);
});

test('a missing metadata file does not prevent removal of a confirmed stale accessory', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  await assert.rejects(f.platform.getDeviceData('deleted', 'status'));
  await f.platform.catalogRefresh;
  assert.deepEqual(f.removed.map(a => a.UUID), ['deleted']);
});

test('a local 403 triggers a refresh even when cloud fallback succeeds', async t => {
  const f = fixture(t);
  f.platform.localDeviceIds.add('deleted');
  f.platform.localHub.getDeviceIds = async () => { f.localCalls.push('/devices'); return new Set(['kept', 'deleted']); };
  f.platform.localHub.get = async () => { throw new LocalHubHttpError(403); };
  f.platform.axInstance.get = async () => ({ data: { components: {} } });
  assert.deepEqual(await f.platform.getDeviceData('deleted', 'status'), { components: {} });
  await f.platform.catalogRefresh;
  assert.deepEqual(f.localCalls, ['/devices']);
  assert.deepEqual(f.removed, []);
});

test('command 403 refreshes locally without retrying a command', async t => {
  for (const source of ['local', 'cloud']) await t.test(source, async t => {
    const f = fixture(t);
    if (source === 'local') {
      f.platform.localDeviceIds.add('deleted');
      f.platform.localHub.executeCommands = async () => { f.commands.push('local'); throw new LocalHubHttpError(403); };
    }
    await assert.rejects(f.platform.sendDeviceCommands('deleted', [{ capability: 'switch', command: 'on' }]));
    await f.platform.catalogRefresh;
    assert.equal(f.commands.length, 1);
    assert.deepEqual(f.removed.map(a => a.UUID), ['deleted']);
  });
});

test('other HTTP errors or absence of a local hub never remove devices', async t => {
  for (const code of [401, 404, 500]) await t.test(String(code), async t => {
    const f = fixture(t);
    f.platform.axInstance.get = async () => { throw Object.assign(new Error('failed'), { response: { status: code } }); };
    await assert.rejects(f.platform.getDeviceData('deleted', 'status'));
    assert.equal(f.platform.catalogRefresh, undefined);
    assert.deepEqual(f.localCalls, []);
    assert.deepEqual(f.removed, []);
  });
  const f = fixture(t);
  f.platform.localHub = undefined;
  await assert.rejects(f.platform.getDeviceData('deleted', 'status'));
  assert.equal(f.platform.catalogRefresh, undefined);
  assert.deepEqual(f.removed, []);
});

test('shutdown prevents a late local response from changing cache or registrations', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  let finish;
  f.platform.localHub.getDeviceIds = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(f.platform.getDeviceData('deleted', 'status'));
  await flush();
  f.api.emit('shutdown');
  finish(new Set(['kept']));
  await f.platform.catalogRefresh;
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.removed, []);
});

test('newly registered accessories can be removed after a later 403', async t => {
  const f = fixture(t, ['kept']);
  const registered = [];
  f.api.platformAccessory = class { constructor(name, id) { this.displayName = name; this.UUID = id; this.context = {}; } };
  f.api.registerPlatformAccessories = (_plugin, _platform, accessories) => registered.push(...accessories);
  f.platform.createAccessoryObject = d => ({ id: d.deviceId });
  f.platform.discoverDevices([device('new')]);
  await assert.rejects(f.platform.getDeviceData('new', 'status'));
  await f.platform.catalogRefresh;
  assert.deepEqual(f.removed, registered);
});

test('existing cloud discovery validates all pages before returning metadata', async t => {
  const f = fixture(t);
  f.platform.axInstance.get = async endpoint => endpoint === 'devices'
    ? { data: { items: [device('kept')], _links: { next: { href: '?page=2' } } } }
    : { data: { items: [device('page-two')] } };
  assert.deepEqual(await f.platform.getCloudDeviceCatalog(), ['kept', 'page-two'].map(device));
});

test('existing cloud discovery rejects malformed or unsafe pagination', async t => {
  for (const mode of ['network', 'items', 'device', 'links', 'second-page', 'foreign', 'loop', 'missing-link']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      f.platform.axInstance.get = async endpoint => {
        f.cloudCalls.push(endpoint);
        if (endpoint !== 'devices') throw new Error('second page unavailable');
        if (mode === 'network') throw new Error('network unavailable');
        if (mode === 'items') return { data: { items: null } };
        if (mode === 'device') return { data: { items: [{ deviceId: 'kept' }] } };
        if (mode === 'links') return { data: { items: [device('kept')], _links: [] } };
        const href = mode === 'foreign' ? 'https://foreign.invalid/devices' : mode === 'loop' ? 'devices' : '?page=2';
        return { data: { items: [device('kept')], _links: { next: mode === 'missing-link' ? {} : { href } } } };
      };
      await assert.rejects(f.platform.getCloudDeviceCatalog());
      assert.ok(!f.cloudCalls.some(endpoint => endpoint.includes('foreign.invalid')));
    });
  }
});
