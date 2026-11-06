const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: tick } = require('node:timers/promises');
const hap = require(process.env.HAP_NODEJS_MODULE || '@homebridge/hap-nodejs');
const { LightService } = require('../dist/services/lightService');
const { MultiServiceAccessory } = require('../dist/multiServiceAccessory');
const { Command } = require('../dist/services/smartThingsCommand');

function fixture(t) {
  const accessory = new hap.Accessory('Test lamp', hap.uuid.generate('local-brightness'));
  const capabilities = ['switch', 'switchLevel', 'colorTemperature'];
  accessory.context = { device: { label: 'Test lamp', components: [{ id: 'main', capabilities: capabilities.map(id => ({ id })) }] } };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const sent = [];
  const pending = [];
  const component = { componentId: 'main', capabilities, status: { switch: { switch: { value: 'on' } },
    switchLevel: { level: { value: 10 } } } };
  const platform = { config: {}, Service: hap.Service, Characteristic: hap.Characteristic, api: { hap }, log,
    isKnownLocalDevice: () => true, hasLocalEventsFor: () => true,
    getLocalStatus: async () => ({ components: { main: component.status } }),
    sendDeviceCommands: (_id, commands) => {
      sent.push(commands.map(c => [c.command, ...(c.arguments ?? [])]));
      return new Promise((resolve, reject) => pending.push({ resolve: () => resolve('local'), reject }));
    } };
  const multi = Object.create(MultiServiceAccessory.prototype);
  Object.assign(multi, { accessory, platform, log, name: 'Test lamp', components: [component],
    eventIds: new Set(), eventAttributes: new Map(), eventRevision: 0, online: true });
  const service = new LightService(platform, accessory, 'main', capabilities, multi, 'Test lamp', component);
  multi.services = [service];
  const brightness = service.service.getCharacteristic(hap.Characteristic.Brightness);
  brightness.updateValue(10);
  const level = value => multi.processEvent({ deviceId: accessory.UUID, componentId: 'main',
    capability: 'switchLevel', attribute: 'level', value });
  t.after(() => service.clearBrightnessTarget());
  return { service, platform, multi, component, brightness, level, sent, pending };
}

test('HomeKit acknowledges every gesture immediately but the hub receives only the latest waiting level', async t => {
  const f = fixture(t);
  await f.brightness.handleSetRequest(40);
  assert.deepEqual(f.sent, [[['setLevel', 40, 0]]]);
  await f.brightness.handleSetRequest(50);
  await f.brightness.handleSetRequest(80);
  assert.equal(f.pending.length, 1);
  f.level(40);
  assert.equal(f.component.status.switchLevel.level.value, 40, 'physical state is retained');
  assert.equal(f.brightness.value, 80);
  assert.equal(await f.brightness.handleGetRequest(), 80);
  f.pending.shift().resolve();
  await tick();
  assert.deepEqual(f.sent, [[['setLevel', 40, 0]], [['setLevel', 80, 0]]]);
  f.pending.shift().resolve();
  await tick();
  f.level(65);
  assert.equal(f.brightness.value, 80);
  f.level(80);
  f.level(90);
  assert.equal(f.brightness.value, 90, 'external changes are visible once the target is confirmed');
});

test('a queued brightness write keeps rate zero when a newer level replaces it', async t => {
  const f = fixture(t);
  const earlier = f.multi.sendCommands([new Command('switch', 'on')]);
  await f.brightness.handleSetRequest(50);
  await f.brightness.handleSetRequest(2);
  assert.deepEqual(f.sent, [[['on']]]);

  f.pending.shift().resolve();
  await earlier;
  await tick();

  assert.deepEqual(f.sent, [[['on']], [['setLevel', 2, 0]]]);
  f.pending.shift().resolve();
  await tick();
});

test('off drops the waiting level and finishes after the in-flight brightness command', async t => {
  const f = fixture(t);
  await f.service.setLevel(40);
  await f.service.setLevel(80);
  const off = f.service.setSwitchState(false);
  await f.service.setLevel(3);
  f.pending.shift().resolve();
  await tick();
  assert.deepEqual(f.sent, [[['setLevel', 40, 0]], [['off']]]);
  f.pending.shift().resolve();
  await off;
  assert.equal(f.pending.length, 0);
});

test('a repeated HomeKit brightness zero after off acceptance sends no level command', async t => {
  const f = fixture(t);
  const on = f.service.service.getCharacteristic(hap.Characteristic.On);
  const off = on.handleSetRequest(false);
  await f.brightness.handleSetRequest(0);
  f.pending.shift().resolve();
  await off;

  await f.brightness.handleSetRequest(0);

  assert.deepEqual(f.sent, [[['off']]]);
});

test('off cancels a brightness write already waiting in the device queue', async t => {
  const f = fixture(t);
  const earlier = f.multi.sendCommands([new Command('switch', 'on')]);
  await f.service.setLevel(40);
  await f.service.setLevel(80);
  const off = f.service.setSwitchState(false);
  f.pending.shift().resolve();
  await earlier;
  await tick();
  assert.deepEqual(f.sent, [[['on']], [['off']]]);
  f.pending.shift().resolve();
  await off;
});

test('off cancels an Adaptive Lighting write that was checked while on but has not been sent', async t => {
  const f = fixture(t);
  const earlier = f.multi.sendCommands([new Command('switch', 'on')]);
  const controller = { isAdaptiveLightingActive: () => true };
  f.service.adaptiveLighting = controller;
  const adaptive = f.service.setColorTemp(250, { controller });
  await tick();
  const off = f.service.setSwitchState(false);
  f.pending.shift().resolve();
  await Promise.all([earlier, adaptive]);
  await tick();
  assert.deepEqual(f.sent, [[['on']], [['off']]]);
  f.pending.shift().resolve();
  await off;
});

test('a failed write reconciles the actual local level once without replaying the command', async t => {
  const f = fixture(t);
  let reads = 0;
  f.platform.getLocalStatus = async () => { reads++; return { components: { main: { switchLevel: { level: { value: 17 } } } } }; };
  await f.brightness.handleSetRequest(80);
  f.pending.shift().reject(new Error('no response'));
  await tick();
  assert.equal(f.brightness.value, 17);
  assert.equal(await f.brightness.handleGetRequest(), 17);
  assert.equal(reads, 1);
  assert.deepEqual(f.sent, [[['setLevel', 80, 0]]]);
});

test('an accepted write without confirmation reconciles once using a fresh local read', async t => {
  const f = fixture(t);
  const setTimeoutReal = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => setTimeoutReal(fn, ms === 2000 ? 1 : ms, ...args));
  let read;
  let reads = 0;
  const snapshotRequested = new Promise(resolve => { read = resolve; });
  f.platform.getLocalStatus = async () => {
    reads++;
    read();
    return { components: { main: { switchLevel: { level: { value: 73 } } } } };
  };
  await f.brightness.handleSetRequest(80);
  f.pending.shift().resolve();
  // The production confirmation timer is unref'ed. Keep this test alive while it fires.
  const timeout = setTimeoutReal(() => {}, 1000);
  try { await snapshotRequested; } finally { clearTimeout(timeout); }
  await tick();
  assert.equal(f.brightness.value, 73);
  assert.equal(reads, 1);
  assert.deepEqual(f.sent, [[['setLevel', 80, 0]]]);
});
