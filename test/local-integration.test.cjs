'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IKHomeBridgeHomebridgePlatform } = require('../dist/platform');
const { MultiServiceAccessory } = require('../dist/multiServiceAccessory');
const { LocalHubUnavailableError } = require('../dist/localHubClient');

const device = (id, label = id, locationId = 'location') => ({
  deviceId: id, label, locationId, manufacturerName: 'Example',
  components: [{ id: 'main', capabilities: [{ id: 'switch' }] }],
});
const status = value => ({ components: { main: { switch: { switch: { value } } } } });

function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homebridge-smartthings-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const messages = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level =>
    [level, (...args) => messages.push({ level, message: args.join(' ') })]));
  const api = {
    hap: { Service: {}, Characteristic: {} },
    user: { storagePath: () => directory },
    on: () => {},
  };
  const config = { BaseURL: 'https://example.invalid/', AccessToken: 'test', LocalHubTokenFile: '/unused', ...overrides };
  const platform = new IKHomeBridgeHomebridgePlatform(log, config, api);
  const localCalls = [];
  const cloudCalls = [];
  platform.localHub = {
    getDeviceIds: async () => { localCalls.push('/devices'); return new Set(['a']); },
    get: async p => { localCalls.push(p); return status('on'); },
  };
  platform.axInstance = { get: async p => { cloudCalls.push(p); throw new Error('unexpected cloud call'); } };
  return { platform, directory, localCalls, cloudCalls, messages, api };
}

function cache(directory, devices) {
  fs.writeFileSync(path.join(directory, 'smartthings-device-metadata.json'), JSON.stringify(devices));
}

test('local network outages preserve device state and failure counts and report a HomeKit communication error', async t => {
  const f = setup(t);
  f.platform.localDeviceIds = new Set(['a']);
  const failure = new LocalHubUnavailableError('ENETUNREACH', Date.now() + 30000);
  f.platform.localHub.get = async () => { throw failure; };
  const snapshot = status('on').components.main;
  const handler = Object.create(MultiServiceAccessory.prototype);
  Object.assign(handler, { platform: f.platform, accessory: { UUID: 'a' }, name: 'Local lamp', log: f.platform.log,
    online: true, failureCount: 4, deviceStatusTimestamp: 0, commandInProgress: false, statusQueryInProgress: false,
    components: [{ componentId: 'main', capabilities: ['switch'], status: snapshot }] });
  for (let i = 0; i < 8; i++) assert.equal(await handler.refreshStatus(), false);
  assert.equal(handler.failureCount, 4);
  assert.equal(handler.isOnline(), true, 'a network outage does not declare the lamp offline');
  assert.equal(handler.deviceStatusTimestamp, 0, 'the stale snapshot is not marked fresh');
  assert.equal(handler.components[0].status, snapshot);
  assert.deepEqual(f.cloudCalls, [], 'a local network failure is reported directly');
  assert.equal(f.messages.filter(m => m.level === 'warn' || m.level === 'error').length, 0,
    'per-device warnings do not duplicate the client connection warning');
  const { SwitchService } = require('../dist/services/switchService');
  const service = Object.create(SwitchService.prototype);
  class HapStatusError extends Error { constructor(code) { super('HAP failure'); this.code = code; } }
  f.api.hap.HapStatusError = HapStatusError;
  f.api.hap.HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };
  Object.assign(service, { platform: f.platform, multiServiceAccessory: handler, componentId: 'main',
    deviceStatus: { status: snapshot }, log: f.platform.log });
  await assert.rejects(service.getSwitchState(), error => error instanceof HapStatusError && error.code === -70402);
  handler.platform = { getDeviceData: async () => { throw new Error('Invalid local status'); } };
  assert.equal(await handler.refreshStatus(), false);
  assert.equal(handler.failureCount, 5, 'ordinary device failures retain their existing handling');
  assert.equal(handler.isOnline(), false);
});

test('a local discovery outage preserves known IDs and protects requests when IDs are unknown', async t => {
  const f = setup(t);
  const failure = new LocalHubUnavailableError('ENETUNREACH', Date.now() + 30000);
  const ids = new Set(['a']);
  f.platform.localDeviceIds = ids;
  f.platform.localHub.getDeviceIds = async () => { throw failure; };
  f.platform.localHub.unavailableError = failure;
  await f.platform.refreshLocalDeviceIds();
  assert.equal(f.platform.localDeviceIds, ids);
  assert.equal(f.platform.localDiscoveryRetryAt, failure.retryAt);
  f.platform.localDeviceIds = undefined;
  await assert.rejects(f.platform.getDeviceData('a', 'status'), LocalHubUnavailableError);
  await assert.rejects(f.platform.sendDeviceCommands('a', [{ capability: 'switch', command: 'on' }]), LocalHubUnavailableError);
  assert.deepEqual(f.cloudCalls, []);
  assert.equal(f.messages.filter(m => m.level === 'warn' || m.level === 'error').length, 0);
});

test('initial discovery fetches cloud metadata and subsequent discovery uses cached metadata', async t => {
  const f = setup(t);
  f.platform.axInstance.get = async p => { f.cloudCalls.push(p); return { data: { items: [device('a')] } }; };
  assert.deepEqual(await f.platform.getOnlineDevices(), [device('a')]);
  assert.deepEqual(f.cloudCalls, ['devices']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'smartthings-device-metadata.json'))), [device('a')]);
  f.cloudCalls.length = 0;
  assert.deepEqual(await f.platform.getOnlineDevices(), [device('a')]);
  assert.deepEqual(f.cloudCalls, []);
});

test('new local ID refreshes the catalog and retains cached entries absent from cloud result', async t => {
  const f = setup(t);
  cache(f.directory, [device('old')]);
  f.platform.axInstance.get = async p => { f.cloudCalls.push(p); return { data: { items: [device('a')] } }; };
  assert.deepEqual((await f.platform.getOnlineDevices()).map(d => d.deviceId).sort(), ['a', 'old']);
  assert.deepEqual(f.cloudCalls, ['devices']);
});

test('Matter devices remain excluded in local and cloud discovery', async t => {
  const f = setup(t);
  const matter = { ...device('matter'), type: 'MATTER' };
  cache(f.directory, [device('a'), matter]);
  assert.deepEqual((await f.platform.getOnlineDevices()).map(d => d.deviceId), ['a']);
  f.platform.localHub = undefined;
  f.platform.axInstance.get = async () => ({ data: { items: [device('a'), matter] } });
  assert.deepEqual((await f.platform.getOnlineDevices()).map(d => d.deviceId), ['a']);
});

test('restored Homebridge metadata supports offline startup and unknown IDs are reported', async t => {
  const f = setup(t);
  f.platform.accessories.push({ UUID: 'old', context: { device: device('old') } });
  assert.deepEqual(await f.platform.getOnlineDevices(), [device('old')]);
  assert.deepEqual(f.cloudCalls, ['devices']);
  assert.ok(f.messages.some(m => m.message.includes('Some local devices have no cached cloud metadata')));
});

test('local discovery failure falls back to cloud and backs off further local attempts', async t => {
  const f = setup(t);
  f.platform.localHub.getDeviceIds = async () => { f.localCalls.push('/devices'); throw new Error('hub unavailable'); };
  f.platform.axInstance.get = async p => { f.cloudCalls.push(p); return { data: p === 'devices' ? { items: [device('a')] } : status('off') }; };
  assert.deepEqual(await f.platform.getOnlineDevices(), [device('a')]);
  assert.deepEqual(await f.platform.getDeviceData('a', 'status'), status('off'));
  assert.deepEqual(f.localCalls, ['/devices']);
  assert.deepEqual(f.cloudCalls, ['devices', 'devices/a/status']);
});

test('status and health use local for known IDs and cloud for unsupported or malformed responses', async t => {
  const f = setup(t);
  cache(f.directory, [device('a'), device('cloud')]);
  await f.platform.getOnlineDevices();
  f.platform.axInstance.get = async p => {
    f.cloudCalls.push(p);
    return { data: p.endsWith('/health') ? { state: 'ONLINE' } : status('off') };
  };
  assert.deepEqual(await f.platform.getDeviceData('a', 'status'), status('on'));
  assert.deepEqual(await f.platform.getDeviceData('cloud', 'status'), status('off'));
  f.platform.localHub.get = async p => { f.localCalls.push(p); return { state: 4 }; };
  assert.deepEqual(await f.platform.getDeviceData('a', 'health'), { state: 'ONLINE' });
  assert.deepEqual(f.cloudCalls, ['devices/cloud/status', 'devices/a/health']);
});

test('cloud fallback has a finite timeout', t => {
  const f = setup(t);
  const api = { hap: { Service: {}, Characteristic: {} }, user: { storagePath: () => f.directory }, on() {} };
  const p = new IKHomeBridgeHomebridgePlatform(f.platform.log, f.platform.config, api);
  assert.ok(p.axInstance.defaults.timeout > 0 && p.axInstance.defaults.timeout <= 5000);
});

test('accessory falls back to cloud when local status lacks a required component', async t => {
  const f = setup(t);
  cache(f.directory, [device('a')]);
  await f.platform.getOnlineDevices();
  f.platform.localHub.get = async p => p.endsWith('/health') ? { state: 'ONLINE' } : { components: {} };
  f.platform.axInstance.get = async p => { f.cloudCalls.push(p); return { data: status('off') }; };
  const info = { setCharacteristic() { return this; } };
  const accessory = { UUID: 'a', context: { device: device('a') }, getService: () => info };
  const handler = new MultiServiceAccessory(f.platform, accessory);
  handler.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handler.isOnline(), true);
  assert.equal(await handler.refreshStatus(), true);
  assert.deepEqual(handler.components[0].status, status('off').components.main);
  assert.deepEqual(f.cloudCalls, ['devices/a/status']);
});

test('a null local saturation does not prevent reading a valid switch without cloud', async t => {
  const f = setup(t);
  await f.platform.refreshLocalDeviceIds();
  f.platform.localHub.get = async p => p.endsWith('/health') ? { state: 'ONLINE' } : {
    components: { main: { switch: { switch: { value: 'on' } },
      colorControl: { hue: { value: 42 }, saturation: { value: null } } } },
  };
  const info = { setCharacteristic() { return this; } };
  const accessory = { UUID: 'a', context: { device: device('a') }, getService: () => info };
  const handler = new MultiServiceAccessory(f.platform, accessory);
  handler.components.push({ componentId: 'main', capabilities: ['switch', 'colorControl'], status: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await handler.refreshStatus(), true);
  assert.equal(handler.components[0].status.switch.switch.value, 'on');
  assert.equal(handler.components[0].status.colorControl.saturation.value, null);
  assert.deepEqual(f.cloudCalls, []);
});

test('location exclusions use cached location metadata when cloud is unavailable', async t => {
  const f = setup(t, { IgnoreLocations: ['Private'] });
  cache(f.directory, [device('a', 'a', 'private-id'), device('b', 'b', 'other-id')]);
  fs.writeFileSync(path.join(f.directory, 'smartthings-location-metadata.json'),
    JSON.stringify([{ locationId: 'private-id', name: 'Private' }]));
  await f.platform.getLocationsToIgnore();
  assert.deepEqual((await f.platform.getOnlineDevices()).map(d => d.deviceId), ['b']);
});

test('local mode unregisters explicit exclusions but retains devices absent from local list', async t => {
  const f = setup(t, { IgnoreDevices: ['ignored'] });
  cache(f.directory, [device('a'), device('ignored'), device('absent')]);
  const ignored = { UUID: 'ignored', context: { device: device('ignored') } };
  const absent = { UUID: 'absent', context: { device: device('absent') } };
  f.platform.accessories.push(ignored, absent);
  const removed = [];
  f.api.unregisterPlatformAccessories = (_plugin, _platform, accessories) => removed.push(...accessories);
  f.platform.discoverDevices = () => {};
  // Capture the normal launch callback from a fresh instance using the same fake API.
  let launch;
  f.api.on = (_event, handler) => { launch = handler; };
  const second = new IKHomeBridgeHomebridgePlatform(f.platform.log, f.platform.config, f.api);
  second.localHub = f.platform.localHub;
  second.axInstance = f.platform.axInstance;
  second.accessories.push(ignored, absent);
  second.discoverDevices = () => {};
  await launch();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, [ignored]);
});

test('an accessory initially offline checks health and recovers on demand', async t => {
  const f = setup(t);
  cache(f.directory, [device('a')]);
  await f.platform.getOnlineDevices();
  let online = false;
  f.platform.localHub.get = async () => ({ state: online ? 'ONLINE' : 'OFFLINE' });
  const info = { setCharacteristic() { return this; } };
  const accessory = { UUID: 'a', context: { device: device('a') }, getService: () => info };
  const handler = new MultiServiceAccessory(f.platform, accessory);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handler.isOnline(), false);
  assert.equal(await handler.ensureOnline(), false);
  online = true;
  assert.equal(await handler.ensureOnline(), true);
  assert.equal(handler.isOnline(), true);
});

test('a missing attribute stays local while zero is a valid local value', async t => {
  const f = setup(t);
  cache(f.directory, [device('a')]);
  await f.platform.getOnlineDevices();
  let local = { components: { main: { switch: {} } } };
  f.platform.localHub.get = async p => p.endsWith('/health') ? { state: 'ONLINE' } : local;
  f.platform.axInstance.get = async p => { f.cloudCalls.push(p); return { data: status('off') }; };
  const info = { setCharacteristic() { return this; } };
  const accessory = { UUID: 'a', context: { device: device('a') }, getService: () => info };
  const handler = new MultiServiceAccessory(f.platform, accessory);
  handler.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await handler.refreshStatus(), true);
  assert.deepEqual(handler.components[0].status, { switch: {} });
  assert.deepEqual(f.cloudCalls, []);

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 31000);
  local = status(0);
  handler.forceNextStatusRefresh();
  assert.equal(await handler.refreshStatus(), true);
  assert.equal(handler.components[0].status.switch.switch.value, 0);
  assert.deepEqual(f.cloudCalls, []);
});

test('a missing local color attribute does not block switch and rejects only that characteristic', async t => {
  const f = setup(t);
  await f.platform.refreshLocalDeviceIds();
  f.platform.localHub.get = async p => p.endsWith('/health') ? { state: 'ONLINE' } : {
    components: { main: { switch: { switch: { value: 'on' } }, colorControl: { hue: { value: 42 } } } },
  };
  const info = { setCharacteristic() { return this; } };
  const accessory = { UUID: 'a', context: { device: device('a') }, getService: () => info };
  const handler = new MultiServiceAccessory(f.platform, accessory);
  handler.components.push({ componentId: 'main', capabilities: ['switch', 'colorControl'], status: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await handler.refreshStatus(), true);
  const { LightService } = require('../dist/services/lightService');
  const light = Object.create(LightService.prototype);
  light.platform = { api: { hap: { HapStatusError: class extends Error {} } } };
  light.log = { debug() {} }; light.name = 'test';
  light.deviceStatus = handler.components[0]; light.currentColor = { hue: 0, saturation: 0 };
  light.getStatus = async () => true;
  assert.equal(await light.getSwitchState(), true);
  await assert.rejects(light.getSaturation());
  assert.deepEqual(f.cloudCalls, []);
});

test('local resource failures back off independently and recover after retry', async t => {
  const f = setup(t);
  cache(f.directory, [device('a'), device('b')]);
  f.platform.localHub.getDeviceIds = async () => new Set(['a', 'b']);
  await f.platform.getOnlineDevices();
  let failed = true;
  f.platform.localHub.get = async p => {
    f.localCalls.push(p);
    if (failed && p === '/devices/a/status') throw new Error('Local hub connection failed');
    return p.endsWith('/health') ? { state: 'ONLINE' } : status('on');
  };
  f.platform.axInstance.get = async p => { f.cloudCalls.push(p); return { data: status('off') }; };
  assert.deepEqual(await f.platform.getDeviceData('a', 'status'), status('off'));
  assert.deepEqual(await f.platform.getDeviceData('a', 'status'), status('off'));
  assert.deepEqual(await f.platform.getDeviceData('a', 'health'), { state: 'ONLINE' });
  assert.deepEqual(await f.platform.getDeviceData('b', 'status'), status('on'));
  assert.equal(f.localCalls.filter(p => p === '/devices/a/status').length, 1);
  failed = false;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 31000);
  assert.deepEqual(await f.platform.getDeviceData('a', 'status'), status('on'));
  assert.equal(f.localCalls.filter(p => p === '/devices/a/status').length, 2);
});

test('repeated malformed sensor status does not remove the service and later recovers', async t => {
  const f = setup(t);
  const { SensorService } = require('../dist/services/sensorService');
  f.platform.Service.Switch = class {};
  f.platform.api.hap.HAPStatus = { INVALID_VALUE_IN_REQUEST: 1 };
  f.platform.api.hap.HapStatusError = class extends Error {};
  let removed = 0;
  const accessory = { removeService: () => { removed++; } };
  const component = { status: {} };
  const sensor = new SensorService(f.platform, accessory, 'main', [], {}, 'sensor', component);
  sensor.getStatus = async () => true;
  sensor.statusTranslation = value => value.motionSensor.motion.value;
  for (let i = 0; i < 7; i++) await assert.rejects(sensor.getSensorState());
  assert.equal(removed, 0);
  component.status = { motionSensor: { motion: { value: 'active' } } };
  assert.equal(await sensor.getSensorState(), 'active');
});
