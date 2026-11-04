import { PlatformAccessory, Characteristic, Logger, API } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from './platform';
import { BaseService } from './services/baseService';
// import { BasePlatformAccessory } from './basePlatformAccessory';
import { MotionService } from './services/motionService';
import { BatteryService } from './services/batteryService';
import { TemperatureService } from './services/temperatureService';
import { HumidityService } from './services/humidityService';
import { LightSensorService } from './services/lightSensorService';
import { ContactSensorService } from './services/contactSensorService';
import { LockService } from './services/lockService';
import { DoorService } from './services/doorService';
import { SwitchService } from './services/switchService';
import { LightService } from './services/lightService';
import { FanSwitchLevelService } from './services/fanSwitchLevelService';
import { OccupancySensorService } from './services/occupancySensorService';
import { LeakDetectorService } from './services/leakDetector';
import { SmokeDetectorService } from './services/smokeDetector';
import { CarbonMonoxideDetectorService } from './services/carbonMonoxideDetector';
import { ValveService } from './services/valveService';
import { ShortEvent } from './shortEvent';
import { FanSpeedService } from './services/fanSpeedService';
import { WindowCoveringService } from './services/windowCoveringService';
import { ThermostatService } from './services/thermostatService';
import { StatelessProgrammableSwitchService } from './services/statelessProgrammableSwitchService';
import { AirConditionerService } from './services/airConditionerService';
import { AirQualityService } from './services/airQualityService';
import { Command } from './services/smartThingsCommand';
import { LocalCommandTiming } from './localHubClient';
import { performance } from 'node:perf_hooks';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
// export class MultiServiceAccessory extends BasePlatformAccessory {
interface Component {
  componentId: string;
  capabilities: string[];
  status: Record<string, unknown>;
}

// Attributes read by the services below. Other capabilities may be command-only
// or optional and are not required for a local status response.
const STATUS_ATTRIBUTES: Record<string, string[]> = {
  switch: ['switch'], switchLevel: ['level'], colorControl: ['hue', 'saturation'],
  colorTemperature: ['colorTemperature'], fanSpeed: ['fanSpeed'],
  doorControl: ['door'], lock: ['lock'], valve: ['valve'],
  windowShade: ['windowShade'], windowShadeLevel: ['shadeLevel'],
  motionSensor: ['motion'], waterSensor: ['water'], smokeDetector: ['smoke'],
  carbonMonoxideDetector: ['carbonMonoxide'], presenceSensor: ['presence'],
  temperatureMeasurement: ['temperature'], relativeHumidityMeasurement: ['humidity'],
  illuminanceMeasurement: ['illuminance'], contactSensor: ['contact'], battery: ['battery'],
  carbonDioxideMeasurement: ['carbonDioxide'], dustSensor: ['fineDustLevel'], button: ['button'],
  thermostatMode: ['thermostatMode'], thermostatHeatingSetpoint: ['heatingSetpoint'],
  thermostatCoolingSetpoint: ['coolingSetpoint'], airConditionerMode: ['airConditionerMode'],
  airConditionerFanMode: ['fanMode'], fanOscillationMode: ['fanOscillationMode'],
  'custom.airConditionerOptionalMode': ['acOptionalMode'],
};

const STRING_VALUES: Record<string, string[]> = {
  switch: ['on', 'off'], doorControl: ['open', 'closed', 'opening', 'closing'],
  lock: ['locked', 'unlocked', 'unlocked with timeout', 'unknown'], valve: ['open', 'closed'],
  windowShade: ['open', 'closed', 'opening', 'closing', 'partially open'],
  motionSensor: ['active', 'inactive'], waterSensor: ['wet', 'dry'],
  smokeDetector: ['detected', 'clear', 'tested'], carbonMonoxideDetector: ['detected', 'clear', 'tested'],
  presenceSensor: ['present', 'not present'], contactSensor: ['open', 'closed'],
  thermostatMode: ['off', 'heat', 'cool', 'auto', 'emergency heat'],
  airConditionerMode: ['off', 'heat', 'cool', 'auto', 'dry', 'fanOnly'],
  airConditionerFanMode: ['auto', 'low', 'medium', 'high', 'turbo'],
  fanOscillationMode: ['all', 'fixed', 'vertical'],
  'custom.airConditionerOptionalMode': ['off', 'sleep', 'speed', 'windFree', 'windFreeSleep'],
};

function validEvent(event: ShortEvent): boolean {
  if (!STATUS_ATTRIBUTES[event.capability]?.includes(event.attribute)) {
    return false;
  }
  if (event.capability === 'button') {
    return typeof event.value === 'string' && /^(pushed|down|held)(?:_[a-z0-9]+)?$/i.test(event.value);
  }
  if (STRING_VALUES[event.capability]) {
    return typeof event.value === 'string' && STRING_VALUES[event.capability].includes(event.value);
  }
  return typeof event.value === 'number' && Number.isFinite(event.value);
}

export class MultiServiceAccessory {
  //  service: Service;
  //capabilities;
  components: Component[] = [];

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */

  private services: BaseService[] = [];

  // Order of these matters.  Make sure secondary capabilities like 'battery' and 'contactSensor' are at the end.
  private static capabilityMap = {
    'doorControl': DoorService,
    'lock': LockService,
    'switch': SwitchService,
    'windowShadeLevel': WindowCoveringService,
    'windowShade': WindowCoveringService,
    'motionSensor': MotionService,
    'waterSensor': LeakDetectorService,
    'smokeDetector': SmokeDetectorService,
    'carbonMonoxideDetector': CarbonMonoxideDetectorService,
    'presenceSensor': OccupancySensorService,
    'temperatureMeasurement': TemperatureService,
    'relativeHumidityMeasurement': HumidityService,
    'illuminanceMeasurement': LightSensorService,
    'contactSensor': ContactSensorService,
    'button': StatelessProgrammableSwitchService,
    'battery': BatteryService,
    'valve': ValveService,
    'carbonDioxideMeasurement': AirQualityService,
    'dustSensor': AirQualityService,
  };

  // Maps combinations of supported capabilities to a service
  private static comboCapabilityMap = [
    {
      capabilities: [
        'switch',
        'airConditionerMode',
        'airConditionerFanMode',
        'thermostatCoolingSetpoint',
        'temperatureMeasurement',
      ],
      optionalCapabilities: [
        'fanOscillationMode',
        'relativeHumidityMeasurement',
        'custom.airConditionerOptionalMode',
      ],
      service: AirConditionerService,
    },
    {
      capabilities: ['switch', 'fanSpeed', 'switchLevel'],
      service: FanSwitchLevelService,
    },
    {
      capabilities: ['switch', 'fanSpeed'],
      service: FanSpeedService,
    },
    {
      capabilities: ['switch', 'switchLevel'],
      optionalCapabilities: ['colorControl', 'colorTemperature'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorControl'],
      optionalCapabilities: ['colorTemperature'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'colorTemperature'],
      optionalCapabilities: ['colorControl'],
      service: LightService,
    },
    {
      capabilities: ['switch', 'valve'],
      service: ValveService,
    },
    {
      capabilities: ['carbonDioxideMeasurement', 'dustSensor'],
      service: AirQualityService,
    },
    {
      capabilities: ['temperatureMeasurement',
        'thermostatMode',
        'thermostatHeatingSetpoint',
        'thermostatCoolingSetpoint'],
      service: ThermostatService,
    },
    {
      // There is a heater out there that just supports thermostatMode and thermostatHeatingSetpoint
      capabilities: ['temperatureMeasurement',
        'thermostatHeatingSetpoint'],
      service: ThermostatService,
    },
    {
      capabilities: ['windowShade', 'windowShadeLevel'],
      service: WindowCoveringService,
    },
    {
      capabilities: ['windowShade', 'switchLevel'],
      service: WindowCoveringService,
    },
  ];

  protected accessory: PlatformAccessory;
  protected platform: IKHomeBridgeHomebridgePlatform;
  public readonly name: string;
  protected characteristic: typeof Characteristic;
  protected log: Logger;
  protected api: API;
  protected online = true;
  //protected deviceStatus: DeviceStatus = { timestamp: 0, status: undefined };
  protected deviceStatusTimestamp = 0;
  protected failureCount = 0;
  protected commandInProgress = false;
  private commandTail: Promise<void> = Promise.resolve();

  protected statusQueryInProgress = false;
  protected lastStatusResult = true;
  private eventRevision = 0;
  private hasReceivedEvent = false;
  private readonly eventAttributes = new Map<string, { revision: number; time?: number; receivedAt: number; value: any }>();
  private readonly eventIds = new Set<string>();

  get id() {
    return this.accessory.UUID;
  }

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    // capabilities,
  ) {

    this.accessory = accessory;
    this.platform = platform;
    this.name = accessory.context.device.label;
    this.log = platform.log;
    this.api = platform.api;
    this.characteristic = platform.Characteristic;

    // set accessory information
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, accessory.context.device.manufacturerName)
      .setCharacteristic(platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(platform.Characteristic.SerialNumber, 'Default-Serial');

    // // Find out if we are online
    this.platform.getDeviceData<{ state: string }>(this.id, 'health')
      .then(health => {
        if (this.hasReceivedEvent) {
          return;
        }
        if (health.state === 'ONLINE') {
          this.online = true;
        } else {
          this.online = false;
        }
      }).catch(error => {
        this.log.warn(`Could not get health for ${this.name}: ${error}`);
      });
  }

  private registerServiceIfMatchesCapabilities(
    componentId: string,
    component: Component,
    capabilitiesToCover: string[],
    capabilities: string[],
    optionalCapabilities: string[],
    serviceConstructor: new (...args: any[]) => BaseService,
  ): string[] {
    // this.log.debug(`Testing ${serviceConstructor.name} for capabilities ${capabilitiesToCover}`);
    // ignore services which cannot cover all required capabilities
    if (!capabilities.every(e => capabilitiesToCover.includes(e))) {
      // this.log.debug(`Ignoring ${serviceConstructor.name}`);
      return capabilitiesToCover;
    }

    const allCapabilities = capabilities.concat(optionalCapabilities.filter(e => capabilitiesToCover.includes(e)));

    this.log.debug(`Creating instance of ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    const serviceInstance = new serviceConstructor(this.platform, this.accessory, componentId, allCapabilities, this, this.name, component);
    this.services.push(serviceInstance);

    this.log.debug(`Registered ${serviceConstructor.name} for capabilities ${allCapabilities}`);
    // remove covered capabilities and return unused
    return capabilitiesToCover.filter(e => !allCapabilities.includes(e));
  }

  public addComponent(componentId: string, capabilities: string[]) {
    const component = {
      componentId,
      capabilities,
      status: {},
    };
    this.components.push(component);


    let capabilitiesToCover = [...capabilities];

    // Start with comboServices and remove used capabilities to avoid duplicated sensors.
    // For example, there is no need to expose a temperature sensor in case of a thermostat which already exposes that charateristic.
    MultiServiceAccessory.comboCapabilityMap
      .sort((a, b) => a.capabilities.length > b.capabilities.length ? -1 : 1) // services with larger capability set first
      .forEach(entry => {
        capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
          componentId,
          component,
          capabilitiesToCover,
          entry.capabilities,
          entry.optionalCapabilities || [],
          entry.service,
        );
      });

    Object.keys(MultiServiceAccessory.capabilityMap).forEach((capability) => {
      const service = MultiServiceAccessory.capabilityMap[capability];
      capabilitiesToCover = this.registerServiceIfMatchesCapabilities(
        componentId,
        component,
        capabilitiesToCover,
        [capability],
        [],
        service,
      );
    });
  }

  public isOnline(): boolean {
    return this.online;
  }

  // Find return if a capability is supported by the multi-service accessory
  public static capabilitySupported(capability: string): boolean {
    if (Object.keys(MultiServiceAccessory.capabilityMap).find(c => c === capability)) {
      return true;
    } else {
      return false;
    }
  }

  // public async refreshStatus(): Promise<boolean> {
  //   return super.refreshStatus();
  // }

  // Called by subclasses to refresh the status for the device.  Will only refresh if it has been more than
  // 4 seconds since last refresh
  //
  async refreshStatus(): Promise<boolean> {
    this.log.debug(`Refreshing status for ${this.name} - current timestamp is ${this.deviceStatusTimestamp}`);

    if (Date.now() - this.deviceStatusTimestamp <= 5000) {
      return true;
    }

    if (this.statusQueryInProgress) {
      this.log.debug(`Status query already in progress for ${this.name}.  Waiting...`);
      await this.waitFor(() => !this.statusQueryInProgress);
      return this.lastStatusResult;
    }

    this.log.debug(`Calling Smartthings to get an update for ${this.name}`);
    this.statusQueryInProgress = true;
    await this.waitFor(() => !this.commandInProgress);
    const requestRevision = this.eventRevision;

    try {
      const status = await this.platform.getDeviceData<{ components: Record<string, Record<string, unknown>> }>(
        this.id, 'status', data => this.components.every(component => {
          const componentStatus = data.components?.[component.componentId];
          if (!componentStatus || typeof componentStatus !== 'object') {
            return false;
          }
          // Unavailable attributes are handled by their individual characteristics.
          return !Array.isArray(componentStatus);
        }),
      );
      const componentsStatus = status.components;
      this.components.forEach(component => {
        if (componentsStatus[component.componentId] !== undefined) {
          const next = componentsStatus[component.componentId];
          for (const [key, saved] of this.eventAttributes) {
            const [componentId, capability, attribute] = JSON.parse(key) as string[];
            if (componentId !== component.componentId) {
              continue;
            }
            const snapshot = (next as any)[capability]?.[attribute];
            const snapshotTime = typeof snapshot?.timestamp === 'string' ? Date.parse(snapshot.timestamp) : NaN;
            if (saved.revision > requestRevision || (saved.time !== undefined &&
              (!Number.isFinite(snapshotTime) || snapshotTime < saved.time))) {
              (next as any)[capability] ||= {};
              (next as any)[capability][attribute] = saved.value;
            }
          }
          component.status = next;
          this.deviceStatusTimestamp = Date.now();
          this.log.debug(`Updated status for ${this.name}-${component.componentId}: ${JSON.stringify(component.status)}`);
        } else {
          this.log.error(`Failed to get status for ${this.name}-${component.componentId}`);
        }
      });
      this.failureCount = 0;
      this.lastStatusResult = true;
      return true;
    } catch (error) {
      this.failureCount++;
      this.log.error(`Failed to request status from ${this.name}: ${error}.  This is failure number ${this.failureCount}`);
      if (this.failureCount >= 5) {
        this.log.error(`Exceeded allowed failures for ${this.name}.  Device is offline`);
        this.online = false;
      }
      this.lastStatusResult = false;
      return false;
    } finally {
      this.statusQueryInProgress = false;
    }
  }

  public forceNextStatusRefresh() {
    this.deviceStatusTimestamp = 0;
  }

  public hasRecentLocalEvent(componentId: string, capability: string, attribute: string): boolean {
    if (!this.platform.hasLocalEventsFor(this.id)) {
      return false;
    }
    const saved = this.eventAttributes.get(JSON.stringify([componentId, capability, attribute]));
    const current = this.components.find(component => component.componentId === componentId)?.status?.[capability]?.[attribute];
    return !!saved && Date.now() >= saved.receivedAt && Date.now() - saved.receivedAt <= 5000 && current === saved.value;
  }


  /** Recheck an offline device on demand, at reconnect, or when a valid event arrives. */
  public async ensureOnline(): Promise<boolean> {
    if (this.online) {
      return true;
    }
    try {
      const health = await this.platform.getDeviceData<{ state: string }>(this.id, 'health');
      if (health.state === 'ONLINE') {
        this.online = true;
        this.failureCount = 0;
      }
    } catch (error) {
      this.log.debug(`Could not recheck health for ${this.name}: ${error}`);
    }
    return this.online;
  }

  async sendCommand(capability: string, command: string, args?: unknown[], componentId?: string): Promise<boolean> {
    const cmd = new Command(capability, command, args, componentId);
    return this.sendCommands([cmd]);
  }

  async sendCommands(commands: Command[], componentId?: string, localOnly = false): Promise<boolean> {
    const timed = commands.length === 1 && commands[0].capability === 'switch' &&
      (commands[0].command === 'on' || commands[0].command === 'off');
    const startedAt = timed ? new Date().toISOString() : '';
    const started = performance.now();
    let transportTiming: LocalCommandTiming | undefined;
    let accepted = false;
    // Reserve our place before yielding so simultaneous HomeKit writes stay ordered.
    const previous = this.commandTail || Promise.resolve();
    let release: () => void = () => {};
    this.commandTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const commandQueueMs = performance.now() - started;
    this.commandInProgress = true;
    try {
      const routed = commands.map(command => componentId && !command.component
        ? { ...command, component: componentId } : command);
      const route = await this.platform.sendDeviceCommands(this.id, routed, localOnly,
        timed ? timing => {
          transportTiming = timing;
        } : undefined);
      accepted = true;
      this.log.info(`SmartThings command accepted via ${route} for ${this.name}`);
      // An accepted command is not a confirmed state. While local events are
      // connected, retain the last snapshot and let the event update it.
      // Otherwise the next read must refresh as before.
      if (route !== 'local' || !this.platform.hasLocalEventsFor(this.id)) {
        this.forceNextStatusRefresh();
      }
      return true;
    } catch (error) {
      this.log.error(`${JSON.stringify(commands)} failed for ${this.name}: ${error}`);
      return false;
    } finally {
      this.commandInProgress = false;
      release();
      if (transportTiming) {
        const ms = (value?: number) => value === undefined ? 'n/a' : value.toFixed(1);
        try {
          this.log.info(`Local switch timing start=${startedAt} device=${JSON.stringify(this.name)} ` +
            `component=${JSON.stringify(commands[0].component ?? componentId ?? 'main')} command=${commands[0].command} ` +
            `outcome=${accepted ? 'accepted' : 'failed'} deviceQueueMs=${ms(commandQueueMs)} ` +
            `hubQueueMs=${ms(transportTiming.queueMs)} prepareMs=${ms(transportTiming.prepareMs)} ` +
            `connectMs=${ms(transportTiming.connectMs)} responseMs=${ms(transportTiming.responseMs)} ` +
            `totalMs=${ms(performance.now() - started)}`);
        } catch { /* Diagnostics must not affect command handling. */ }
      }
    }
  }

  // Wait for the condition to be true.  Will check every 500 ms
  private async waitFor(condition: () => boolean): Promise<void> {
    if (condition()) {
      return;
    }

    this.log.debug(`${this.name} command or request is waiting...`);
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (condition()) {
          this.log.debug(`${this.name} command or request is proceeding.`);
          clearInterval(interval);
          resolve();
        }
        this.log.debug(`${this.name} still waiting...`);
      }, 250);
    });
  }

  public processEvent(event: ShortEvent): boolean {
    if (event.deviceId !== this.id || !validEvent(event) || (event.eventId && this.eventIds.has(event.eventId))) {
      return false;
    }
    const component = this.components.find(c => c.componentId === event.componentId && c.capabilities.includes(event.capability));
    if (!component) {
      return false;
    }
    const key = JSON.stringify([event.componentId, event.capability, event.attribute]);
    const previous = this.eventAttributes.get(key);
    const eventTime = typeof event.eventTime === 'number' && Number.isFinite(event.eventTime) &&
      Math.abs(event.eventTime) <= 8640000000000000 ? event.eventTime : undefined;
    const currentAttribute = (component.status as any)[event.capability]?.[event.attribute];
    const currentTime = typeof currentAttribute?.timestamp === 'string' ? Date.parse(currentAttribute.timestamp) : NaN;
    if (eventTime !== undefined && ((previous?.time !== undefined && previous.time > eventTime) ||
      (Number.isFinite(currentTime) && currentTime > eventTime))) {
      return false;
    }
    if (event.eventId) {
      this.eventIds.add(event.eventId);
      if (this.eventIds.size > 1024) {
        this.eventIds.delete(this.eventIds.values().next().value!);
      }
    }
    this.online = true;
    this.failureCount = 0;
    this.hasReceivedEvent = true;
    if (event.capability !== 'button') {
      const status = component.status as any;
      status[event.capability] ||= {};
      const value = { ...currentAttribute, value: event.value,
        ...(event.unit ? { unit: event.unit } : {}), ...(event.data !== undefined ? { data: event.data } : {}),
        ...(eventTime !== undefined ? { timestamp: new Date(eventTime).toISOString() } : {}) };
      status[event.capability][event.attribute] = value;
      this.eventAttributes.set(key, { revision: ++this.eventRevision, time: eventTime, receivedAt: Date.now(), value });
    }
    return this.dispatchEvent(event);
  }

  private dispatchEvent(event: ShortEvent): boolean {
    // Observe actual synchronous HAP changes without replacing service methods.
    let applied = false;
    const onChange = () => {
      applied = true;
    };
    const observed = this.accessory.services || [];
    observed.forEach(service => service.on('characteristic-change', onChange));
    try {
      this.services.filter(s => s.componentId === event.componentId && s.capabilities.includes(event.capability))
        .forEach(service => {
          try {
            service.processEvent(event);
          } catch (error) {
            this.log.warn(`Could not process ${event.capability}.${event.attribute} for ${this.name}: ${error}`);
          }
        });
    } finally {
      observed.forEach(service => service.removeListener('characteristic-change', onChange));
    }
    return applied;
  }

  /** Fetch and publish current state after reconnect; stateless button presses are never replayed. */
  public async resyncState(): Promise<boolean> {
    if (!await this.ensureOnline()) {
      return false;
    }
    this.forceNextStatusRefresh();
    if (!await this.refreshStatus()) {
      return false;
    }
    this.components.forEach(component => Object.entries(component.status).forEach(([capability, attributes]) => {
      if (capability === 'button' || !attributes || typeof attributes !== 'object') {
        return;
      }
      Object.entries(attributes as Record<string, any>).forEach(([attribute, value]) => {
        if ((component.status as any)[capability]?.[attribute] !== value) {
          return; // A newer event replaced this attribute during snapshot dispatch.
        }
        const event: ShortEvent = { deviceId: this.id, componentId: component.componentId, capability, attribute,
          value: value?.value, unit: value?.unit };
        if (validEvent(event)) {
          this.dispatchEvent(event);
        }
      });
    }));
    return true;
  }

}
