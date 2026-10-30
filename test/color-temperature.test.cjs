const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Service, Characteristic, HapStatusError, HAPStatus } = require(process.env.HAP_NODEJS_MODULE || '@homebridge/hap-nodejs');
const { LightService } = require('../dist/services/lightService');

function light(status = {}) {
  const instance = Object.create(LightService.prototype);
  instance.platform = { Characteristic, api: { hap: { HapStatusError, HAPStatus } } };
  instance.service = new Service.Lightbulb('Test');
  instance.deviceStatus = { status };
  instance.log = { debug() {}, error() {} };
  instance.name = 'Test';
  instance.getStatus = async () => true;
  instance.sent = [];
  instance.sendCommandOrFail = async (...args) => instance.sent.push(args);
  return instance;
}

test('converts reciprocal values for writes, reads, and events', async () => {
  const lamp = light({ colorTemperature: { colorTemperature: { value: 4000 } } });
  await lamp.setColorTemp(250);
  assert.deepEqual(lamp.sent, [['colorTemperature', 'setColorTemperature', [4000]]]);
  assert.equal(await lamp.getColorTemp(), 250);
  lamp.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 2700 });
  assert.equal(lamp.service.getCharacteristic(Characteristic.ColorTemperature).value, 370);
  lamp.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 6500 });
  assert.equal(lamp.service.getCharacteristic(Characteristic.ColorTemperature).value, 154);
});

test('uses reported kelvin range for HAP bounds and limits commands', async () => {
  const lamp = light({ colorTemperature: {
    colorTemperature: { value: 2700 }, colorTemperatureRange: { value: { minimum: 1780, maximum: 4000 }, unit: 'K' },
  } });
  assert.equal(await lamp.getColorTemp(), 370);
  const characteristic = lamp.service.getCharacteristic(Characteristic.ColorTemperature);
  assert.equal(characteristic.props.minValue, 250);
  assert.equal(characteristic.props.maxValue, 561);
  await lamp.setColorTemp(200);
  await lamp.setColorTemp(600);
  assert.deepEqual(lamp.sent.map(command => command[2][0]), [4000, 1780]);
  lamp.processEvent({ capability: 'colorTemperature', attribute: 'colorTemperature', value: 1780 });
  assert.equal(characteristic.value, 561);
});

test('loads the range before the first write and ignores missing or invalid ranges', async () => {
  const lamp = light();
  let reads = 0;
  lamp.getStatus = async () => {
    reads++;
    lamp.deviceStatus.status = { colorTemperature: { colorTemperatureRange: { value: { minimum: 2200, maximum: 4000 } } } };
    return true;
  };
  await lamp.setColorTemp(200);
  assert.equal(reads, 1);
  assert.equal(lamp.sent[0][2][0], 4000);
  const withoutRange = light({ colorTemperature: { colorTemperatureRange: { value: { minimum: 5000, maximum: 2000 } } } });
  await withoutRange.setColorTemp(250);
  assert.equal(withoutRange.sent[0][2][0], 4000);
  assert.equal(withoutRange.service.getCharacteristic(Characteristic.ColorTemperature).props.minValue, 140);
  const wrongUnit = light({ colorTemperature: { colorTemperatureRange: { value: { minimum: 2200, maximum: 3000 }, unit: 'F' } } });
  await wrongUnit.setColorTemp(250);
  assert.equal(wrongUnit.sent[0][2][0], 4000);
});

test('rejects invalid values and ignores non-temperature events', async () => {
  const lamp = light({ colorTemperature: { colorTemperature: { value: 0 } } });
  await assert.rejects(lamp.getColorTemp(), HapStatusError);
  for (const value of [0, -1, NaN, '250']) await assert.rejects(lamp.setColorTemp(value), HapStatusError);
  const characteristic = lamp.service.getCharacteristic(Characteristic.ColorTemperature);
  const previous = characteristic.value;
  for (const event of [
    { capability: 'colorTemperature', attribute: 'colorTemperature', value: 0 },
    { capability: 'colorTemperature', attribute: 'colorTemperatureRange', value: 4000 },
  ]) lamp.processEvent(event);
  assert.equal(characteristic.value, previous);
  assert.deepEqual(lamp.sent, []);
});
