import {
  API, DynamicPlatformPlugin, Logger, MatterAccessory, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import axios = require('axios');
import { MultiServiceAccessory } from './multiServiceAccessory';
import { LocalHubClient, LocalHubCommand, LocalHubUnavailableError } from './localHubClient';
import { LocalHubEvents, LocalDeviceEvent, describeLocalHubEventsError } from './localHubEvents';
import { HubTokenManager } from './hubTokenManager';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { SmartThingsMatter } from './matter';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class IKHomeBridgeHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private locationIDsToIgnore: string[] = [];

  private readonly axInstance: axios.AxiosInstance;

  private accessoryObjects: MultiServiceAccessory[] = [];
  private localHub: LocalHubClient | undefined;
  private hubTokenManager: HubTokenManager | undefined;
  private localEvents: LocalHubEvents | undefined;
  private localEventsConnected = false;
  private localEventApplied = false;
  private localEventsStarted = false;
  private resyncRunning = false;
  private resyncAgain = false;
  private shuttingDown = false;
  private localDeviceIds: Set<string> | undefined;
  private localDiscoveryRetryAt = 0;
  private localDiscovery: Promise<void> | undefined;
  private readonly localResourceRetryAt = new Map<string, number>();
  private catalogRefresh: Promise<void> | undefined;
  private catalogRefreshRetryAt = 0;
  private catalogRefreshTimer: NodeJS.Timeout | undefined;
  private readonly removedDeviceIds = new Set<string>();
  private readonly forbiddenDeviceIds = new Set<string>();
  private readonly matterBridge: SmartThingsMatter;
  private matterTimer: NodeJS.Timeout | undefined;
  private matterRefreshing = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.matterBridge = new SmartThingsMatter(api, log);
    this.axInstance = axios.create({
      baseURL: config.BaseURL,
      headers: { 'Authorization': 'Bearer: ' + config.AccessToken },
      timeout: 5000,
    });
    this.log.debug('Finished initializing platform:', this.config.name);
    if (typeof config.LocalHubTokenFile === 'string' && config.LocalHubTokenFile.trim()) {
      this.localHub = new LocalHubClient(config.LocalHubTokenFile, {
        onUnavailable: code => this.log.warn(`Local hub unavailable (${code}); pausing requests for 30 seconds.`),
        onRestored: durationMs => {
          this.log.info(`Local hub connection restored after ${(durationMs / 1000).toFixed(1)} seconds.`);
          void this.resyncAccessories(true);
        },
      });
      const localHub = this.localHub;
      this.api.on('shutdown', () => localHub.close());
      if (config.LocalHubAutoRenew === true) {
        this.hubTokenManager = new HubTokenManager(config.LocalHubTokenFile);
        this.api.on('shutdown', () => this.hubTokenManager?.stop());
      }
    } else if (config.LocalHubAutoRenew === true) {
      this.log.error('LocalHubAutoRenew requires LocalHubTokenFile');
    }
    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      this.matterBridge.close();
      if (this.matterTimer) {
        clearInterval(this.matterTimer);
      }
      if (this.catalogRefreshTimer) {
        clearTimeout(this.catalogRefreshTimer);
        this.catalogRefreshTimer = undefined;
      }
      void this.localEvents?.stop();
    });

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.

    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');
      this.hubTokenManager?.start(result => {
        if (result.status === 'renewed') {
          this.log.info(`Local hub token renewed; expires ${result.hubExpiresAt || 'at an unknown time'}`);
          this.localEvents?.reconnect();
        } else if (result.status === 'failed' || result.status === 'hub_validation_failed') {
          this.log.warn(`Local hub token renewal failed: ${result.code || result.status}${result.reauthRequired ? '; sign in again' : ''}`);
        } else {
          this.log.debug(`Local hub token renewal: ${result.status}`);
        }
      });
      // run the method to discover / register your devices as accessories

      // If locations or rooms to ignore are configured, then
      // load request those from Smartthings to build the id lists.

      if (this.config.IgnoreLocations) {
        try {
          await this.getLocationsToIgnore();
        } catch (error) {
          this.log.error(`Could not apply location exclusions: ${error}`);
          return;
        }
      }

      if (this.shuttingDown) {
        return;
      }


      this.getOnlineDevices().then((devices) => {
        if (this.shuttingDown) {
          return;
        }
        if (this.config.UnregisterAll) {
          this.unregisterDevices(devices, true);
        }
        this.discoverDevices(devices);
        void this.startMatter();
        if (this.config.LocalHubEvents === true) {
          this.startLocalEvents(devices);
        }
        // The local list and a cached cloud catalog are not authoritative for removal.
        if (!this.localHub) {
          this.unregisterDevices(devices);
        } else {
          const ignored = this.accessories.filter(accessory => this.isDeviceIgnored(accessory.context.device));
          if (ignored.length) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, ignored);
          }
        }
      }).catch(reason => {
        this.log.error(`Could not load devices from Smartthings: ${reason}.  Check your configuration`);
      });
    });
  }

  private startLocalEvents(devices: any[]): void {
    if (this.shuttingDown || this.localEventsStarted) {
      return;
    }
    this.localEventsStarted = true;
    void this.resyncAccessories(true);
    this.connectLocalEvents(devices);
  }

  private connectLocalEvents(devices: any[]): void {
    if (this.shuttingDown || this.localEvents) {
      return;
    }
    if (!this.localHub || typeof this.config.LocalHubTokenFile !== 'string') {
      this.log.error('LocalHubEvents requires LocalHubTokenFile');
      return;
    }
    const locations = [...new Set(devices.filter(device => !this.localDeviceIds || this.localDeviceIds.has(device.deviceId))
      .map(device => device.locationId).filter((id): id is string => typeof id === 'string' && !!id))];
    if (!locations.length) {
      this.log.warn('Local SmartThings SSE cannot start without a local device location; restore device metadata and restart Homebridge');
      return;
    }
    try {
      this.localEvents = new LocalHubEvents({
        tokenFile: this.config.LocalHubTokenFile,
        subscriptionFile: join(dirname(this.config.LocalHubTokenFile), 'smartthings-local-sse-subscriptions.json'),
        locationIds: locations,
        onConnected: () => {
          if (this.shuttingDown) {
            return;
          }
          this.localEventsConnected = true;
          this.log.info('Local SmartThings SSE connected');
          void this.resyncAccessories(true);
        },
        onDisconnected: () => {
          if (this.shuttingDown) {
            return;
          }
          this.localEventsConnected = false;
          this.log.warn('Local SmartThings SSE disconnected; waiting for reconnect');
        },
        onDeviceEvent: event => this.processLocalEvent(event),
        onInfo: message => this.log.info(`Local SmartThings SSE: ${message}`),
        onError: code => this.log.warn(`Local SmartThings SSE: ${describeLocalHubEventsError(code)}`),
      });
      this.localEvents.start();
    } catch (error) {
      this.log.error(`Could not start local SmartThings SSE: ${error}`);
    }
  }

  private processLocalEvent(event: LocalDeviceEvent): void {
    if (this.shuttingDown) {
      return;
    }
    const device = this.accessoryObjects.find(accessory => accessory.id === event.deviceEvent.deviceId);
    const source = event.deviceEvent;
    if (!device) {
      return;
    }
    const applied = device.processEvent({
      deviceId: source.deviceId, componentId: source.componentId, capability: source.capability,
      attribute: source.attribute, value: source.value, eventId: source.eventId, eventTime: event.eventTime,
      unit: source.unit ?? undefined, data: source.data,
    });
    if (!applied) {
      return;
    }
    if (!this.localEventApplied) {
      this.localEventApplied = true;
      this.log.info('Local SmartThings SSE event applied to HomeKit');
    } else {
      this.log.debug('Local SmartThings SSE event applied to HomeKit');
    }
  }

  private async startMatter(): Promise<void> {
    const api = this.api as API & { isMatterExternalsOnly?: () => boolean };
    const matter = api.isMatterEnabled?.() && !api.isMatterExternalsOnly?.() ? api.matter : undefined;
    if (!matter) {
      if (this.config.Matter === true) {
        this.log.warn('Enable Matter on the Homebridge bridge that runs SmartThings to publish devices.');
      }
      return;
    }
    try {
      const byId = new Map(this.accessories.map(a => [a.UUID, a.context.device]));
      await this.matterBridge.start(matter, this.config.Matter === true ? this.accessoryObjects.map(device => ({
        device, metadata: byId.get(device.id) ?? {},
      })) : []);
      if (this.config.Matter === true && !this.shuttingDown) {
        void this.refreshMatterSnapshots();
        this.matterTimer = setInterval(() => void this.refreshMatterSnapshots(), 60000);
        this.matterTimer.unref();
      }
    } catch (error) {
      this.log.warn(`Could not publish SmartThings devices to Matter: ${error}`);
    }
  }

  private async refreshMatterSnapshots(): Promise<void> {
    if (this.shuttingDown || this.matterRefreshing) {
      return;
    }
    this.matterRefreshing = true;
    try {
      for (const device of this.accessoryObjects) {
        if (this.shuttingDown) {
          return;
        }
        if (this.matterBridge.hasDevice(device.id) && !this.hasLocalEventsFor(device.id)) {
          try {
            const available = await device.ensureOnline() && await device.refreshStatus();
            this.matterBridge.sync(device, undefined, undefined, available);
          } catch (error) {
            this.log.debug(`Could not refresh Matter state for ${device.name}: ${error}`);
          }
        }
      }
    } finally {
      this.matterRefreshing = false;
    }
  }

  public updateMatterState(device: MultiServiceAccessory, componentId?: string, capability?: string): void {
    this.matterBridge.sync(device, componentId, capability);
  }

  private async resyncAccessories(all: boolean): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.resyncRunning) {
      this.resyncAgain ||= all;
      return;
    }
    this.resyncRunning = true;
    try {
      // Sequential reads avoid a burst of requests to the hub or cloud.
      for (const accessory of this.accessoryObjects) {
        if (this.shuttingDown) {
          break;
        }
        if (all) {
          try {
            const available = await accessory.resyncState();
            if (this.matterBridge.hasDevice(accessory.id)) {
              this.matterBridge.sync(accessory, undefined, undefined, available);
            }
          } catch (error) {
            this.log.debug(`Could not reconcile ${accessory.id}: ${error}`);
          }
        }
      }
    } finally {
      this.resyncRunning = false;
      if (this.resyncAgain) {
        this.resyncAgain = false;
        void this.resyncAccessories(true);
      }
    }
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.matterBridge.restore(accessory);
  }

  async getLocationsToIgnore(): Promise<boolean> {
    this.log.info('Loading locations for exclusion');
    const cachePath = join(this.api.user.storagePath(), 'smartthings-location-metadata.json');
    let locations: any[];
    try {
      const response = await this.axInstance.get('locations');
      if (!Array.isArray(response.data.items)) {
        throw new Error('Invalid locations response');
      }
      locations = response.data.items;
      if (this.localHub) {
        try {
          writeFileSync(cachePath, JSON.stringify(locations), { mode: 0o600 });
        } catch (error) {
          this.log.warn(`Could not cache location metadata: ${error}`);
        }
      }
    } catch (error) {
      if (!this.localHub) {
        this.log.error('Could not load locations: ' + error + '. You must have r:locations permissions set on the token');
        return true;
      }
      try {
        locations = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (!Array.isArray(locations)) {
          throw new Error('Invalid cached locations');
        }
        this.log.warn('Using cached location metadata for exclusions');
      } catch {
        throw new Error('cloud locations and cached locations are unavailable');
      }
    }
    locations.forEach(location => {
      if (typeof location.name === 'string' && this.config.IgnoreLocations.find(l => l.toLowerCase() === location.name.toLowerCase())) {
        this.locationIDsToIgnore.push(location.locationId);
      }
    });
    this.log.info(`Found ${this.locationIDsToIgnore.length} locations to ignore`);
    return true;
  }

  private async refreshLocalDeviceIds(): Promise<void> {
    if (!this.localHub) {
      return;
    }
    if (!this.localDiscovery) {
      this.localDiscovery = this.localHub.getDeviceIds().then(ids => {
        this.localDeviceIds = ids;
        this.localDiscoveryRetryAt = 0;
        this.log.info(`Local hub reports ${ids.size} devices`);
      }).catch(error => {
        if (error instanceof LocalHubUnavailableError) {
          this.localDiscoveryRetryAt = error.retryAt;
          return;
        }
        this.localDeviceIds = undefined;
        this.localDiscoveryRetryAt = Date.now() + 30000;
        this.log.warn(`Could not load the local device list; using cloud temporarily: ${error}`);
      }).finally(() => {
        this.localDiscovery = undefined;
      });
    }
    await this.localDiscovery;
  }

  private async getCloudDeviceCatalog(): Promise<any[]> {
    const base = this.config.BaseURL.endsWith('/') ? this.config.BaseURL : `${this.config.BaseURL}/`;
    const catalogUrl = new URL('devices', base);
    const visited = new Set<string>();
    const devices = new Map<string, any>();
    let endpoint: string | undefined = 'devices';
    while (endpoint) {
      const url = new URL(endpoint, catalogUrl);
      if (url.origin !== catalogUrl.origin || url.pathname !== catalogUrl.pathname || url.username || url.password ||
        url.hash || visited.has(url.href) || visited.size >= 100) {
        throw new Error('Invalid cloud device catalog pagination');
      }
      visited.add(url.href);
      const { data } = await this.axInstance.get(endpoint, { timeout: 15000 });
      if (!data || !Array.isArray(data.items) || data.items.some(device =>
        !device || typeof device.deviceId !== 'string' || !device.deviceId || !Array.isArray(device.components))) {
        throw new Error('Invalid cloud device catalog');
      }
      data.items.forEach(device => devices.set(device.deviceId, device));
      if (data._links !== undefined && data._links !== null &&
        (typeof data._links !== 'object' || Array.isArray(data._links))) {
        throw new Error('Invalid cloud device catalog pagination');
      }
      const next = data._links?.next;
      if (next !== undefined && next !== null && (typeof next.href !== 'string' || !next.href)) {
        throw new Error('Invalid cloud device catalog pagination');
      }
      endpoint = next ? new URL(next.href, url).href : undefined;
    }
    return [...devices.values()];
  }

  private saveDeviceCatalog(devices: any[]): void {
    const file = join(this.api.user.storagePath(), 'smartthings-device-metadata.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(devices), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally {
      try {
        unlinkSync(temporary);
      } catch { /* A successful rename already removed the temporary file. */ }
    }
  }

  private refreshCatalogOnForbidden(deviceId: string, error: unknown): void {
    const httpError = error as { statusCode?: number; response?: { status?: number } } | null;
    if ((httpError?.statusCode !== 403 && httpError?.response?.status !== 403) || this.shuttingDown ||
      !this.localHub || this.removedDeviceIds.has(deviceId)) {
      return;
    }
    this.forbiddenDeviceIds.add(deviceId);
    this.scheduleCatalogRefresh();
  }

  private scheduleCatalogRefresh(): void {
    if (this.shuttingDown || this.catalogRefresh || !this.forbiddenDeviceIds.size) {
      return;
    }
    const delay = Math.max(0, this.catalogRefreshRetryAt - Date.now());
    if (delay > 0) {
      if (!this.catalogRefreshTimer) {
        this.catalogRefreshTimer = setTimeout(() => {
          this.catalogRefreshTimer = undefined;
          this.scheduleCatalogRefresh();
        }, delay);
        this.catalogRefreshTimer.unref();
      }
      return;
    }
    if (this.catalogRefreshTimer) {
      clearTimeout(this.catalogRefreshTimer);
      this.catalogRefreshTimer = undefined;
    }
    this.catalogRefreshRetryAt = Date.now() + 30000;
    this.log.info('Device returned HTTP 403; refreshing the device catalog');
    // Keep the failed HomeKit request independent of the background catalog refresh.
    this.catalogRefresh = this.refreshDeviceCatalog().catch(() => {
      this.log.warn('Could not refresh the device catalog after HTTP 403; keeping cached devices');
    }).finally(() => {
      this.catalogRefresh = undefined;
      this.scheduleCatalogRefresh();
    });
  }

  private async refreshDeviceCatalog(): Promise<void> {
    await this.refreshLocalDeviceIds();
    if (this.shuttingDown) {
      return;
    }
    if (!this.localDeviceIds) {
      throw new Error('Local device list unavailable');
    }
    const ids = this.localDeviceIds;
    // The hub list excludes cloud-only devices. Only remove devices that failed with 403.
    const missing = new Set([...this.forbiddenDeviceIds].filter(id => !ids.has(id)));
    const file = join(this.api.user.storagePath(), 'smartthings-device-metadata.json');
    let cached: any[] | undefined;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(data)) {
        throw new Error('Invalid cached device catalog');
      }
      cached = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (cached?.some(device => missing.has(device?.deviceId))) {
      this.saveDeviceCatalog(cached.filter(device => !missing.has(device?.deviceId)));
    }
    const removed = this.accessories.filter(accessory => missing.has(accessory.UUID));
    if (removed.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed);
    }
    for (const id of missing) {
      this.removedDeviceIds.add(id);
      this.localResourceRetryAt.delete(`${id}:status`);
      this.localResourceRetryAt.delete(`${id}:health`);
    }
    ids.forEach(id => this.removedDeviceIds.delete(id));
    this.accessories.splice(0, this.accessories.length, ...this.accessories.filter(accessory => !missing.has(accessory.UUID)));
    this.accessoryObjects = this.accessoryObjects.filter(accessory => !missing.has(accessory.id));
    void this.matterBridge.removeDevices(missing);
    this.forbiddenDeviceIds.clear();
    this.log.info(`Local device catalog checked: ${ids.size} devices; removed ${removed.length} stale accessories`);
  }

  async getOnlineDevices(): Promise<Array<object>> {
    this.log.debug('Discovering devices...');

    if (this.localHub) {
      const cachePath = join(this.api.user.storagePath(), 'smartthings-device-metadata.json');
      let cached: any[] = [];
      try {
        const data = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (Array.isArray(data)) {
          cached = data.filter(device => device && typeof device.deviceId === 'string' && Array.isArray(device.components));
        }
      } catch {
        this.log.debug('No usable cached SmartThings device metadata');
      }
      const cachedIdsFromFile = new Set(cached.map(device => device.deviceId));
      this.accessories.forEach(accessory => {
        const device = accessory.context.device;
        if (device && typeof device.deviceId === 'string' && Array.isArray(device.components) &&
          !cachedIdsFromFile.has(device.deviceId)) {
          cached.push(device);
        }
      });

      await this.refreshLocalDeviceIds();

      const cachedIds = new Set(cached.map(device => device.deviceId));
      if (!cached.length || (this.localDeviceIds &&
        [...this.localDeviceIds].some(id => !cachedIds.has(id)))) {
        try {
          const devices = await this.getCloudDeviceCatalog();
          // Ordinary discovery retains cached entries; removal requires a successful refresh after a device 403.
          const merged = new Map(cached.map(device => [device.deviceId, device]));
          devices.forEach(device => merged.set(device.deviceId, device));
          cached = [...merged.values()];
          try {
            this.saveDeviceCatalog(cached);
          } catch (error) {
            this.log.warn(`Could not cache SmartThings device metadata: ${error}`);
          }
        } catch (error) {
          if (!cached.length) {
            throw new Error(`Could not load cloud device metadata and no cache is available: ${error}`);
          }
          this.log.warn(`Could not refresh cloud device metadata; using cache: ${error}`);
        }
      }
      if (this.localDeviceIds && [...this.localDeviceIds].some(id => !cached.some(device => device.deviceId === id))) {
        this.log.warn('Some local devices have no cached cloud metadata; restart after cloud access is restored to discover them');
      }
      return this.filterDevices(cached);
    }

    const command = 'devices';
    return new Promise<Array<object>>((resolve, reject) => {

      this.axInstance.get(command).then((res) => {
        resolve(this.filterDevices(res.data.items));
      }).catch(error => {
        this.log.error('Error getting devices from Smartthings: ' + error);
        reject(error);
      });
    });
  }

  private filterDevices(items: any[]): Array<object> {
    const devices: Array<object> = [];
    items.forEach((device) => {
          if (device.type === 'MATTER') {
            this.log.debug(`Skipping Matter device ${device.label || device.deviceId}; it may already be in Apple Home`);
            return;
          }
          // If an apostrophe is included in the name of the device in SmartThings, it comes over as a Right Single
          // quote which will not match with a single quote in the config.  This replaces it so it will match
          if (!device.label) {
            device.label = 'Missing Name';
          }
          let deviceName = '';
          try {
            deviceName = device.label;
          } catch(error) {
            this.log.warn(`Error getting device name for ${device.label}: ${error}`);
            deviceName = device.label;
          }
          if (this.config.IgnoreDevices &&
            this.config.IgnoreDevices.find(d => d.toLowerCase() === deviceName.toLowerCase())) {
            this.log.info(`Ignoring ${device.label} because it is in the Ignore Devices list`);
            return;
          }

          if (!this.locationIDsToIgnore.find(locationID => device.locationId === locationID)) {
            this.log.debug('Pushing ' + device.label);
            devices.push(device);
          } else {
            this.log.info(`Ignoring ${device.label} because it is in a location to ignore (${device.locationId})`);
          }
    });
    this.log.debug('Stored all devices.');
    return devices;
  }

  private isDeviceIgnored(device: any): boolean {
    return !!device && (device.type === 'MATTER' ||
      !!this.config.IgnoreDevices?.find(d => d.toLowerCase() === (device.label || '').toLowerCase()) ||
      this.locationIDsToIgnore.includes(device.locationId));
  }

  public usesLocalReads(deviceId: string): boolean {
    return !!this.localHub && (!this.localDeviceIds || this.localDeviceIds.has(deviceId));
  }

  public isKnownLocalDevice(deviceId: string): boolean {
    return !!this.localHub && this.localDeviceIds?.has(deviceId) === true;
  }

  public hasLocalEventsFor(deviceId: string): boolean {
    return this.localEventsConnected && this.usesLocalReads(deviceId);
  }

  public async getLocalStatus(deviceId: string): Promise<any> {
    if (!this.localHub) {
      throw new Error('Local hub unavailable');
    }
    return this.localHub.get(`/devices/${encodeURIComponent(deviceId)}/status`);
  }

  /** Route a command once; an uncertain local result is never retried in the cloud. */
  public async sendDeviceCommands(deviceId: string, commands: LocalHubCommand[], localOnly = false): Promise<'local' | 'cloud'> {
    if (this.removedDeviceIds.has(deviceId)) {
      throw new Error('Device no longer in the SmartThings catalog');
    }
    try {
      if (this.localHub) {
        if (!this.localDeviceIds) {
          await this.refreshLocalDeviceIds();
        }
        if (!this.localDeviceIds) {
          if (this.localHub.unavailableError) {
            throw this.localHub.unavailableError;
          }
          throw new Error('Local device list unavailable');
        }
        if (this.localDeviceIds.has(deviceId)) {
          await this.localHub.executeCommands(deviceId, commands);
          return 'local';
        }
      }
      if (localOnly) {
        throw new Error('Device is not available through the local hub');
      }
      // Devices not listed by the hub keep their existing cloud control until reviewed.
      await this.axInstance.post(`devices/${encodeURIComponent(deviceId)}/commands`, JSON.stringify({ commands }));
      return 'cloud';
    } catch (error) {
      this.refreshCatalogOnForbidden(deviceId, error);
      throw error;
    }
  }

  public async getDeviceData<T>(deviceId: string, resource: 'status' | 'health', validate?: (value: T) => boolean): Promise<T> {
    if (this.removedDeviceIds.has(deviceId)) {
      throw new Error('Device no longer in the SmartThings catalog');
    }
    if (this.localHub && !this.localDeviceIds && Date.now() >= this.localDiscoveryRetryAt) {
      await this.refreshLocalDeviceIds();
    }
    if (this.localHub?.unavailableError && !this.localDeviceIds) {
      throw this.localHub.unavailableError;
    }
    const resourceKey = `${deviceId}:${resource}`;
    if (this.localHub && this.localDeviceIds?.has(deviceId) &&
      (this.localHub.unavailableError || Date.now() >= (this.localResourceRetryAt.get(resourceKey) || 0))) {
      try {
        const data = await this.localHub.get<T>(`/devices/${encodeURIComponent(deviceId)}/${resource}`);
        if (!data || (resource === 'status' && !(data as any).components) ||
          (resource === 'health' && typeof (data as any).state !== 'string') || (validate && !validate(data))) {
          throw new Error(`Invalid local ${resource} response`);
        }
        this.localResourceRetryAt.delete(resourceKey);
        this.log.debug(`Received local ${resource} for ${deviceId}`);
        return data;
      } catch (error) {
        if (error instanceof LocalHubUnavailableError) {
          throw error;
        }
        this.refreshCatalogOnForbidden(deviceId, error);
        // A failing device or resource must not prevent other devices from using the hub.
        this.localResourceRetryAt.set(resourceKey, Date.now() + 30000);
        this.log.debug(`Local ${resource} unavailable for ${deviceId}, trying cloud: ${error}`);
      }
    }
    try {
      const response = await this.axInstance.get(`devices/${encodeURIComponent(deviceId)}/${resource}`);
      return response.data as T;
    } catch (error) {
      this.refreshCatalogOnForbidden(deviceId, error);
      throw error;
    }
  }

  unregisterDevices(devices, all = false) {
    const accessoriesToRemove: PlatformAccessory[] = [];

    //
    // Loop through each accessory.  If they are not present in the list
    // of current devices, then unregister them.
    //
    this.accessories.forEach(accessory => {
      if (all) {
        this.log.info('Unregistering all devices');
        this.log.info('Will unregister ' + accessory.context.device.label);
        accessoriesToRemove.push(accessory);
      }
      if (!devices.find(device => {
        return device.deviceId === accessory.UUID;
      })) {
        this.log.info('Will unregister ' + accessory.context.device.label);
        accessoriesToRemove.push(accessory);
      }
    });

    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove);
    }
  }

  /**
   * Register discovered accessories and restore their service handlers.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices(devices) {

    devices.forEach((device) => {

      if (this.removedDeviceIds.has(device.deviceId)) {
        return;
      }

      this.log.debug('DEVICE DATA: ' + JSON.stringify(device));

      if (this.findSupportedCapability(device)) {
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === device.deviceId);

        if (existingAccessory) {
          // the accessory already exists
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

          // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
          existingAccessory.context.device = device;
          this.api.updatePlatformAccessories([existingAccessory]);

          // create the accessory handler for the restored accessory
          this.accessoryObjects.push(this.createAccessoryObject(device, existingAccessory));

        } else {
          // the accessory does not yet exist, so we need to create it
          this.log.info('Registering new accessory: ' + device.label);

          // create a new accessory
          const accessory = new this.api.platformAccessory(device.label, device.deviceId);

          // store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = device;

          // create the accessory handler for the newly create accessory

          this.accessoryObjects.push(this.createAccessoryObject(device, accessory));

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
      }
    });
  }

  findSupportedCapability(device): boolean {
    // Look at capabilities on all components.

    let found = false;
    device.components.forEach(component => {
      if (!found && component.capabilities.find((ca) => MultiServiceAccessory.capabilitySupported(ca.id))) {
        found = true;
      }
    });
    return found;
  }

  createAccessoryObject(device, accessory): MultiServiceAccessory {
    const acc = new MultiServiceAccessory(this, accessory);
    device.components.forEach(component => {
      acc.addComponent(component.id, component.capabilities.map((c) => c.id));
    });

    return acc;
  }
}

