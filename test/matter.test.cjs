'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setImmediate: tick } = require('node:timers/promises');
const { SmartThingsMatter } = require('../dist/matter');
const { MultiServiceAccessory } = require('../dist/multiServiceAccessory');

class Behavior {}
class OnOff extends Behavior {}
class LevelControl extends Behavior {
  static id = 'levelControl';

  moveToLevelLogic(level, _transitionTime, withOnOff) {
    this.currentLevel = level;
    if (withOnOff) this.agent.get(OnOff).state.onOff = level > this.minLevel;
  }
}

function fixture() {
  const registered = new Map(), updates = [], commands = [], removed = [], messages = [];
  const deviceTypes = Object.fromEntries(['OnOffLight', 'DimmableLight', 'ExtendedColorLight', 'ColorTemperatureLight', 'OnOffOutlet',
    'DimmableOutlet', 'MotionSensor', 'ContactSensor', 'TemperatureSensor', 'HumiditySensor', 'LightSensor', 'LeakSensor'].map(name => [name, {
    name,
    behaviors: { levelControl: LevelControl, onOff: OnOff },
    with(...behaviors) {
      return { ...this, behaviors: { ...this.behaviors, ...Object.fromEntries(behaviors.map(b => [b.id, b])) } };
    },
  }]));
  const matter = {
    deviceTypes,
    async registerPlatformAccessories(plugin, platform, list) {
      assert.equal(plugin, 'homebridge-smartthings-veon');
      assert.equal(platform, 'HomeBridgeSmartThings');
      for (const accessory of list) {
        registered.set(accessory.UUID, { accessory, state: { ...structuredClone(accessory.clusters), bridgedDeviceBasicInformation: { reachable: true } } });
      }
    },
    async getAccessoryState(uuid, cluster) { return registered.get(uuid)?.state[cluster]; },
    async updateAccessoryState(uuid, cluster, state) {
      updates.push({ uuid, cluster, state });
      Object.assign(registered.get(uuid).state[cluster], state);
    },
    async unregisterPlatformAccessories(_plugin, _platform, list) {
      for (const accessory of list) {
        removed.push(accessory.UUID);
        registered.delete(accessory.UUID);
      }
    },
  };
  const api = { hap: { uuid: { generate: x => createHash('sha256').update(x).digest('hex').slice(0, 32) } } };
  const log = { warn: s => messages.push(s), info: () => {}, debug: s => messages.push(s) };
  const bridge = new SmartThingsMatter(api, log);
  const addDevice = (id, name, componentId, categories, status, capabilities = Object.keys(status)) => {
    const device = { id, name, isOnline: () => true, components: [{ componentId, capabilities, status }],
      sendCommands: async (items, _component, _localOnly, beforeSend) => {
        if (beforeSend && !beforeSend()) return false;
        commands.push(...items.map(c => ({ ...c }))); return true;
      } };
    return { device, metadata: { components: [{ id: componentId, categories: categories.map(name => ({ name })) }] } };
  };
  const byType = name => [...registered.values()].find(e => e.accessory.deviceType.name === name);
  return { bridge, api, log, matter, registered, updates, commands, removed, messages, addDevice, byType };
}
const value = (value, unit) => ({ value, unit });

function levelControlFor(entry) {
  const { levelControl: Control, smartThingsBrightness: Driver } = entry.accessory.deviceType.behaviors;
  const driver = new Driver();
  return Object.assign(new Control(), entry.state.levelControl, {
    context: { transaction: { lock() {} } },
    endpoint: { stateOf: name => entry.state[name] },
    agent: { get: Type => Type === Driver ? driver : { state: entry.state.onOff } },
  });
}

test('publishes outlet power in milliwatts and updates only from valid watt readings', async () => {
  const f = fixture();
  const plug = f.addDevice('metered', 'Metered plug', 'main', ['SmartPlug'], {
    switch: { switch: value('on') }, powerMeter: { power: value(12.5, 'W') },
  });
  await f.bridge.start(f.matter, [plug]);
  const outlet = f.byType('OnOffOutlet');
  assert.equal(outlet.state.electricalPowerMeasurement.activePower, 12500);
  f.updates.length = 0;
  plug.device.components[0].status.powerMeter.power = value(0, 'W');
  f.bridge.sync(plug.device, 'main', 'powerMeter');
  assert.deepEqual(f.updates, [{ uuid: outlet.accessory.UUID, cluster: 'electricalPowerMeasurement', state: { activePower: 0 } }]);
  f.updates.length = 0;
  plug.device.components[0].status.powerMeter.power = value(10, 'kW');
  f.bridge.sync(plug.device, 'main', 'powerMeter');
  assert.deepEqual(f.updates, []);
});

test('publishes voltage and current and refreshes the restored outlet when measurements are added', async () => {
  const f = fixture();
  const plug = f.addDevice('electrical', 'Plug', 'main', ['SmartPlug'], {
    switch: { switch: value('on') }, powerMeter: { power: value(1027, 'W') },
  });
  await f.bridge.start(f.matter, [plug]);
  const previous = f.byType('OnOffOutlet').accessory;
  f.bridge.close();
  const component = plug.device.components[0];
  component.capabilities.push('voltageMeasurement', 'currentMeasurement');
  component.status.voltageMeasurement = { voltage: value(235, 'V') };
  component.status.currentMeasurement = { current: value(4.451, 'A') };
  const upgraded = new SmartThingsMatter(f.api, f.log);
  upgraded.restore(previous);
  await upgraded.start(f.matter, [plug]);
  assert.deepEqual(f.removed, [previous.UUID]);
  const outlet = f.byType('OnOffOutlet');
  assert.deepEqual(outlet.state.electricalPowerMeasurement, { activePower: 1027000, voltage: 235000, activeCurrent: 4451 });
  f.updates.length = 0;
  component.status.currentMeasurement.current = value(4.5, 'A');
  upgraded.sync(plug.device, 'main', 'currentMeasurement');
  assert.deepEqual(f.updates[0].state, { activePower: 1027000, voltage: 235000, activeCurrent: 4500 });
  component.status.voltageMeasurement.voltage = value(230, 'kV');
  upgraded.sync(plug.device, 'main', 'voltageMeasurement');
  assert.equal(outlet.state.electricalPowerMeasurement.voltage, 235000);
});

test('publishes the device energy counter and restores its current reading after plugin restart', async () => {
  const f = fixture();
  const plug = f.addDevice('energy', 'Metered plug', 'main', ['SmartPlug'], {
    switch: { switch: value('on') }, energyMeter: { energy: { ...value(1.25, 'kWh'), timestamp: '2026-10-26T21:37:58Z' } },
  });
  await f.bridge.start(f.matter, [plug]);
  const outlet = f.byType('OnOffOutlet');
  assert.deepEqual(outlet.state.electricalEnergyMeasurement.cumulativeEnergyImported,
    { energy: 1250000, endTimestamp: 1793050678 });
  plug.device.components[0].status.energyMeter.energy = value(1300, 'Wh');
  f.updates.length = 0;
  f.bridge.sync(plug.device, 'main', 'energyMeter');
  assert.deepEqual(f.updates[0].state, { cumulativeEnergyImported: { energy: 1300000 } });
  f.bridge.close();
  const restored = new SmartThingsMatter(f.api, f.log);
  restored.restore(outlet.accessory);
  await restored.start(f.matter, [plug]);
  const afterRestart = f.byType('OnOffOutlet');
  assert.equal(afterRestart.accessory.UUID, outlet.accessory.UUID);
  assert.deepEqual(afterRestart.state.electricalEnergyMeasurement.cumulativeEnergyImported, { energy: 1300000 });
  plug.device.components[0].status.energyMeter.energy = value(0, 'kWh');
  restored.sync(plug.device, 'main', 'energyMeter');
  assert.deepEqual(afterRestart.state.electricalEnergyMeasurement.cumulativeEnergyImported, { energy: 0 });
  f.updates.length = 0;
  plug.device.components[0].status.energyMeter.energy = value(-1, 'kWh');
  restored.sync(plug.device, 'main', 'energyMeter');
  assert.deepEqual(f.updates, []);
});

test('re-registers a restored outlet when energy metering is added', async () => {
  const f = fixture();
  const plug = f.addDevice('upgrade', 'Plug', 'main', ['SmartPlug'], { switch: { switch: value('on') } });
  await f.bridge.start(f.matter, [plug]);
  const previous = f.byType('OnOffOutlet').accessory;
  f.bridge.close();
  plug.device.components[0].capabilities.push('energyMeter');
  plug.device.components[0].status.energyMeter = { energy: value(2, 'kWh') };
  const upgraded = new SmartThingsMatter(f.api, f.log);
  upgraded.restore(previous);
  await upgraded.start(f.matter, [plug]);
  assert.deepEqual(f.removed, [previous.UUID]);
  assert.equal(f.byType('OnOffOutlet').state.electricalEnergyMeasurement.cumulativeEnergyImported.energy, 2000000);
});

test('publishes category-appropriate controls and sensor readings, with reversible routing to the correct component', async () => {
  const f = fixture();
  const plug = f.addDevice('plug', 'Plug', 'outlet2', ['SmartPlug'], { switch: { switch: value('on') } });
  const sensor = f.addDevice('sensor', 'Door and temperature', 'main', ['ContactSensor'], {
    contactSensor: { contact: value('closed') }, temperatureMeasurement: { temperature: value(68, 'F') },
    illuminanceMeasurement: { illuminance: value(100, 'lux') },
  });
  const washer = f.addDevice('washer', 'Washer', 'main', ['Washer'], { switch: { switch: value('off') } });
  await f.bridge.start(f.matter, [plug, sensor, washer]);
  assert.equal(f.registered.size, 4, 'do not expose an appliance as a controllable plug');
  assert.equal(f.byType('TemperatureSensor').state.temperatureMeasurement.measuredValue, 2000);
  assert.equal(f.byType('LightSensor').state.illuminanceMeasurement.measuredValue, 20001);
  const outlet = f.byType('OnOffOutlet');
  await outlet.accessory.handlers.onOff.toggle();
  assert.deepEqual(f.commands, [{ capability: 'switch', command: 'off', arguments: undefined, component: 'outlet2' }]);
  plug.device.sendCommands = async () => false;
  await assert.rejects(outlet.accessory.handlers.onOff.off(), /command failed/);
  const contact = f.byType('ContactSensor');
  sensor.device.components[0].status.contactSensor.contact.value = 'open';
  f.updates.length = 0;
  f.bridge.sync(sensor.device, 'main', 'contactSensor');
  f.bridge.sync(sensor.device, 'main', 'contactSensor');
  assert.deepEqual(f.updates, [{ uuid: contact.accessory.UUID, cluster: 'booleanState', state: { stateValue: false } }]);
  await f.bridge.removeDevices(new Set([plug.device.id]));
  await assert.rejects(outlet.accessory.handlers.onOff.on(), /command failed/);
  assert.deepEqual(f.removed, [outlet.accessory.UUID]);
});

test('absolute brightness still works on devices without a standard relative command', async () => {
  const f = fixture();
  const lamp = f.addDevice('lamp', 'Lamp', 'main', ['Light'], {
    switch: { switch: value('off') }, switchLevel: { level: value(50) },
  });
  await f.bridge.start(f.matter, [lamp]);
  const entry = f.byType('DimmableLight');
  const levelControl = levelControlFor(entry);

  await assert.rejects(levelControl.stepLogic(0, 25), /does not support stepLevel/);
  assert.deepEqual(f.commands, []);
  assert.equal(entry.state.onOff.onOff, false);
  await levelControl.moveToLevelLogic(127, 0, true);
  assert.equal(entry.state.onOff.onOff, true);
  await levelControl.moveToLevelLogic(0, 0, true);
  assert.equal(entry.state.onOff.onOff, false);
  assert.deepEqual(f.commands.map(c => [c.command, c.arguments]), [
    ['setLevel', [50, 0]], ['off', undefined],
  ]);
});

test('forwards standard relative brightness without estimating the reported level', async () => {
  const f = fixture();
  const capability = 'statelessSwitchLevelStep';
  const lamp = f.addDevice('step', 'Standard step lamp', 'main', ['Light'], {
    switch: { switch: value('off') }, switchLevel: { level: value(50) },
  }, ['switch', 'switchLevel', capability]);
  await f.bridge.start(f.matter, [lamp]);
  const entry = f.byType('DimmableLight');
  const levelControl = levelControlFor(entry);
  await levelControl.stepLogic(0, 25);
  assert.equal(entry.state.onOff.onOff, false, 'a relative command must not simulate power changes');
  await levelControl.stepLogic(0, 25);
  await levelControl.stepLogic(1, 51);
  await levelControl.stepLogic(1, 254);
  assert.equal(levelControl.currentLevel, 127, 'wait for SmartThings to report the resulting brightness');
  assert.deepEqual(f.commands.map(c => [c.capability, c.command, c.arguments]), [
    [capability, 'stepLevel', [10]], [capability, 'stepLevel', [10]], [capability, 'stepLevel', [-20]], [capability, 'stepLevel', [-100]],
  ]);
  let attempts = 0;
  lamp.device.sendCommands = async ([command]) => {
    attempts++;
    assert.equal(command.capability, capability);
    return false;
  };
  await assert.rejects(levelControl.stepLogic(0, 25), /command failed/);
  assert.equal(attempts, 1, 'a failed native step must never be replayed as an absolute write');
});

test('StepWithOnOff waits for physical power and minimum level reports in command order', async () => {
  const f = fixture();
  const lamp = f.addDevice('coupled', 'Coupled lamp', 'main', ['Light'], {
    switch: { switch: value('off') }, switchLevel: { level: value(50) },
  }, ['switch', 'switchLevel', 'statelessSwitchLevelStep']);
  const { device } = lamp;
  Object.setPrototypeOf(device, MultiServiceAccessory.prototype);
  delete device.sendCommands;
  Object.assign(device, {
    accessory: { UUID: device.id, services: [] }, services: [], eventAttributes: new Map(), eventIds: new Set(), eventRevision: 0,
    log: f.log,
    platform: {
      hasLocalEventsFor: () => true,
      async sendDeviceCommands(_id, commands) { f.commands.push(...commands); return 'local'; },
      updateMatterState: (...args) => f.bridge.sync(...args),
    },
  });
  const report = (capability, attribute, value) => device.processEvent({
    deviceId: device.id, componentId: 'main', capability, attribute, value,
  });
  const names = () => f.commands.map(c => c.command);
  await f.bridge.start(f.matter, [lamp]);
  const levelControl = levelControlFor(f.byType('DimmableLight'));

  await levelControl.stepLogic(1, 254, 0, true);
  assert.deepEqual(names(), ['stepLevel'], 'a target at minimum must not wake an off lamp');
  f.commands.length = 0;

  const wake = levelControl.stepLogic(0, 51, 0, true);
  const nextStep = levelControl.stepLogic(0, 25, 0, true);
  await tick();
  assert.deepEqual(names(), ['on'], 'hub acceptance must not release either step');
  report('switch', 'switch', 'on');
  await Promise.all([wake, nextStep]);
  assert.deepEqual(names(), ['on', 'stepLevel', 'stepLevel']);
  report('switchLevel', 'level', 80);

  const lower = levelControl.stepLogic(1, 254, 0, true);
  await tick();
  assert.deepEqual(names().slice(-2), ['stepLevel', 'stepLevel']);
  report('switchLevel', 'level', 20);
  await tick();
  assert.equal(names().at(-1), 'stepLevel', 'an intermediate level must not switch the lamp off');
  report('switchLevel', 'level', 1);
  await tick();
  assert.equal(names().at(-1), 'off');
  const wakeAgain = levelControl.stepLogic(0, 25, 0, true);
  await tick();
  assert.equal(names().at(-1), 'off', 'the next step must wait for the off report');
  report('switch', 'switch', 'off');
  await tick();
  assert.deepEqual(names().slice(-2), ['off', 'on']);
  report('switch', 'switch', 'on');
  await Promise.all([lower, wakeAgain]);
  assert.deepEqual(f.commands.map(c => [c.command, c.arguments]), [
    ['on', undefined], ['stepLevel', [20]], ['stepLevel', [10]], ['stepLevel', [-100]],
    ['off', undefined], ['on', undefined], ['stepLevel', [10]],
  ]);
});

test('color commands use SmartThings units', async () => {
  const f = fixture();
  const lamp = f.addDevice('lamp', 'Lamp', 'main', ['Light'], {
    switch: { switch: value('on') }, switchLevel: { level: value(50) },
    colorControl: { hue: value(0), saturation: value(100) },
    colorTemperature: { colorTemperature: value(3000, 'K'), colorTemperatureRange: value({ minimum: 2200, maximum: 4000 }, 'K') },
  });
  await f.bridge.start(f.matter, [lamp]);
  const entry = f.byType('ExtendedColorLight');
  const { colorControl } = entry.accessory.handlers;
  await colorControl.moveToColorTemperatureLogic({ colorTemperatureMireds: 200 });
  await colorControl.moveToColorLogic({ targetX: Math.round(0.64 * 65536), targetY: Math.round(0.33 * 65536) });
  assert.deepEqual(f.commands.map(c => [c.command, c.arguments]), [
    ['setColorTemperature', [4000]], ['setColor', [{ hue: 0, saturation: 100 }]],
  ]);
  assert.equal(entry.state.colorControl.colorTemperatureMireds, 333);
  assert.ok(Math.abs(entry.state.colorControl.currentX - Math.round(0.64 * 65536)) < 10);
});

test('Matter temperature commands never reach an off or unknown lamp, including when queued', async () => {
  const f = fixture();
  const lamp = f.addDevice('lamp', 'Lamp', 'main', ['Light'], {
    switch: { switch: value('off') }, switchLevel: { level: value(50) },
    colorTemperature: { colorTemperature: value(3000, 'K') },
  });
  await f.bridge.start(f.matter, [lamp]);
  const control = f.byType('ColorTemperatureLight').accessory.handlers.colorControl;
  await control.moveToColorTemperatureLogic({ colorTemperatureMireds: 300 });
  lamp.device.components[0].status.switch.switch = value(undefined);
  await control.moveToColorTemperatureLogic({ colorTemperatureMireds: 300 });
  assert.equal(f.commands.length, 0);
  lamp.device.components[0].status.switch.switch = value('on');
  lamp.device.sendCommands = async (_commands, _component, _localOnly, beforeSend) => {
    lamp.device.components[0].status.switch.switch = value('off');
    assert.equal(beforeSend(), false);
    return false;
  };
  await control.moveToColorTemperatureLogic({ colorTemperatureMireds: 300 });
  assert.equal(f.commands.length, 0);
});

test('a restored device keeps its endpoint identity and unavailable sensors do not report a synthetic reading', async () => {
  const f = fixture();
  const sensor = f.addDevice('sensor', 'Temperature', 'main', [], {}, ['temperatureMeasurement']);
  await f.bridge.start(f.matter, [sensor]);
  const old = f.byType('TemperatureSensor');
  assert.equal(old.state.bridgedDeviceBasicInformation.reachable, false);
  assert.equal(old.state.temperatureMeasurement.measuredValue, null);
  const restored = new SmartThingsMatter(f.api, f.log);
  restored.restore(old.accessory);
  sensor.device.name = 'Renamed sensor';
  sensor.device.components[0].status.temperatureMeasurement = { temperature: value(20.5, 'C') };
  await restored.start(f.matter, [sensor]);
  const current = f.byType('TemperatureSensor');
  assert.equal(current.accessory.UUID, old.accessory.UUID);
  assert.equal(current.accessory.displayName, 'Renamed sensor');
  assert.equal(current.state.bridgedDeviceBasicInformation.reachable, true);
  assert.equal(current.state.temperatureMeasurement.measuredValue, 2050);
  assert.deepEqual(f.removed, []);
});
