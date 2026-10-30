'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { IKHomeBridgeHomebridgePlatform } = require('../dist/platform');
function fixture() {
  const api = new EventEmitter();
  api.hap = { Service: {}, Characteristic: {} };
  api.user = { storagePath: () => '/unused' };
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(k => [k, () => {}]));
  const platform = new IKHomeBridgeHomebridgePlatform(log, { BaseURL: 'https://example.invalid/', AccessToken: 'unused', LocalHubTokenFile: '/unused/token' }, api);
  return platform;
}
test('hub-listed device uses the local command and never the cloud', async () => {
  const p = fixture(), sent = [];
  p.localDeviceIds = new Set(['local']);
  p.localHub = { executeCommands: async (...x) => sent.push(x) };
  p.axInstance = { post: async () => { throw Error('unexpected cloud call'); } };
  const commands = [{ capability: 'switch', command: 'on' }];
  assert.equal(await p.sendDeviceCommands('local', commands), 'local');
  assert.deepEqual(sent, [['local', commands]]);
});
test('an uncertain or rejected local command is not repeated in the cloud', async () => {
  const p = fixture(); let cloud = 0;
  p.localDeviceIds = new Set(['local']);
  p.localHub = { executeCommands: async () => { throw Error('unknown outcome'); } };
  p.axInstance = { post: async () => { cloud++; } };
  await assert.rejects(p.sendDeviceCommands('local', [{ capability: 'switch', command: 'on' }]));
  assert.equal(cloud, 0);
});
test('known devices absent from the hub retain the existing cloud command route', async () => {
  const p = fixture(), sent = [];
  p.localDeviceIds = new Set(['local']);
  p.localHub = { executeCommands: async () => { throw Error('unexpected local call'); } };
  p.axInstance = { post: async (...x) => sent.push(x) };
  assert.equal(await p.sendDeviceCommands('cloud', [{ capability: 'switch', command: 'on' }]), 'cloud');
  assert.equal(sent[0][0], 'devices/cloud/commands');
  assert.deepEqual(JSON.parse(sent[0][1]), { commands: [{ capability: 'switch', command: 'on' }] });
});
test('if the hub device list is unavailable commands do not guess a route', async () => {
  const p = fixture(); let cloud = 0;
  p.localDeviceIds = undefined;
  p.localHub = { getDeviceIds: async () => { throw Error('offline'); } };
  p.axInstance = { post: async () => { cloud++; } };
  await assert.rejects(p.sendDeviceCommands('unknown', [{ capability: 'switch', command: 'on' }]), /Local device list unavailable/);
  assert.equal(cloud, 0);
});

test('local-only commands never fall back to the cloud for an unlisted device', async () => {
  const p = fixture(); let cloud = 0;
  p.localDeviceIds = new Set(['local']);
  p.localHub = { executeCommands: async () => { throw Error('unexpected local command'); } };
  p.axInstance = { post: async () => { cloud++; } };
  await assert.rejects(p.sendDeviceCommands('other', [{ capability: 'colorTemperature', command: 'setColorTemperature' }], true));
  assert.equal(cloud, 0);
});

test('concurrent commands are serialized and retain the service component', async () => {
  const { MultiServiceAccessory } = require('../dist/multiServiceAccessory');
  const pending = [], sent = [];
  const accessory = Object.create(MultiServiceAccessory.prototype);
  Object.assign(accessory, {
    accessory: { UUID: 'local' }, commandTail: Promise.resolve(), commandInProgress: false,
    name: 'test', log: { debug() {}, info() {}, error() {} },
    platform: { sendDeviceCommands: (id, commands) => {
      sent.push({ id, commands });
      return new Promise(resolve => pending.push(resolve));
    } },
  });
  const first = accessory.sendCommands([{ capability: 'switch', command: 'on' }], 'left');
  const second = accessory.sendCommands([{ capability: 'switch', command: 'off' }], 'right');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].commands[0].component, 'left');
  pending.shift()('local');
  assert.equal(await first, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].commands[0].component, 'right');
  pending.shift()('local');
  assert.equal(await second, true);
});
