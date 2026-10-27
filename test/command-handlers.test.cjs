const assert = require('node:assert/strict');
const test = require('node:test');

class HapStatusError extends Error { constructor(code) { super('HAP error'); this.code = code; } }
const HAP_FAILURE = -70402;
const platform = {
  api: { hap: { HapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: HAP_FAILURE } } },
  Characteristic: {
    Active: { ACTIVE: 1 }, TargetDoorState: { CLOSED: 1 }, LockTargetState: {},
    TargetHeatingCoolingState: { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 },
  },
};
const log = { debug() {}, error() {}, info() {}, warn() {} };
const cases = [
  ['switchService', 'SwitchService', 'setSwitchState', true, ['switch', 'on', undefined]],
  ['lightService', 'LightService', 'setSwitchState', false, ['switch', 'off', undefined]],
  ['lightService', 'LightService', 'setLevel', 40, ['switchLevel', 'setLevel', [40]]],
  ['lightService', 'LightService', 'setColorTemp', 140, ['colorTemperature', 'setColorTemperature', [6501]]],
  ['lightService', 'LightService', 'setHue', 180, ['colorControl', 'setHue', [50]]],
  ['lightService', 'LightService', 'setSaturation', 55, ['colorControl', 'setSaturation', [55]]],
  ['fanSpeedService', 'FanSpeedService', 'setSwitchState', true, ['switch', 'on', undefined]],
  ['fanSpeedService', 'FanSpeedService', 'setLevel', 50, ['fanSpeed', 'setFanSpeed', [2]]],
  ['fanSwitchLevelService', 'FanSwitchLevelService', 'setSwitchState', true, ['switch', 'on', undefined]],
  ['fanSwitchLevelService', 'FanSwitchLevelService', 'setLevel', 40, ['switchLevel', 'setLevel', [40]]],
  ['lockService', 'LockService', 'setLockTargetState', 1, ['lock', 'lock', undefined]],
  ['doorService', 'DoorService', 'setTargetDoorState', 1, ['doorControl', 'close', undefined]],
  ['windowCoveringService', 'WindowCoveringService', 'setTargetPosition', 40, ['switchLevel', 'setLevel', [40]]],
  ['valveService', 'ValveService', 'setValveState', 1, ['valve', 'open', undefined]],
  ['thermostatService', 'ThermostatService', 'setTargetHeatingCoolingState', 2, ['thermostatMode', 'cool', undefined]],
  ['thermostatService', 'ThermostatService', 'setTargetTemperature', 20, ['thermostatCoolingSetpoint', 'setCoolingSetpoint', [68]]],
];
function makeService(file, type, sendCommand, online = true) {
  const Ctor = require(`../dist/services/${file}`)[type];
  const instance = Object.create(Ctor.prototype);
  Object.assign(instance, { platform, log, name: 'Test', accessory: { context: { device: { label: 'Test' } } },
    service: { updateCharacteristic() {} }, componentId: 'secondary',
    multiServiceAccessory: { isOnline: () => online, ensureOnline: async () => online, sendCommand, forceNextStatusRefresh() {} },
    capabilities: ['thermostatMode'], currentColor: { hue: 10, saturation: 20 }, requireSetColor: false,
    units: 'F', targetHeatingCoolingState: 2, useWindowShadeLevel: false,
  });
  return instance;
}
for (const [file, type, method, value, expected] of cases) {
  test(`${type}.${method} waits for the command and reports a failure`, async () => {
    let resolveCommand;
    const sent = [];
    const service = makeService(file, type, (...args) => { sent.push(args); return new Promise(r => { resolveCommand = r; }); });
    let settled = false;
    const pending = service[method](value).finally(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(sent, [[...expected, 'secondary']]);
    resolveCommand(false);
    await assert.rejects(pending, err => err instanceof HapStatusError && err.code === HAP_FAILURE);
    assert.equal(sent.length, 1, 'an uncertain failure must not cause another command');
    const rejected = makeService(file, type, async () => { throw Error('transport failure'); });
    await assert.rejects(rejected[method](value), err => err instanceof HapStatusError && err.code === HAP_FAILURE);
    const offline = makeService(file, type, () => assert.fail('offline command was sent'), false);
    await assert.rejects(offline[method](value), err => err instanceof HapStatusError && err.code === HAP_FAILURE);
    const ok = makeService(file, type, async () => true);
    await ok[method](value);
  });
}

test('light combined color mode awaits a command and reports false', async () => {
  const calls = [];
  const service = makeService('lightService', 'LightService', async (...args) => { calls.push(args); return false; });
  service.requireSetColor = true;
  await assert.rejects(service.setHue(180), err => err instanceof HapStatusError && err.code === HAP_FAILURE);
  assert.deepEqual(calls, [['colorControl', 'setColor', [{ hue: 50, saturation: 20 }], 'secondary']]);
});

test('failed door, lock and shade commands do not update requested targets', async () => {
  for (const [file, type, method, property] of [
    ['lockService', 'LockService', 'setLockTargetState', 'targetState'],
    ['doorService', 'DoorService', 'setTargetDoorState', 'targetState'],
    ['windowCoveringService', 'WindowCoveringService', 'setTargetPosition', 'targetPosition'],
  ]) {
    const service = makeService(file, type, async () => false);
    service[property] = 7;
    await assert.rejects(service[method](1));
    assert.equal(service[property], 7);
  }
});

test('air conditioner light and optional mode wait for failed commands', async () => {
  const service = makeService('airConditionerService', 'AirConditionerService', async () => true);
  service.optionalMode = 'quiet';
  service.multiServiceAccessory.sendCommands = async () => false;
  for (const method of ['setLightSwitchState', 'setLightBrightness', 'setOptionalModeSwitchState']) {
    await assert.rejects(service[method](1), err => err instanceof HapStatusError && err.code === HAP_FAILURE);
  }
});

test('an offline accessory is rechecked on demand before its next command', async () => {
  const calls = [];
  const service = makeService('switchService', 'SwitchService', async (...args) => { calls.push(args); return true; }, false);
  let rechecks = 0;
  service.multiServiceAccessory.ensureOnline = async () => { rechecks++; return true; };
  await service.setSwitchState(true);
  assert.equal(rechecks, 1);
  assert.deepEqual(calls, [['switch', 'on', undefined, 'secondary']]);
});

test('air conditioner forwards its component and rechecks online state', async () => {
  const service = makeService('airConditionerService', 'AirConditionerService', async () => true, false);
  let rechecks = 0;
  service.multiServiceAccessory.ensureOnline = async () => { rechecks++; return true; };
  let received;
  service.multiServiceAccessory.sendCommands = async (...args) => { received = args; return true; };
  await service.setLightBrightness(42);
  assert.equal(rechecks, 1);
  assert.equal(received[1], 'secondary');
  assert.deepEqual(received[0].map(({ capability, command, arguments: args }) => ({ capability, command, args })),
    [{ capability: 'switchLevel', command: 'setLevel', args: [42] }]);
});

test('thermostat mode event controls the capability of the next setpoint command', async () => {
  const calls = [];
  const service = makeService('thermostatService', 'ThermostatService', async (...args) => { calls.push(args); return true; });
  service.deviceStatus = { status: {} };
  service.targetHeatingCoolingState = 1;
  service.processEvent({ capability: 'thermostatMode', attribute: 'thermostatMode', value: 'cool' });
  await service.setTargetTemperature(20);
  assert.deepEqual(calls, [['thermostatCoolingSetpoint', 'setCoolingSetpoint', [68], 'secondary']]);
});

test('door event updates the cached target during the transition window', async () => {
  const service = makeService('doorService', 'DoorService', async () => true);
  service.platform = { ...platform, Characteristic: { ...platform.Characteristic,
    CurrentDoorState: { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3 },
    TargetDoorState: { OPEN: 0, CLOSED: 1 },
  } };
  service.targetState = 0;
  service.doorInTransitionStart = Date.now();
  service.processEvent({ value: 'closed' });
  assert.equal(await service.getTargetDoorState(), 1);
});

for (const [file, type, method, status, expected] of [
  ['lightService', 'LightService', 'getLevel', { switchLevel: { level: { value: 42 } } }, 42],
  ['fanSwitchLevelService', 'FanSwitchLevelService', 'getLevel', { switchLevel: { level: { value: 42 } } }, 42],
  ['fanSpeedService', 'FanSpeedService', 'getLevel', { fanSpeed: { fanSpeed: { value: 2 } } }, 66],
  ['windowCoveringService', 'WindowCoveringService', 'getCurrentPosition', { switchLevel: { level: { value: 42 } } }, 42],
]) {
  test(`${type}.${method} rechecks a previously offline device`, async () => {
    const service = makeService(file, type, async () => true, false);
    let rechecks = 0;
    service.multiServiceAccessory.ensureOnline = async () => { rechecks++; return true; };
    service.multiServiceAccessory.refreshStatus = async () => true;
    service.deviceStatus = { status };
    assert.equal(await service[method](), expected);
    assert.equal(rechecks, 1);
  });
}

test('thermostat publishes only the active setpoint and switches it on a mode event', () => {
  const service = makeService('thermostatService', 'ThermostatService', async () => true);
  const updates = [];
  const target = Symbol('target-temperature');
  service.platform = { ...platform, Characteristic: { ...platform.Characteristic, TargetTemperature: target } };
  service.service.updateCharacteristic = (characteristic, value) => updates.push([characteristic, value]);
  service.deviceStatus = { status: {
    thermostatHeatingSetpoint: { heatingSetpoint: { value: 20, unit: 'C' } },
    thermostatCoolingSetpoint: { coolingSetpoint: { value: 77, unit: 'F' } },
  } };
  service.targetHeatingCoolingState = 1;
  service.processEvent({ capability: 'thermostatCoolingSetpoint', attribute: 'coolingSetpoint', value: 77, unit: 'F' });
  assert.deepEqual(updates, []);
  service.processEvent({ capability: 'thermostatHeatingSetpoint', attribute: 'heatingSetpoint', value: 21, unit: 'C' });
  assert.deepEqual(updates, [[target, 21]]);
  updates.length = 0;
  service.processEvent({ capability: 'thermostatMode', attribute: 'thermostatMode', value: 'cool' });
  assert.deepEqual(updates, [[platform.Characteristic.TargetHeatingCoolingState, 2], [target, 25]]);
  assert.equal(service.targetTemperature, 25);
  updates.length = 0;
  service.processEvent({ capability: 'thermostatHeatingSetpoint', attribute: 'heatingSetpoint', value: 23, unit: 'C' });
  assert.deepEqual(updates, []);
  service.processEvent({ capability: 'thermostatCoolingSetpoint', attribute: 'coolingSetpoint', value: 78.8, unit: 'F' });
  assert.ok(Math.abs(updates[0][1] - 26) < 1e-9);
});

test('thermostat mode change does not publish a target without a known unit or value', () => {
  const service = makeService('thermostatService', 'ThermostatService', async () => true);
  const updates = [];
  const target = Symbol('target-temperature');
  service.platform = { ...platform, Characteristic: { ...platform.Characteristic, TargetTemperature: target } };
  service.service.updateCharacteristic = (characteristic, value) => updates.push([characteristic, value]);
  service.deviceStatus = { status: { thermostatCoolingSetpoint: { coolingSetpoint: { value: 22 } } } };
  service.processEvent({ capability: 'thermostatMode', attribute: 'thermostatMode', value: 'cool' });
  assert.deepEqual(updates, [[platform.Characteristic.TargetHeatingCoolingState, 2]]);
  service.deviceStatus.status.temperatureMeasurement = { temperature: { unit: 'C' } };
  service.processEvent({ capability: 'thermostatMode', attribute: 'thermostatMode', value: 'cool' });
  assert.deepEqual(updates.at(-1), [target, 22]);
});
