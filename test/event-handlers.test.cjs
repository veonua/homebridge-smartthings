'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MultiServiceAccessory } = require('../dist/multiServiceAccessory');
const { BatteryService } = require('../dist/services/batteryService');
const { LightService } = require('../dist/services/lightService');
const { BaseService } = require('../dist/services/baseService');
const { TemperatureService } = require('../dist/services/temperatureService');
const { ThermostatService } = require('../dist/services/thermostatService');
const { AirConditionerService } = require('../dist/services/airConditionerService');
const { StatelessProgrammableSwitchService } = require('../dist/services/statelessProgrammableSwitchService');

const characteristic = {
  On: 'on', Brightness: 'brightness', ColorTemperature: 'colorTemperature',
  BatteryLevel: 'battery', StatusLowBattery: { BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0 },
  CurrentTemperature: 'temperature', TargetTemperature: 'targetTemperature',
  TargetHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
  ProgrammableSwitchEvent: { SINGLE_PRESS: 0, DOUBLE_PRESS: 1, LONG_PRESS: 2 },
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function fakeService() {
  const service = new EventEmitter();
  service.updates = [];
  service.setCharacteristic = function() { return this; };
  service.updateCharacteristic = function(...args) { this.updates.push(args); this.emit('characteristic-change', {}); return this; };
  service.getCharacteristic = () => ({ onGet() {} });
  return service;
}
function handler() {
  const info = fakeService();
  const accessory = { UUID: 'dev', context: { device: { deviceId: 'dev', label: 'Test' } },
    services: [info], getService: () => info };
  const platform = { log: logger, config: { BaseURL: 'https://example.invalid/', AccessToken: 'unused' },
    Characteristic: characteristic, Service: { AccessoryInformation: 'info' }, api: {},
    getDeviceData: async (_id, type) => type === 'health' ? { state: 'ONLINE' } : { components: {} } };
  const h = new MultiServiceAccessory(platform, accessory);
  return { h, accessory, platform };
}
function ev(overrides = {}) {
  return { deviceId: 'dev', componentId: 'main', capability: 'switch', attribute: 'switch', value: 'on', ...overrides };
}
function installService(h, accessory, capability, action) {
  const output = fakeService(); accessory.services.push(output);
  h.services.push({ componentId: 'main', capabilities: [capability], processEvent: e => action(output, e) });
  return output;
}

test('electrical events update cached measurements and notify Matter', () => {
  const { h, platform } = handler();
  const updates = [];
  platform.updateMatterState = (_device, component, capability) => updates.push([component, capability]);
  h.components.push({ componentId: 'main', capabilities: ['powerMeter', 'energyMeter', 'voltageMeasurement', 'currentMeasurement'], status: {} });
  for (const [capability, attribute, value, unit] of [
    ['powerMeter', 'power', 1027, 'W'], ['energyMeter', 'energy', 0.088, 'kWh'],
    ['voltageMeasurement', 'voltage', 235, 'V'], ['currentMeasurement', 'current', 4.451, 'A'],
  ]) {
    h.processEvent(ev({ capability, attribute, value, unit }));
    assert.equal(h.components[0].status[capability][attribute].value, value);
    assert.equal(h.components[0].status[capability][attribute].unit, unit);
  }
  assert.deepEqual(updates.map(item => item[1]), ['powerMeter', 'energyMeter', 'voltageMeasurement', 'currentMeasurement']);
});

test('dispatches validated events to all matching services and returns actual update result', () => {
  const { h, accessory } = handler();
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  const a = installService(h, accessory, 'switch', (s, e) => s.updateCharacteristic(characteristic.On, e.value));
  const b = installService(h, accessory, 'switch', (s, e) => s.updateCharacteristic(characteristic.On, e.value));
  assert.equal(h.processEvent(ev({ eventId: 'one' })), true);
  assert.equal(a.updates.length, 1); assert.equal(b.updates.length, 1);
  assert.equal(h.components[0].status.switch.switch.value, 'on');
  assert.equal(h.processEvent(ev({ eventId: 'one' })), false);
  assert.equal(h.processEvent(ev({ attribute: 'other' })), false);
  assert.equal(h.processEvent(ev({ value: {} })), false);
  assert.equal(a.updates.length, 1);
  assert.equal(h.processEvent(ev({ deviceId: 'other' })), false);
  h.services = [{ componentId: 'main', capabilities: ['switch'], processEvent() {} }];
  assert.equal(h.processEvent(ev({ eventId: 'two' })), false);
});

test('snapshot cannot overwrite event received while request was in flight', async () => {
  const { h, accessory, platform } = handler();
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  installService(h, accessory, 'switch', (s, e) => s.updateCharacteristic(characteristic.On, e.value));
  let resolveSnapshot;
  platform.getDeviceData = async (_id, type) => type === 'health' ? { state: 'ONLINE' } : new Promise(resolve => { resolveSnapshot = resolve; });
  const pending = h.refreshStatus();
  await new Promise(resolve => setImmediate(resolve));
  h.processEvent(ev({ eventTime: Date.parse('2026-10-27T00:00:02Z') }));
  resolveSnapshot({ components: { main: { switch: { switch: { value: 'off', timestamp: '2026-10-27T00:00:01Z' } } } } });
  assert.equal(await pending, true);
  assert.equal(h.components[0].status.switch.switch.value, 'on');
  assert.equal(h.processEvent(ev({ value: 'off', eventTime: Date.parse('2026-10-27T00:00:01Z') })), false);
});

test('accepted local light commands use the cached snapshot until an event confirms the state', async () => {
  const { h, accessory, platform } = handler();
  let reads = 0;
  let connected = true;
  platform.hasLocalEventsFor = () => connected;
  platform.sendDeviceCommands = async () => 'local';
  platform.getDeviceData = async (_id, type) => {
    if (type === 'health') return { state: 'ONLINE' };
    reads++;
    return { components: { main: { switch: { switch: { value: 'off' } } } } };
  };
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  const light = Object.create(LightService.prototype);
  Object.assign(light, { platform, accessory, log: logger, name: 'Test', componentId: 'main', capabilities: ['switch'],
    deviceStatus: h.components[0], multiServiceAccessory: h, service: fakeService() });
  accessory.services.push(light.service);
  h.services.push(light);

  assert.equal(await light.getSwitchState(), false);
  assert.equal(reads, 1);
  await light.setSwitchState(true);
  assert.equal(await light.getSwitchState(), false, 'ACCEPTED is not a confirmed device state');
  assert.equal(reads, 1, 'a fresh snapshot must not be invalidated by the local command');
  assert.equal(h.processEvent(ev({ value: 'on' })), true);
  assert.equal(await light.getSwitchState(), true);
  assert.equal(reads, 1, 'the SSE event updates the cached value without a status request');

  h.deviceStatusTimestamp = Date.now() - 6000;
  assert.equal(await light.getSwitchState(), true);
  assert.equal(reads, 1, 'a recent SSE event is usable even when the snapshot is old');
  h.eventAttributes.get(JSON.stringify(['main', 'switch', 'switch'])).receivedAt = Date.now() - 6000;
  assert.equal(await light.getSwitchState(), false);
  assert.equal(reads, 2, 'an explicit read refreshes a snapshot older than the cache window');

  connected = false;
  await light.setSwitchState(false);
  assert.equal(await light.getSwitchState(), false);
  assert.equal(reads, 3, 'when events are disconnected the next read refreshes status');
});

test('a cloud command invalidates the snapshot even when local events are connected', async () => {
  const { h, platform } = handler();
  let reads = 0;
  platform.hasLocalEventsFor = () => true;
  platform.sendDeviceCommands = async () => 'cloud';
  platform.getDeviceData = async (_id, type) => {
    if (type === 'health') return { state: 'ONLINE' };
    reads++;
    return { components: { main: { switch: { switch: { value: 'off' } } } } };
  };
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  assert.equal(await h.refreshStatus(), true);
  assert.equal(await h.sendCommand('switch', 'on'), true);
  assert.equal(await h.refreshStatus(), true);
  assert.equal(reads, 2);
});

test('resync publishes state but never replays stateless button snapshots', async () => {
  const { h, accessory, platform } = handler();
  h.components.push({ componentId: 'main', capabilities: ['switch', 'button'], status: {} });
  const state = installService(h, accessory, 'switch', (s, e) => s.updateCharacteristic(characteristic.On, e.value));
  const button = installService(h, accessory, 'button', (s, e) => s.updateCharacteristic(characteristic.ProgrammableSwitchEvent, e.value));
  platform.getDeviceData = async (_id, type) => type === 'health' ? { state: 'ONLINE' } :
    { components: { main: { switch: { switch: { value: 'off' } }, button: { button: { value: 'pushed' } } } } };
  assert.equal(await h.resyncState(), true);
  assert.deepEqual(state.updates, [['on', 'off']]);
  assert.deepEqual(button.updates, []);
});

test('battery and color temperature handlers use event values', () => {
  const bat = Object.create(BatteryService.prototype); bat.platform = { Characteristic: characteristic }; bat.service = fakeService();
  bat.processEvent(ev({ capability: 'battery', attribute: 'battery', value: 30 }));
  assert.deepEqual(bat.service.updates, [['battery', 30], [characteristic.StatusLowBattery, 1]]);
  const light = Object.create(LightService.prototype); light.platform = { Characteristic: characteristic }; light.service = fakeService();
  light.deviceStatus = { status: { colorTemperature: { colorTemperature: { value: 1000 } } } }; light.log = logger; light.name = 'light';
  light.processEvent(ev({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 6500 }));
  assert.deepEqual(light.service.updates, [['colorTemperature', 154]]);
});

test('saturation rejects invalid status instead of sending null to HomeKit', async () => {
  const { Service, Characteristic, HapStatusError, HAPStatus } = require(process.env.HAP_NODEJS_MODULE || '@homebridge/hap-nodejs');
  const light = Object.create(LightService.prototype);
  light.platform = { Characteristic, api: { hap: { HapStatusError, HAPStatus } } };
  light.service = new Service.Lightbulb('Test');
  light.log = logger; light.name = 'light'; light.currentColor = { hue: 10, saturation: 30 };
  light.getStatus = async () => true;
  const hapSaturation = light.service.getCharacteristic(Characteristic.Saturation).onGet(light.getSaturation.bind(light));
  for (const value of [null, undefined, '30', NaN, -1, 101]) {
    light.deviceStatus = { status: { colorControl: { saturation: { value } } } };
    await assert.rejects(hapSaturation.handleGetRequest());
    assert.notEqual(hapSaturation.value, null);
    assert.equal(light.currentColor.saturation, 30);
  }
  light.deviceStatus = { status: {} };
  await assert.rejects(hapSaturation.handleGetRequest());
  for (const value of [0, 75, 100]) {
    light.deviceStatus = { status: { colorControl: { saturation: { value } } } };
    assert.equal(await hapSaturation.handleGetRequest(), value);
  }
  light.processEvent(ev({ capability: 'colorControl', attribute: 'saturation', value: null }));
  assert.equal(hapSaturation.value, 100);
  light.processEvent(ev({ capability: 'colorControl', attribute: 'saturation', value: 25 }));
  assert.equal(hapSaturation.value, 25);
  assert.equal(light.currentColor.saturation, 25);
});

test('combined light receives hue, saturation and color temperature events', t => {
  const { h, accessory } = handler();
  accessory.context.device.components = [{ id: 'main', capabilities:
    ['switch', 'switchLevel', 'colorControl', 'colorTemperature'].map(id => ({ id })) }];
  h.platform.Service.Switch = function() {};
  h.platform.Service.Lightbulb = function() {};
  h.platform.Characteristic = { ...characteristic, Hue: 'hue', Saturation: 'saturation' };
  t.mock.method(BaseService.prototype, 'setServiceType', function() {
    this.service = fakeService();
    this.service.getCharacteristic = () => ({ onGet() { return this; }, onSet() { return this; } });
    accessory.services.push(this.service);
  });
  t.mock.method(LightService.prototype, 'getHue', async () => 0);
  t.mock.method(LightService.prototype, 'getSaturation', async () => 0);
  h.addComponent('main', ['switch', 'switchLevel', 'colorControl', 'colorTemperature']);
  const light = h.services[0];
  assert.equal(h.processEvent(ev({ capability: 'colorControl', attribute: 'hue', value: 50 })), true);
  assert.equal(h.processEvent(ev({ capability: 'colorControl', attribute: 'saturation', value: 55 })), true);
  assert.equal(h.processEvent(ev({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 6500 })), true);
  assert.deepEqual(light.service.updates, [['hue', 180], ['saturation', 55], ['colorTemperature', 154]]);
  assert.deepEqual(light.currentColor, { hue: 50, saturation: 55 });
});

test('configured combined-color light sends one setColor command with the other color preserved', async t => {
  const { h, accessory } = handler();
  accessory.context.device.components = [{ id: 'main', capabilities: ['switch', 'colorControl'].map(id => ({ id })) }];
  h.platform.config.SetColorDevices = [' DEV '];
  h.platform.Service.Switch = function() {};
  h.platform.Service.Lightbulb = function() {};
  t.mock.method(BaseService.prototype, 'setServiceType', function() {
    this.service = fakeService();
    this.service.getCharacteristic = () => ({ onGet() { return this; }, onSet() { return this; } });
    accessory.services.push(this.service);
  });
  t.mock.method(LightService.prototype, 'getHue', async () => 0);
  t.mock.method(LightService.prototype, 'getSaturation', async () => 0);
  const calls = [];
  h.ensureOnline = async () => true;
  h.sendCommand = async (...args) => { calls.push(args); return true; };
  h.addComponent('main', ['switch', 'colorControl']);
  const light = h.services[0];
  light.currentColor = { hue: 10, saturation: 20 };
  await light.setHue(180);
  assert.deepEqual(calls, [['colorControl', 'setColor', [{ hue: 50, saturation: 20 }], 'main']]);
});

test('temperature and thermostat only publish temperatures with known units', () => {
  const sensor = Object.create(TemperatureService.prototype); sensor.platform = { Characteristic: characteristic }; sensor.service = fakeService();
  sensor.deviceStatus = { status: {} }; sensor.log = logger; sensor.name = 'sensor';
  sensor.processEvent(ev({ capability: 'temperatureMeasurement', attribute: 'temperature', value: 20 }));
  assert.deepEqual(sensor.service.updates, []);
  sensor.processEvent(ev({ capability: 'temperatureMeasurement', attribute: 'temperature', value: 68, unit: 'F' }));
  assert.deepEqual(sensor.service.updates, [['temperature', 20]]);
  const thermostat = Object.create(ThermostatService.prototype); thermostat.platform = { Characteristic: characteristic };
  thermostat.service = fakeService(); thermostat.deviceStatus = { status: {} }; thermostat.log = logger; thermostat.name = 'thermostat';
  thermostat.targetHeatingCoolingState = characteristic.TargetHeatingCoolingState.COOL;
  thermostat.processEvent(ev({ capability: 'temperatureMeasurement', attribute: 'temperature', value: 20, unit: 'C' }));
  thermostat.processEvent(ev({ capability: 'temperatureMeasurement', attribute: 'unrelated', value: 'bad' }));
  thermostat.processEvent(ev({ capability: 'thermostatCoolingSetpoint', attribute: 'coolingSetpoint', value: 68, unit: 'F' }));
  assert.deepEqual(thermostat.service.updates, [['temperature', 20], ['targetTemperature', 20]]);
});

test('air conditioner publishes temperature with unit and ignores unknown unit', () => {
  const ac = Object.create(AirConditionerService.prototype); ac.platform = { Characteristic: characteristic };
  ac.thermostatService = fakeService(); ac.deviceStatus = { status: {} }; ac.log = logger; ac.name = 'ac';
  ac.processEvent(ev({ capability: 'temperatureMeasurement', attribute: 'temperature', value: 20 }));
  ac.processEvent(ev({ capability: 'temperatureMeasurement', attribute: 'temperature', value: 68, unit: 'F' }));
  assert.deepEqual(ac.thermostatService.updates, [['temperature', 20]]);
});

test('button updates only from events, preserving SINGLE_PRESS zero and rejecting non-string', () => {
  const b = Object.create(StatelessProgrammableSwitchService.prototype); b.platform = { Characteristic: characteristic };
  b.service = fakeService(); b.log = logger; b.name = 'button';
  b.processEvent(ev({ capability: 'button', attribute: 'button', value: 'pushed' }));
  b.processEvent(ev({ capability: 'button', attribute: 'button', value: null }));
  assert.deepEqual(b.service.updates, [[characteristic.ProgrammableSwitchEvent, 0]]);
});

test('a fresh event during resync dispatch is not replaced by an older snapshot attribute', async () => {
  const { h, accessory, platform } = handler();
  h.components.push({ componentId: 'main', capabilities: ['colorControl'], status: {} });
  const seen = [];
  const output = installService(h, accessory, 'colorControl', (s, e) => {
    seen.push([e.attribute, e.value]);
    s.updateCharacteristic('color', e.value);
    if (e.attribute === 'hue') h.processEvent(ev({ capability: 'colorControl', attribute: 'saturation', value: 80 }));
  });
  platform.getDeviceData = async (_id, type) => type === 'health' ? { state: 'ONLINE' } :
    { components: { main: { colorControl: { hue: { value: 10 }, saturation: { value: 20 } } } } };
  assert.equal(await h.resyncState(), true);
  assert.deepEqual(seen, [['hue', 10], ['saturation', 80]]);
  assert.equal(h.components[0].status.colorControl.saturation.value, 80);
  assert.equal(output.updates.length, 2);
});

test('applied signal observes real HAP characteristic-change event without replacing service methods', () => {
  const { Service, Characteristic } = require(process.env.HAP_NODEJS_MODULE || '@homebridge/hap-nodejs');
  const { h, accessory } = handler();
  const light = new Service.Lightbulb('Test');
  accessory.services.push(light);
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  h.services.push({ componentId: 'main', capabilities: ['switch'], processEvent: e =>
    light.updateCharacteristic(Characteristic.On, e.value === 'on') });
  const original = light.updateCharacteristic;
  assert.equal(h.processEvent(ev()), true);
  assert.equal(light.getCharacteristic(Characteristic.On).value, true);
  assert.equal(light.updateCharacteristic, original);
  assert.equal(light.listenerCount('characteristic-change'), 0);
});

test('offline resync requires explicit ONLINE health before publishing snapshot', async () => {
  const { h, accessory, platform } = handler();
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  const output = installService(h, accessory, 'switch', (s, e) => s.updateCharacteristic(characteristic.On, e.value));
  await new Promise(resolve => setImmediate(resolve));
  h.online = false;
  let health = 'OFFLINE', reads = 0;
  platform.getDeviceData = async (_id, type) => {
    if (type === 'health') {
      if (health === 'ERROR') throw new Error('offline');
      return { state: health };
    }
    reads++;
    return { components: { main: { switch: { switch: { value: 'on' } } } } };
  };
  assert.equal(await h.resyncState(), false);
  assert.equal(h.isOnline(), false);
  assert.equal(reads, 0);
  assert.equal(output.updates.length, 0);
  health = 'ERROR';
  assert.equal(await h.resyncState(), false);
  assert.equal(h.isOnline(), false);
  assert.equal(reads, 0);
  health = 'ONLINE';
  assert.equal(await h.resyncState(), true);
  assert.equal(h.isOnline(), true);
  assert.equal(reads, 1);
  assert.deepEqual(output.updates, [['on', 'on']]);
});


test('valid event restores an offline device while invalid event cannot', () => {
  const { h } = handler();
  h.components.push({ componentId: 'main', capabilities: ['switch'], status: {} });
  h.online = false;
  h.processEvent(ev({ value: {} }));
  assert.equal(h.isOnline(), false);
  h.processEvent(ev());
  assert.equal(h.isOnline(), true);
});
