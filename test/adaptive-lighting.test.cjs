const { test } = require('node:test');
const assert = require('node:assert/strict');
const hap = require(process.env.HAP_NODEJS_MODULE || '@homebridge/hap-nodejs');
const { LightService } = require('../dist/services/lightService');

function fixture({ selected = true, capabilities = ['switch', 'switchLevel', 'colorTemperature'], state = 'on' } = {}) {
  const accessory = new hap.Accessory('Test lamp', hap.uuid.generate('adaptive-test'));
  accessory.context = { device: { label: 'Test lamp', components: [{ id: 'main', capabilities: capabilities.map(id => ({ id })) }] } };
  const status = { status: { switch: { switch: { value: state } }, colorTemperature: {
    colorTemperatureRange: { value: { minimum: 2203, maximum: 4000 }, unit: 'K' },
  } } };
  const commands = [];
  const multi = { sendCommands: async (...args) => { commands.push(args); return true; } };
  const platform = { Service: hap.Service, Characteristic: hap.Characteristic, api: { hap },
    config: { AdaptiveLightingDevices: selected ? ['Test lamp'] : [], LocalHubEvents: true, LocalHubTokenFile: '/local' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    getLocalStatus: async () => ({ components: { main: { switch: { switch: { value: status.status.switch.switch.value } } } } }),
  };
  const service = new LightService(platform, accessory, 'main', capabilities, multi, 'Test lamp', status);
  return { accessory, status, service, platform, commands };
}

test('adds a real HomeKit transition controller only to selected tunable-white lights', () => {
  const f = fixture();
  assert.ok(f.service.adaptiveLighting instanceof hap.AdaptiveLightingController);
  assert.equal(f.service.service.testCharacteristic(hap.Characteristic.CharacteristicValueTransitionControl), true);
  assert.equal(fixture({ selected: false }).service.adaptiveLighting, undefined);
  assert.equal(fixture({ capabilities: ['switch', 'switchLevel', 'colorTemperature', 'colorControl'] }).service.adaptiveLighting, undefined);
});

test('adaptive writes are local only, respect the device range, and ignore their own events', async () => {
  const f = fixture();
  const controller = f.service.adaptiveLighting;
  controller.isAdaptiveLightingActive = () => true;
  let disabled = false;
  controller.disableAdaptiveLighting = () => { disabled = true; };
  await f.service.setColorTemp(200, { controller });
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0][0][0].capability, 'colorTemperature');
  assert.deepEqual(f.commands[0][0][0].arguments, [4000]);
  assert.equal(f.commands[0][2], true);
  f.service.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 4000, eventTime: Date.now() });
  assert.equal(disabled, false);
  f.service.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 2700, eventTime: Date.now() });
  assert.equal(disabled, true);
});

test('never writes to an off or unknown light, and applies pending temperature after it turns on', async () => {
  const f = fixture({ state: 'off' });
  const controller = f.service.adaptiveLighting;
  controller.isAdaptiveLightingActive = () => true;
  await f.service.setColorTemp(300, { controller });
  assert.equal(f.commands.length, 0);
  f.status.status.switch.switch.value = 'on';
  f.service.processEvent({ capability: 'switch', attribute: 'switch', value: 'on', eventTime: Date.now() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0][0][0].arguments, [3333]);
});

test('rechecks on state locally before a write and does not use cloud on failure', async () => {
  const f = fixture();
  const controller = f.service.adaptiveLighting;
  controller.isAdaptiveLightingActive = () => true;
  f.platform.getLocalStatus = async () => ({ components: { main: { switch: { switch: { value: 'off' } } } } });
  await f.service.setColorTemp(300, { controller });
  assert.equal(f.commands.length, 0);
  f.platform.getLocalStatus = async () => { throw Error('local hub unavailable'); };
  await assert.rejects(f.service.setColorTemp(300, { controller }));
  assert.equal(f.commands.length, 0);
});

test('a restored HomeKit transition drives the local color temperature setter', async () => {
  const f = fixture();
  const controller = f.service.adaptiveLighting;
  controller.deserialize({ activeTransition: {
    iid: 1, transitionStartMillis: Date.now() - 1000, timeMillisOffset: 0,
    transitionId: 'test', transitionStartBuffer: '0000000000000000',
    brightnessCharacteristicIID: 2, brightnessAdjustmentRange: { minBrightnessValue: 0, maxBrightnessValue: 100 },
    transitionCurve: [
      { temperature: 300, brightnessAdjustmentFactor: 0, transitionTime: 0 },
      { temperature: 300, brightnessAdjustmentFactor: 0, transitionTime: 3600000 },
    ], updateInterval: 60000, notifyIntervalThreshold: 600000,
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0][0][0].arguments, [3333]);
  assert.ok(controller.serialize().activeTransition);
  controller.disableAdaptiveLighting();
  assert.equal(controller.serialize(), undefined);
});
