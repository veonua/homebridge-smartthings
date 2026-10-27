'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { IKHomeBridgeHomebridgePlatform } = require('../dist/platform');

function fixture(overrides = {}) {
  const api = new EventEmitter();
  api.hap = { Service: {}, Characteristic: {} };
  api.user = { storagePath: () => '/unused' };
  const messages = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => messages.push([level, args.join(' ')])]));
  const platform = new IKHomeBridgeHomebridgePlatform(log, {
    BaseURL: 'https://example.invalid/', AccessToken: 'unused', LocalHubTokenFile: '/unused/token', ...overrides,
  }, api);
  return { platform, api, messages };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('local event passes exact payload to the accessory and logs the first applied event once', () => {
  const { platform, messages } = fixture();
  const events = [];
  platform.accessoryObjects = [{ id: 'device', processEvent: event => { events.push(event); return true; } }];
  const source = { deviceId: 'device', componentId: 'main', capability: 'switch', attribute: 'switch',
    value: 'on', eventId: 'id', unit: null, data: { x: 1 } };
  platform.processLocalEvent({ eventTime: 123, deviceEvent: source });
  platform.processLocalEvent({ eventTime: 124, deviceEvent: { ...source, eventId: 'id2' } });
  assert.deepEqual(events[0], { deviceId: 'device', componentId: 'main', capability: 'switch', attribute: 'switch',
    value: 'on', eventId: 'id', eventTime: 123, unit: undefined, data: { x: 1 } });
  assert.equal(messages.filter(([level, text]) => level === 'info' && text.includes('event applied')).length, 1);
  platform.shuttingDown = true;
  platform.processLocalEvent({ eventTime: 125, deviceEvent: source });
  assert.equal(events.length, 2);
});



test('a reconnect while reconciliation is running schedules one full follow-up', async () => {
  const { platform } = fixture();
  let resolveFirst, calls = 0;
  platform.accessoryObjects = [{ id: 'local', resyncState: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(true);
  } }];
  const first = platform.resyncAccessories(true);
  await flush();
  await platform.resyncAccessories(true);
  await platform.resyncAccessories(true);
  resolveFirst(true);
  await first;
  await flush();
  assert.equal(calls, 2);
});

test('shutdown during discovery prevents late accessory registration and SSE startup', async () => {
  const { platform, api } = fixture({ LocalHubEvents: true });
  let resolveDevices, discoveries = 0, starts = 0;
  platform.getOnlineDevices = () => new Promise(resolve => { resolveDevices = resolve; });
  platform.discoverDevices = () => { discoveries++; };
  platform.startLocalEvents = () => { starts++; };
  api.emit('didFinishLaunching');
  await flush();
  api.emit('shutdown');
  resolveDevices([]);
  await flush();
  assert.equal(discoveries, 0);
  assert.equal(starts, 0);
});

test('legacy webhook settings do not prevent local SSE startup', async () => {
  const { platform, api, messages } = fixture({
    LocalHubEvents: true, WebhookToken: 'obsolete', LocalWebhookPort: 12345,
  });
  const devices = [{ deviceId: 'device', components: [], locationId: 'location' }];
  let startedWith;
  platform.getOnlineDevices = async () => devices;
  platform.discoverDevices = () => {};
  platform.startLocalEvents = found => { startedWith = found; };
  api.emit('didFinishLaunching');
  await flush();
  assert.equal(startedWith, devices);
  assert.equal(messages.some(([level]) => level === 'error'), false);
});

test('successful token renewal reconnects local events and shutdown stops the manager and stream', async () => {
  const { platform, api } = fixture({ LocalHubAutoRenew: true });
  let renewal, reconnects = 0, stopped = 0, eventStops = 0;
  platform.hubTokenManager = { start: callback => { renewal = callback; }, stop: () => { stopped++; } };
  platform.localEvents = { reconnect: () => { reconnects++; }, stop: async () => { eventStops++; } };
  platform.getOnlineDevices = () => new Promise(() => {});
  api.emit('didFinishLaunching');
  renewal({ status: 'renewed' });
  assert.equal(reconnects, 1);
  api.emit('shutdown');
  assert.equal(stopped, 1);
  assert.equal(eventStops, 1);
});








test('missing location is reported and creates no retry or state polling timer', async t => {
  const { platform, messages } = fixture({ LocalHubEvents: true });
  let snapshots = 0, timers = 0;
  t.mock.method(globalThis, 'setInterval', () => { timers++; return { unref() {} }; });
  t.mock.method(globalThis, 'setTimeout', () => { timers++; return { unref() {} }; });
  platform.resyncAccessories = async () => { snapshots++; };
  platform.startLocalEvents([]);
  platform.startLocalEvents([]);
  await flush();
  assert.equal(snapshots, 1);
  assert.equal(timers, 0);
  assert.ok(messages.some(([, text]) => text.includes('restore device metadata and restart')));
});
