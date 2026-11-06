import type { API, Logger, MatterAccessory, MatterAPI } from 'homebridge';
import { setTimeout } from 'node:timers/promises';
import type { MultiServiceAccessory } from './multiServiceAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Command } from './services/smartThingsCommand';
import { smartThingsToXy, xyToSmartThings } from './matterColor';
import { withSmartThingsLevelControl, type WriteStep } from './matterLevelControl';

type Component = MultiServiceAccessory['components'][number];
type Attributes = Record<string, unknown>;
type Clusters = NonNullable<MatterAccessory['clusters']>;
type Reading = { value?: unknown; unit?: string; timestamp?: string };
type DeviceMetadata = {
  components?: Array<{ id: string; label?: string; categories?: Array<{ name: string }> }>;
  manufacturerName?: string;
};
type Device = { device: MultiServiceAccessory; metadata: DeviceMetadata };
type Cluster = { name: string; capabilities: string[]; read: () => Attributes | undefined; initial: Attributes };
type Endpoint = {
  kind: string;
  type: MatterAccessory['deviceType'];
  clusters: Cluster[];
  handlers?: MatterAccessory['handlers'];
};
type Entry = { accessory: MatterAccessory; endpoint: Endpoint; componentId: string; applied: Map<string, string> };
type CommandWriter = (commands: Command[]) => Promise<boolean>;
type SendCommand = (capability: string, command: string, args?: unknown[], write?: CommandWriter) => Promise<void>;

const powerOnlyCategories = new Set(['Light', 'LightSwitch', 'SmartPlug', 'Outlet', 'Switch', 'DimmerSwitch', 'Other', 'Others']);
const complexSwitchCapabilities = new Set([
  'airConditionerMode', 'doorControl', 'fanSpeed', 'lock', 'ovenMode', 'robotCleanerMovement', 'thermostatMode',
  'tvChannel', 'valve', 'windowShade', 'windowShadeLevel', 'mediaInputSource',
]);
// Matter ColorMode values (enhancedColorMode uses the same values for these modes).
const HUE_SATURATION = 0;
const COLOR_TEMPERATURE = 2;
const LEVEL_MAX = 254;
const SWITCH_LEVEL_STEP = 'statelessSwitchLevelStep';
const CT_MIN = 153;
const CT_MAX = 500;

function read(component: Component, capability: string, attribute: string): Reading | undefined {
  const attrs = component.status[capability] as Record<string, Reading> | undefined;
  return attrs?.[attribute];
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function binary(value: unknown, positive: string, negative: string): boolean | undefined {
  return value === positive ? true : value === negative ? false : undefined;
}

function timestamp(reading?: Reading): number {
  return (reading?.timestamp && Date.parse(reading.timestamp)) || 0;
}

function temperatureRange(component: Component): { min: number; max: number } {
  const attr = read(component, 'colorTemperature', 'colorTemperatureRange');
  const range = attr?.value as { minimum?: unknown; maximum?: unknown } | undefined;
  const minK = numberIn(range?.minimum, 1000, 100000);
  const maxK = numberIn(range?.maximum, 1000, 100000);
  if ((attr?.unit && attr.unit !== 'K') || minK === undefined || maxK === undefined || minK > maxK) {
    return { min: CT_MIN, max: CT_MAX };
  }
  const min = Math.ceil(1000000 / maxK);
  const max = Math.max(min, Math.floor(1000000 / minK));
  return { min, max };
}

function fitLabel(label: string, maxBytes: number): string {
  let result = '';
  for (const char of label) {
    if (Buffer.byteLength(result + char) > maxBytes) {
      break;
    }
    result += char;
  }
  return result;
}

function sensorEndpoints(matter: MatterAPI, component: Component): Endpoint[] {
  const out: Endpoint[] = [];
  const add = (cap: string, attr: string, kind: string, type: Endpoint['type'], name: string,
    initial: Attributes, convert: (reading: Reading) => Attributes | undefined) => {
    if (component.capabilities.includes(cap)) {
      out.push({ kind, type, clusters: [{ name, initial, capabilities: [cap], read: () => convert(read(component, cap, attr) ?? {}) }] });
    }
  };
  const measured = { measuredValue: null };
  const binaryAttribute = (key: string, positive: string, negative: string) => ({ value }: Reading) => {
    const state = binary(value, positive, negative);
    return state === undefined ? undefined : { [key]: state };
  };
  const types = matter.deviceTypes;
  add('contactSensor', 'contact', 'Contact', types.ContactSensor, 'booleanState', { stateValue: false },
    binaryAttribute('stateValue', 'closed', 'open'));
  add('waterSensor', 'water', 'Leak', types.LeakSensor, 'booleanState', { stateValue: false },
    binaryAttribute('stateValue', 'wet', 'dry'));
  const occupancy = (positive: string, negative: string) => ({ value }: Reading) => {
    const occupied = binary(value, positive, negative);
    return occupied === undefined ? undefined : { occupancy: { occupied } };
  };
  const motion = component.capabilities.includes('motionSensor');
  if (motion || component.capabilities.includes('presenceSensor')) {
    // Matter 1.4+ requires a sensing feature before the device includes this cluster.
    const base = types.MotionSensor;
    const type = base.with(base.requirements.server.mandatory.OccupancySensing.with('Other'));
    // The legacy attributes represent Other as PIR (Matter 1.4, section 2.7.6.2).
    const initial = { occupancy: { occupied: false }, occupancySensorType: 0, occupancySensorTypeBitmap: { pir: true } };
    if (motion) {
      add('motionSensor', 'motion', 'Motion', type, 'occupancySensing', initial, occupancy('active', 'inactive'));
    } else {
      add('presenceSensor', 'presence', 'Occupancy', type, 'occupancySensing', initial, occupancy('present', 'not present'));
    }
  }
  add('temperatureMeasurement', 'temperature', 'Temperature', types.TemperatureSensor, 'temperatureMeasurement', measured,
    ({ value, unit }) => {
      if (typeof value !== 'number' || (unit !== 'C' && unit !== 'F')) {
        return undefined;
      }
      const celsius = numberIn(unit === 'F' ? (value - 32) * 5 / 9 : value, -273.15, 327.67);
      return celsius === undefined ? undefined : { measuredValue: Math.round(celsius * 100) };
    });
  add('relativeHumidityMeasurement', 'humidity', 'Humidity', types.HumiditySensor, 'relativeHumidityMeasurement', measured,
    ({ value }) => {
      const percent = numberIn(value, 0, 100);
      return percent === undefined ? undefined : { measuredValue: Math.round(percent * 100) };
    });
  add('illuminanceMeasurement', 'illuminance', 'Illuminance', types.LightSensor, 'illuminanceMeasurement', measured,
    ({ value }) => {
      const lux = numberIn(value, 0, Number.MAX_VALUE);
      return lux === undefined ? undefined : { measuredValue: lux < 1 ? 0 : Math.min(65534, Math.round(10000 * Math.log10(lux) + 1)) };
    });
  return out;
}

function airQualityEndpoint(matter: MatterAPI, component: Component): Endpoint | undefined {
  if (!component.capabilities.includes('carbonDioxideMeasurement') && !component.capabilities.includes('dustSensor')) {
    return undefined;
  }
  const base = matter.deviceTypes.AirQualitySensor;
  const optional = base.requirements.server.optional;
  // The mandatory rating is unknown; the optional clusters carry actual readings.
  const clusters: Cluster[] = [{ name: 'airQuality', initial: { airQuality: 0 }, capabilities: [], read: () => undefined }];
  const hasCo2 = component.capabilities.includes('carbonDioxideMeasurement');
  const hasDust = component.capabilities.includes('dustSensor');
  const type = base.with(
    ...(hasCo2 ? [optional.CarbonDioxideConcentrationMeasurement.with('NumericMeasurement')] : []),
    ...(hasDust ? [optional.Pm25ConcentrationMeasurement.with('NumericMeasurement')] : []),
  );
  if (hasCo2) {
    clusters.push({ name: 'carbonDioxideConcentrationMeasurement', capabilities: ['carbonDioxideMeasurement'],
      initial: { measuredValue: null, minMeasuredValue: 0, maxMeasuredValue: 1000000, measurementMedium: 0, measurementUnit: 0 },
      read: () => {
        const reading = read(component, 'carbonDioxideMeasurement', 'carbonDioxide');
        const ppm = numberIn(reading?.value, 0, 1000000);
        return ppm === undefined || (reading?.unit && reading.unit !== 'ppm') ? undefined : { measuredValue: ppm };
      },
    });
  }
  if (hasDust) {
    clusters.push({ name: 'pm25ConcentrationMeasurement', capabilities: ['dustSensor'],
      initial: { measuredValue: null, minMeasuredValue: 0, maxMeasuredValue: 100000, measurementMedium: 0, measurementUnit: 4 },
      read: () => {
        const reading = read(component, 'dustSensor', 'fineDustLevel');
        const density = numberIn(reading?.value, 0, 100000);
        return density === undefined || (reading?.unit && !/^[uµμ]g\/m(?:\^3|³|3)$/i.test(reading.unit))
          ? undefined : { measuredValue: density };
      },
    });
  }
  // Report the measured concentrations without inventing a combined quality rating.
  return { kind: 'Air Quality', type, clusters };
}

function brightnessStep(matter: MatterAPI, device: MultiServiceAccessory, component: Component, send: SendCommand): WriteStep {
  const power = () => binary(read(component, 'switch', 'switch')?.value, 'on', 'off');
  const brightness = () => read(component, 'switchLevel', 'level');

  return async (delta, withOnOff, minLevel) => {
    if (!component.capabilities.includes(SWITCH_LEVEL_STEP)) {
      throw new (matter.status?.Failure ?? Error)('SmartThings device does not support stepLevel');
    }
    const step = Math.sign(delta) * Math.round(Math.abs(delta) * 100 / LEVEL_MAX);
    if (!withOnOff) {
      return send(SWITCH_LEVEL_STEP, 'stepLevel', [step]);
    }

    await device.withCommandQueue(async write => {
      const on = power();
      const initial = numberIn(brightness()?.value, 0, 100);
      if (on === undefined || initial === undefined) {
        throw new (matter.status?.Failure ?? Error)('SmartThings lamp state unavailable');
      }
      // SmartThings reports integer percentages. Treat its first nonzero
      // percentage as the minimum representable level for power coupling.
      const minimum = Math.max(1, Math.round(minLevel * 100 / LEVEL_MAX));
      if (!on && initial + step > minimum) {
        await send('switch', 'on', undefined, write);
        if (!await device.confirmStatus(() => power() === true)) {
          throw new (matter.status?.Timeout ?? Error)('SmartThings did not confirm the lamp turned on');
        }
      }

      const before = brightness();
      const start = numberIn(before?.value, 0, 100) ?? initial;
      const target = Math.max(minimum, Math.min(100, start + step));
      await send(SWITCH_LEVEL_STEP, 'stepLevel', [step], write);
      if (power() !== true || (step >= 0 && target > minimum)) {
        return;
      }

      const reached = await device.confirmStatus(fromSnapshot => {
        const reading = brightness();
        const level = numberIn(reading?.value, 0, 100);
        return level !== undefined && (fromSnapshot || (reading !== before &&
          (level <= minimum || (target > minimum && level < start && level <= target + 1))));
      });
      if (!reached) {
        throw new (matter.status?.Timeout ?? Error)('SmartThings did not confirm the brightness step');
      }
      const level = numberIn(brightness()?.value, 0, 100);
      if (level !== undefined && level <= minimum && power() === true) {
        await send('switch', 'off', undefined, write);
        if (!await device.confirmStatus(() => power() === false)) {
          throw new (matter.status?.Timeout ?? Error)('SmartThings did not confirm the lamp turned off');
        }
      }
    });
  };
}

function switchEndpoint(matter: MatterAPI, component: Component, categories: string[], send: SendCommand,
  matterPower: () => Promise<boolean | undefined>, writeStep: WriteStep,
  writeTemperature: (commands: Command[], beforeSend: () => boolean) => Promise<boolean>,
): Endpoint | undefined {
  const capabilities = component.capabilities;
  if (!capabilities.includes('switch') || capabilities.some(c => complexSwitchCapabilities.has(c)) ||
    (categories.length && !categories.some(c => powerOnlyCategories.has(c)))) {
    return undefined;
  }
  const dimmable = capabilities.includes('switchLevel');
  const color = dimmable && capabilities.includes('colorControl') && capabilities.includes('colorTemperature');
  const temperature = dimmable && capabilities.includes('colorTemperature');
  const light = categories.includes('Light') || color || temperature || (dimmable && !categories.includes('SmartPlug'));
  const types = matter.deviceTypes;
  const baseType = color ? types.ExtendedColorLight : temperature ? types.ColorTemperatureLight : dimmable
    ? (light ? types.DimmableLight : types.DimmableOutlet) : (light ? types.OnOffLight : types.OnOffOutlet);
  let type: Endpoint['type'] = baseType;
  const clusters: Cluster[] = [{ name: 'onOff', initial: { onOff: false }, capabilities: ['switch'], read: () => {
    const onOff = binary(read(component, 'switch', 'switch')?.value, 'on', 'off');
    return onOff === undefined ? undefined : { onOff };
  } }];
  const measurements = [
    { capability: 'powerMeter', attribute: 'power', unit: 'W', matter: 'activePower' },
    { capability: 'voltageMeasurement', attribute: 'voltage', unit: 'V', matter: 'voltage' },
    { capability: 'currentMeasurement', attribute: 'current', unit: 'A', matter: 'activeCurrent' },
  ].filter(m => capabilities.includes(m.capability));
  if (!light && measurements.length) {
    clusters.push({ name: 'electricalPowerMeasurement',
      initial: Object.fromEntries([{ matter: 'activePower' }, ...measurements].map(m => [m.matter, null])),
      capabilities: measurements.map(m => m.capability), read: () => {
        const values: Attributes = {};
        for (const m of measurements) {
          const reading = read(component, m.capability, m.attribute);
          const value = numberIn(reading?.value, 0, Number.MAX_SAFE_INTEGER / 1000);
          if (value !== undefined && reading?.unit === m.unit) {
            values[m.matter] = Math.round(value * 1000);
          }
        }
        return Object.keys(values).length ? values : undefined;
      } });
  }
  if (!light && capabilities.includes('energyMeter')) {
    clusters.push({ name: 'electricalEnergyMeasurement', initial: { cumulativeEnergyImported: null },
      capabilities: ['energyMeter'], read: () => {
        const reading = read(component, 'energyMeter', 'energy');
        const multiplier = reading?.unit === 'kWh' ? 1000000 : reading?.unit === 'Wh' ? 1000 : undefined;
        if (multiplier === undefined) {
          return undefined;
        }
        const energy = numberIn(reading?.value, 0, Number.MAX_SAFE_INTEGER / multiplier);
        if (energy === undefined) {
          return undefined;
        }
        const time = reading?.timestamp ? Date.parse(reading.timestamp) : NaN;
        const seconds = Math.floor(time / 1000);
        return { cumulativeEnergyImported: { energy: Math.round(energy * multiplier),
          ...(Number.isFinite(seconds) && seconds >= 946684800 && seconds <= 5241655295 ? { endTimestamp: seconds } : {}) } };
      },
    });
  }
  const handlers: NonNullable<MatterAccessory['handlers']> = {
    onOff: {
      on: () => send('switch', 'on'),
      off: () => send('switch', 'off'),
      toggle: async () => {
        const current = await matterPower();
        if (current === undefined) {
          throw new Error('SmartThings switch state unavailable');
        }
        await send('switch', current ? 'off' : 'on');
      },
    },
  };
  if (dimmable) {
    clusters.push({ name: 'levelControl', initial: { currentLevel: 1, minLevel: 1, maxLevel: LEVEL_MAX },
      capabilities: ['switchLevel'], read: () => {
        const level = numberIn(read(component, 'switchLevel', 'level')?.value, 0, 100);
        return level === undefined ? undefined : { currentLevel: Math.max(1, Math.round(level * LEVEL_MAX / 100)) };
      },
    });
    // Homebridge's handler wrapper does not forward StepWithOnOff. Compose
    // the native level cluster with the SmartThings driver instead.
    type = withSmartThingsLevelControl(baseType, async (level, transitionTime) => {
      const percent = level === 0 ? 0 : Math.max(1, Math.round(level * 100 / LEVEL_MAX));
      // SmartThings Zigbee and Matter drivers use tenths of a second.
      await send('switchLevel', 'setLevel', [percent, transitionTime ?? 0]);
    }, writeStep);
  }
  if (temperature) {
    const { min, max } = temperatureRange(component);
    clusters.push({ name: 'colorControl', capabilities: ['colorTemperature', 'colorControl'],
      initial: { colorTempPhysicalMinMireds: min, colorTempPhysicalMaxMireds: max,
        coupleColorTempToLevelMinMireds: min, colorTemperatureMireds: max,
        colorMode: COLOR_TEMPERATURE, enhancedColorMode: COLOR_TEMPERATURE },
      read: () => {
        const temp = read(component, 'colorTemperature', 'colorTemperature');
        const kelvin = numberIn(temp?.value, 1000, 100000);
        const hue = read(component, 'colorControl', 'hue');
        const saturation = read(component, 'colorControl', 'saturation');
        const h = numberIn(hue?.value, 0, 100);
        const s = numberIn(saturation?.value, 0, 100);
        const state: Attributes = {};
        if (kelvin !== undefined && (!temp?.unit || temp.unit === 'K')) {
          state.colorTemperatureMireds = Math.max(min, Math.min(max, Math.round(1000000 / kelvin)));
        }
        if (color && h !== undefined && s !== undefined) {
          Object.assign(state, smartThingsToXy(h, s), { currentHue: Math.round(h * LEVEL_MAX / 100),
            currentSaturation: Math.round(s * LEVEL_MAX / 100) });
        }
        if (!Object.keys(state).length) {
          return undefined;
        }
        const mode = state.currentHue !== undefined && (state.colorTemperatureMireds === undefined ||
          Math.max(timestamp(hue), timestamp(saturation)) > timestamp(temp)) ? HUE_SATURATION : COLOR_TEMPERATURE;
        return { ...state, colorMode: mode, enhancedColorMode: mode };
      },
    });
    const colorHandlers: NonNullable<typeof handlers.colorControl> = {
      // matter.js also calls this when it switches between color modes.
      stopAllColorMovement: () => undefined,
      moveToColorTemperatureLogic: async ({ colorTemperatureMireds }) => {
        const requested = numberIn(colorTemperatureMireds, 1, 65279);
        if (requested === undefined) {
          throw new Error('Invalid Matter color temperature');
        }
        const isOn = () => read(component, 'switch', 'switch')?.value === 'on';
        if (!isOn()) {
          return;
        }
        const { min, max } = temperatureRange(component);
        await send('colorTemperature', 'setColorTemperature', [Math.round(1000000 / Math.max(min, Math.min(max, requested)))],
          async commands => {
            let skipped = false;
            const sent = await writeTemperature(commands, () => {
              skipped = !isOn();
              return !skipped;
            });
            return sent || skipped;
          });
      },
    };
    if (color) {
      const setColor = (hue: number, saturation: number) => send('colorControl', 'setColor', [{ hue, saturation }]);
      colorHandlers.moveToHueAndSaturationLogic = ({ hue, saturation }) =>
        setColor(Math.round(hue * 100 / LEVEL_MAX), Math.round(saturation * 100 / LEVEL_MAX));
      colorHandlers.moveToColorLogic = ({ targetX, targetY }) => {
        const { hue, saturation } = xyToSmartThings(targetX, targetY);
        return setColor(hue, saturation);
      };
      // Standalone hue/saturation writes keep the other value from the device.
      colorHandlers.moveToHueLogic = async ({ targetHue, isEnhancedHue }) => {
        const saturation = numberIn(read(component, 'colorControl', 'saturation')?.value, 0, 100);
        if (saturation === undefined) {
          throw new Error('SmartThings saturation unavailable');
        }
        await setColor(Math.round(targetHue * 100 / (isEnhancedHue ? 65535 : LEVEL_MAX)), saturation);
      };
      colorHandlers.moveToSaturationLogic = async ({ targetSaturation }) => {
        const hue = numberIn(read(component, 'colorControl', 'hue')?.value, 0, 100);
        if (hue === undefined) {
          throw new Error('SmartThings hue unavailable');
        }
        await setColor(hue, Math.round(targetSaturation * 100 / LEVEL_MAX));
      };
    }
    handlers.colorControl = colorHandlers;
  }
  return { kind: light ? 'Light' : 'Outlet', type, clusters, handlers };
}

/** Owns Matter endpoints; the existing SmartThings accessory remains the source of device state and commands. */
export class SmartThingsMatter {
  private readonly entries = new Map<string, Entry[]>();
  private readonly cached = new Map<string, MatterAccessory>();
  private readonly removed = new Set<string>();
  private stopped = false;
  private matter?: MatterAPI;

  constructor(private readonly api: API, private readonly log: Logger) {}

  restore(accessory: MatterAccessory): void {
    if (typeof accessory.context.smartThingsDeviceId === 'string') {
      this.cached.set(accessory.UUID, accessory);
    }
  }

  hasDevice(id: string): boolean {
    return this.entries.has(id);
  }

  close(): void {
    this.stopped = true;
  }

  async start(matter: MatterAPI, devices: Device[]): Promise<void> {
    this.matter = matter;
    const desired = devices.flatMap(({ device, metadata }) => this.describe(matter, device, metadata));
    const wanted = new Set(desired.map(([, entry]) => entry.accessory.UUID));
    await this.remove([...this.cached.values()].filter(accessory => !wanted.has(accessory.UUID)));
    // Homebridge can restore an endpoint without noticing newly added metering
    // clusters. Re-register it before publishing updates to those clusters.
    const changedMeters = desired.flatMap(([, entry]) => {
      const cached = this.cached.get(entry.accessory.UUID);
      if (!cached) {
        return [];
      }
      const names = ['electricalPowerMeasurement', 'electricalEnergyMeasurement'];
      const hasMeter = names.some(name => name in (entry.accessory.clusters ?? {}));
      const oldPower = cached.clusters?.electricalPowerMeasurement ?? {};
      const newPower = entry.accessory.clusters?.electricalPowerMeasurement ?? {};
      return (hasMeter && cached.context.smartThingsMeterVersion !== 1) ||
        names.some(name => (name in (cached.clusters ?? {})) !== (name in (entry.accessory.clusters ?? {}))) ||
        ['voltage', 'activeCurrent'].some(name => (name in oldPower) !== (name in newPower)) ? [cached] : [];
    });
    await this.remove(changedMeters);
    let published = 0;
    for (const [device, entry] of desired) {
      if (this.stopped) {
        return;
      }
      if (this.removed.has(device.id)) {
        continue;
      }
      const { accessory } = entry;
      try {
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        // Homebridge 2.1 queues registration and resolves the public call before
        // the endpoint is ready. Confirm it exists before publishing updates.
        for (let retry = 0; !this.stopped; retry++) {
          if (await matter.getAccessoryState(accessory.UUID, 'bridgedDeviceBasicInformation')) {
            break;
          }
          if (retry >= 40) {
            throw new Error('Homebridge did not register the endpoint');
          }
          await setTimeout(50, undefined, { ref: false });
        }
        if (this.stopped) {
          return;
        }
        if (this.removed.has(device.id)) {
          await this.remove([accessory]);
          continue;
        }
        const entries = this.entries.get(device.id) ?? [];
        entries.push(entry);
        this.entries.set(device.id, entries);
        published++;
        this.syncEntry(matter, device, entry);
      } catch (error) {
        this.log.warn(`Matter registration failed for ${accessory.displayName}: ${error}`);
      }
    }
    if (devices.length) {
      this.log.info(`SmartThings Matter published ${published}/${desired.length} endpoints for ${this.entries.size} devices`);
    }
  }

  private describe(matter: MatterAPI, device: MultiServiceAccessory, metadata: DeviceMetadata): Array<[MultiServiceAccessory, Entry]> {
    return device.components.flatMap(component => {
      const componentInfo = metadata.components?.find(c => c.id === component.componentId);
      const powerUuid = this.uuid(device.id, component.componentId, 'power');
      const applied = new Map<string, string>();
      const send: SendCommand = async (capability, command, args, write = commands => device.sendCommands(commands)) => {
        if (this.stopped || this.removed.has(device.id) ||
          !await write([new Command(capability, command, args, component.componentId)])) {
          throw new Error(`SmartThings command failed: ${capability}.${command}`);
        }
        if (capability !== SWITCH_LEVEL_STEP) {
          applied.delete(capability === 'switch' ? 'onOff' : capability === 'switchLevel' ? 'levelControl' : 'colorControl');
        }
        this.log.info(`Matter ${capability}.${command} accepted for ${device.name}`);
      };
      const matterPower = async () => (await matter.getAccessoryState(powerUuid, 'onOff'))?.onOff ??
        binary(read(component, 'switch', 'switch')?.value, 'on', 'off');
      const step = brightnessStep(matter, device, component, send);
      const power = switchEndpoint(matter, component, componentInfo?.categories?.map(c => c.name) ?? [], send, matterPower,
        (delta, withOnOff, minLevel) => {
          this.log.info(`Matter ${withOnOff ? 'StepWithOnOff' : 'Step'} received for ${device.name}`);
          return step(delta, withOnOff, minLevel);
        }, (commands, beforeSend) => device.sendCommands(commands, undefined, false, beforeSend));
      const air = airQualityEndpoint(matter, component);
      const endpoints = [...(power ? [power] : []), ...sensorEndpoints(matter, component), ...(air ? [air] : [])];
      return endpoints.map((endpoint): [MultiServiceAccessory, Entry] => {
        const uuid = endpoint === power ? powerUuid : this.uuid(device.id, component.componentId, endpoint.kind);
        const componentName = componentInfo?.label || component.componentId;
        const baseName = component.componentId === 'main' ? device.name : `${device.name} ${componentName}`;
        const suffix = endpoints.length > 1 && endpoint !== power ? ` ${endpoint.kind}` : '';
        const clusters: Clusters = Object.fromEntries(endpoint.clusters.map(c => [c.name, { ...c.initial, ...c.read() }]));
        const accessory: MatterAccessory = {
          UUID: uuid, displayName: fitLabel(baseName, 32 - Buffer.byteLength(suffix)) + suffix,
          serialNumber: uuid.replaceAll('-', ''), manufacturer: fitLabel(metadata.manufacturerName || 'SmartThings', 32),
          model: endpoint.kind, deviceType: endpoint.type, clusters, handlers: endpoint.handlers,
          context: { smartThingsDeviceId: device.id, smartThingsMeterVersion: 1 },
        };
        return [device, { accessory, endpoint, componentId: component.componentId, applied: endpoint === power ? applied : new Map() }];
      });
    });
  }

  private uuid(deviceId: string, componentId: string, kind: string): string {
    return this.api.hap.uuid.generate(JSON.stringify([PLUGIN_NAME, 'matter', deviceId, componentId, kind]));
  }

  sync(device: MultiServiceAccessory, componentId?: string, capability?: string, available = device.isOnline()): void {
    if (!this.matter || this.stopped) {
      return;
    }
    for (const entry of this.entries.get(device.id) ?? []) {
      if (componentId === undefined || entry.componentId === componentId) {
        this.syncEntry(this.matter, device, entry, capability, available);
      }
    }
  }

  private syncEntry(matter: MatterAPI, device: MultiServiceAccessory, entry: Entry,
    capability?: string, available = device.isOnline(),
  ): void {
    const { accessory, endpoint, applied } = entry;
    const states = endpoint.clusters.map(cluster => ({ cluster, attrs: cluster.read() }));
    // Power is the primary state of an actuator; a multimeasurement sensor can
    // still be reachable while one individual reading is missing.
    const reachable = available && (endpoint.handlers ? !!states[0].attrs : states.some(s => !!s.attrs));
    const update = (cluster: string, attrs: Attributes) => {
      const value = JSON.stringify(attrs);
      if (applied.get(cluster) === value) {
        return;
      }
      applied.set(cluster, value);
      void matter.updateAccessoryState(accessory.UUID, cluster, attrs).catch(error => {
        if (applied.get(cluster) === value) {
          applied.delete(cluster);
        }
        this.log.debug(`Could not update Matter ${cluster} for ${accessory.displayName}: ${error}`);
      });
    };
    for (const { cluster, attrs } of states) {
      if (attrs && (!capability || cluster.capabilities.includes(capability))) {
        update(cluster.name, attrs);
      }
    }
    update('bridgedDeviceBasicInformation', { reachable });
  }

  async removeDevices(ids: Set<string>): Promise<void> {
    const accessories = [...ids].flatMap(id => (this.entries.get(id) ?? []).map(e => e.accessory));
    ids.forEach(id => {
      this.removed.add(id);
      this.entries.delete(id);
    });
    await this.remove(accessories);
  }

  private async remove(accessories: MatterAccessory[]): Promise<void> {
    if (this.matter && accessories.length && !this.stopped) {
      try {
        await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
        accessories.forEach(accessory => this.cached.delete(accessory.UUID));
      } catch (error) {
        this.log.warn(`Could not remove excluded SmartThings Matter endpoints: ${error}`);
      }
    }
  }
}
