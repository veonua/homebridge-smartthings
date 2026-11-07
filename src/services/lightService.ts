import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';
import { Command } from './smartThingsCommand';
import { LocalHubUnavailableError } from '../localHubClient';

interface BrightnessTarget {
  value: number;
  dispatched: boolean;
  confirmed: boolean;
}

const BRIGHTNESS_CONFIRMATION_MS = 2000;

export class LightService extends BaseService {

  private colorTemperatureRange?: { minimum: number; maximum: number };
  private adaptiveLighting?: InstanceType<IKHomeBridgeHomebridgePlatform['api']['hap']['AdaptiveLightingController']>;
  private pendingAdaptive?: { mired: number; time: number };
  private expectedAdaptive?: { kelvin: number; time: number };
  private adaptiveWriteInProgress = false;
  private brightnessTarget?: BrightnessTarget;
  private brightnessInProgress = false;
  private brightnessConfirmation?: NodeJS.Timeout;
  private brightnessEpoch = 0;
  private powerRevision = 0;
  private offInProgress = false;
  private awaitingOff = false;

  // There is a device that can't handle sethue and setsaturation separately and requires both
  // args using setcolor.

  currentColor = {
    hue: 0,
    saturation: 0,
  };

  requireSetColor = false;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.requireSetColor = Array.isArray(platform.config.SetColorDevices) &&
      platform.config.SetColorDevices.some((entry: unknown) => typeof entry === 'string' &&
        [accessory.UUID, name].some(value => value?.toLowerCase() === entry.trim().toLowerCase()));

    this.setServiceType(platform.Service.Lightbulb);

    // Set the event handlers
    this.log.debug(`Adding LightService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

    if (this.findCapability('switchLevel')) {
      this.log.debug(`${this.name} supports switchLevel`);
      this.service.getCharacteristic(platform.Characteristic.Brightness)
        .onSet(this.setLevel.bind(this))
        .onGet(this.getLevel.bind(this));
    }

    // If this bulb supports colorTemperature, then add those handlers
    if (this.findCapability('colorTemperature')) {
      this.log.debug(`${this.name} supports colorTemperature`);
      this.service.getCharacteristic(platform.Characteristic.ColorTemperature)
        .onSet(this.setColorTemp.bind(this))
        .onGet(this.getColorTemp.bind(this));
    }

    // If we support color control...
    if (this.findCapability('colorControl')) {
      this.log.debug(`${this.name} supports colorControl`);
      this.service.getCharacteristic(platform.Characteristic.Hue)
        .onSet(this.setHue.bind(this))
        .onGet(this.getHue.bind(this));
      this.service.getCharacteristic(platform.Characteristic.Saturation)
        .onSet(this.setSaturation.bind(this))
        .onGet(this.getSaturation.bind(this));

      // Get current color setting.  Sets currentColor values to start
      void this.getHue().catch(() => this.log.debug(`Initial hue unavailable for ${this.name}`));
      void this.getSaturation().catch(() => this.log.debug(`Initial saturation unavailable for ${this.name}`));
    }

    if (capabilities.includes('switchLevel') && capabilities.includes('colorTemperature') &&
      platform.config.LocalHubEvents === true && platform.config.LocalHubTokenFile && platform.usesLocalReads(accessory.UUID)) {
      this.adaptiveLighting = new platform.api.hap.AdaptiveLightingController(
        this.service as InstanceType<typeof platform.Service.Lightbulb>,
      );
      accessory.configureController(this.adaptiveLighting);
    }

  }


  async setSwitchState(value: CharacteristicValue): Promise<void> {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);
    const revision = this.powerRevision = (this.powerRevision ?? 0) + 1;
    this.offInProgress = !value;
    this.awaitingOff = !value;
    if (!value) {
      this.brightnessEpoch++;
      this.clearBrightnessTarget();
      this.pendingAdaptive = undefined;
    }
    try {
      await this.sendCommandOrFail('switch', value ? 'on' : 'off');
    } catch (error) {
      if (this.powerRevision === revision) {
        this.awaitingOff = false;
      }
      throw error;
    } finally {
      if (this.powerRevision === revision) {
        this.offInProgress = false;
      }
    }
  }

  async getSwitchState(): Promise<CharacteristicValue> {
    return await this.statusValue<string>('switch', 'switch') === 'on';
  }

  async setLevel(value: CharacteristicValue): Promise<void> {
    if (!this.platform.isKnownLocalDevice?.(this.accessory.UUID)) {
      return this.sendCommandOrFail('switchLevel', 'setLevel', [value]);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    // HomeKit sends On=false to turn the light off and can repeat Brightness=0 after it.
    if (value === 0 || this.offInProgress || this.brightnessTarget?.value === value) {
      return;
    }
    this.awaitingOff = false;
    this.clearBrightnessTarget();
    this.brightnessTarget = { value, dispatched: false, confirmed: false };
    void this.sendLatestBrightness();
  }

  async getLevel(): Promise<CharacteristicValue> {
    return this.brightnessTarget?.value ?? this.statusValue<number>('switchLevel', 'level');
  }

  private clearBrightnessTarget(): void {
    clearTimeout(this.brightnessConfirmation);
    this.brightnessConfirmation = undefined;
    this.brightnessTarget = undefined;
  }

  private async sendLatestBrightness(): Promise<void> {
    if (this.brightnessInProgress) {
      return;
    }
    this.brightnessInProgress = true;
    try {
      while (this.brightnessTarget && !this.brightnessTarget.dispatched) {
        const epoch = this.brightnessEpoch;
        let target = this.brightnessTarget;
        // Use zero transition time so each HomeKit slider step does not start a lamp-side fade.
        const args = [target.value, 0];
        const command = new Command('switchLevel', 'setLevel', args, this.componentId);
        let accepted = false;
        try {
          accepted = await this.multiServiceAccessory.sendCommands([command], undefined, true, () => {
            if (this.brightnessEpoch !== epoch || !this.brightnessTarget || this.offInProgress) {
              return false;
            }
            target = this.brightnessTarget;
            target.dispatched = true;
            args[0] = target.value;
            return true;
          });
        } catch (error) {
          this.log.debug(`Local brightness write failed for ${this.name}: ${error}`);
        }
        if (this.brightnessTarget !== target) {
          continue;
        }
        if (!accepted) {
          void this.reconcileBrightness(target);
        } else if (target.confirmed) {
          this.clearBrightnessTarget();
        } else {
          this.brightnessConfirmation = setTimeout(() => void this.reconcileBrightness(target), BRIGHTNESS_CONFIRMATION_MS);
          this.brightnessConfirmation.unref();
        }
        break;
      }
    } finally {
      this.brightnessInProgress = false;
    }
  }

  private async reconcileBrightness(target: BrightnessTarget): Promise<void> {
    const beforeRead = this.deviceStatus.status?.switchLevel?.level;
    let level: number | undefined;
    try {
      const status = await this.platform.getLocalStatus(this.accessory.UUID);
      if (this.brightnessTarget !== target) {
        return;
      }
      const attribute = status?.components?.[this.componentId]?.switchLevel?.level;
      const current = this.deviceStatus.status?.switchLevel?.level;
      this.clearBrightnessTarget();
      if (current !== beforeRead) {
        level = current?.value;
      } else if (typeof attribute?.value === 'number' && Number.isFinite(attribute.value) &&
        attribute.value >= 0 && attribute.value <= 100) {
        this.multiServiceAccessory.processEvent({ deviceId: this.accessory.UUID, componentId: this.componentId,
          capability: 'switchLevel', attribute: 'level', value: attribute.value,
          eventTime: typeof attribute.timestamp === 'string' ? Date.parse(attribute.timestamp) : undefined });
        level = this.deviceStatus.status?.switchLevel?.level?.value;
      }
    } catch (error) {
      if (this.brightnessTarget !== target) {
        return;
      }
      this.log.debug(`Could not reconcile local brightness for ${this.name}: ${error}`);
      this.clearBrightnessTarget();
    }
    if (typeof level === 'number' && Number.isFinite(level)) {
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, level);
    } else {
      this.multiServiceAccessory.forceNextStatusRefresh();
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness,
        new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
  }

  async setColorTemp(value: CharacteristicValue, context?: { controller?: unknown }): Promise<void> {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    const adaptive = this.adaptiveLighting && context?.controller === this.adaptiveLighting;
    this.syncColorFromTemperature(value);
    if (adaptive) {
      this.pendingAdaptive = { mired: value, time: Date.now() };
      await this.applyAdaptiveTemperature();
      return;
    }
    // Device status is loaded asynchronously; try to obtain the range before the first write.
    if (!this.colorTemperatureRange) {
      await this.getStatus();
    }
    this.updateColorTemperatureRange();
    let stValue = Math.round(1000000 / value);
    if (this.colorTemperatureRange) {
      stValue = Math.max(this.colorTemperatureRange.minimum, Math.min(this.colorTemperatureRange.maximum, stValue));
    }
    await this.sendCommandOrFail('colorTemperature', 'setColorTemperature', [stValue]);
  }

  private syncColorFromTemperature(mired: number): void {
    if (!this.adaptiveLighting || !this.capabilities.includes('colorControl')) {
      return;
    }
    const color = this.platform.api.hap.ColorUtils.colorTemperatureToHueAndSaturation(mired);
    this.currentColor = { hue: Math.round(color.hue / 360 * 100), saturation: Math.round(color.saturation) };
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, color.hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, color.saturation);
  }

  private setColorMode(): void {
    if (this.adaptiveLighting && this.capabilities.includes('colorTemperature')) {
      const characteristic = this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature);
      characteristic.value = characteristic.props.minValue ?? 140;
    }
  }

  private async applyAdaptiveTemperature(): Promise<void> {
    const pending = this.pendingAdaptive;
    const revision = this.powerRevision;
    if (this.adaptiveWriteInProgress || !pending || !this.adaptiveLighting?.isAdaptiveLightingActive() ||
      this.awaitingOff || this.offInProgress ||
      Date.now() - pending.time > 90000 ||
      this.deviceStatus?.status?.switch?.switch?.value !== 'on') {
      return;
    }
    this.adaptiveWriteInProgress = true;
    try {
      const status = await this.platform.getLocalStatus(this.accessory.UUID);
      if (status?.components?.[this.componentId]?.switch?.switch?.value !== 'on' ||
        this.deviceStatus?.status?.switch?.switch?.value !== 'on' ||
        !this.adaptiveLighting?.isAdaptiveLightingActive() || this.pendingAdaptive !== pending || this.powerRevision !== revision) {
        return;
      }
      this.updateColorTemperatureRange();
      let kelvin = Math.round(1000000 / pending.mired);
      if (this.colorTemperatureRange) {
        kelvin = Math.max(this.colorTemperatureRange.minimum, Math.min(this.colorTemperatureRange.maximum, kelvin));
      }
      this.expectedAdaptive = { kelvin, time: Date.now() };
      this.pendingAdaptive = undefined;
      const success = await this.multiServiceAccessory.sendCommands(
        [new Command('colorTemperature', 'setColorTemperature', [kelvin], this.componentId)], undefined, true,
        () => this.powerRevision === revision && !this.awaitingOff && !this.offInProgress &&
          this.deviceStatus?.status?.switch?.switch?.value === 'on',
      );
      if (!success) {
        this.expectedAdaptive = undefined;
        if (this.powerRevision !== revision || this.deviceStatus?.status?.switch?.switch?.value !== 'on') {
          return;
        }
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    } catch (error) {
      this.expectedAdaptive = undefined;
      throw error;
    } finally {
      this.adaptiveWriteInProgress = false;
    }
  }

  async getColorTemp(): Promise<CharacteristicValue> {
    const temperature = await this.statusValue<number>('colorTemperature', 'colorTemperature');
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature <= 0) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.updateColorTemperatureRange();
    return Math.round(1000000 / temperature);
  }

  private updateColorTemperatureRange(): void {
    const attribute = this.deviceStatus?.status?.colorTemperature?.colorTemperatureRange;
    const range = attribute?.value;
    if ((attribute?.unit !== undefined && attribute.unit !== 'K') ||
      !Number.isInteger(range?.minimum) || !Number.isInteger(range?.maximum) ||
      range.minimum <= 0 || range.maximum < range.minimum) {
      return;
    }
    if (this.colorTemperatureRange?.minimum === range.minimum && this.colorTemperatureRange?.maximum === range.maximum) {
      return;
    }
    this.colorTemperatureRange = { minimum: range.minimum, maximum: range.maximum };
    const minValue = Math.ceil(1000000 / range.maximum);
    const maxValue = Math.floor(1000000 / range.minimum);
    if (minValue <= maxValue) {
      this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature).setProps({ minValue, maxValue });
    }
  }

  async setColor(hue: number, saturation: number): Promise<void> {
    await this.sendCommandOrFail('colorControl', 'setColor', [{ hue, saturation }]);
  }

  async setHue(value: CharacteristicValue): Promise<void> {
    const huePct = Math.round((value as number / 360) * 100);
    const saturation = this.currentColor.saturation;
    if (this.requireSetColor) {
      await this.setColor(huePct, saturation);
    } else {
      await this.sendCommandOrFail('colorControl', 'setHue', [huePct]);
    }
    this.currentColor.hue = huePct;
    this.setColorMode();
  }

  async getHue(): Promise<CharacteristicValue> {
    const hue = await this.statusValue<number>('colorControl', 'hue');
    this.currentColor.hue = hue;
    return Math.round((hue / 100) * 360);
  }

  async setSaturation(value: CharacteristicValue): Promise<void> {
    const saturation = value as number;
    if (this.requireSetColor) {
      await this.setColor(this.currentColor.hue, saturation);
    } else {
      await this.sendCommandOrFail('colorControl', 'setSaturation', [saturation]);
    }
    this.currentColor.saturation = saturation;
    this.setColorMode();
  }

  async getSaturation(): Promise<CharacteristicValue> {
    const saturation = await this.statusValue<number>('colorControl', 'saturation');
    if (typeof saturation !== 'number' || !Number.isFinite(saturation) || saturation < 0 || saturation > 100) {
      this.log.debug(`Saturation unavailable or invalid for ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.currentColor.saturation = saturation;
    return saturation;
  }

  public processEvent(event: ShortEvent): void {
    switch (event.capability) {
      case 'switch': {
        if (event.value === 'off') {
          this.awaitingOff = false;
        }
        this.log.debug(`Event updating switch capability for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.On, event.value === 'on');
        if (event.value === 'on' && this.pendingAdaptive) {
          void this.applyAdaptiveTemperature().catch(error => {
            if (!(error instanceof LocalHubUnavailableError)) {
              this.log.warn(`Adaptive Lighting command failed for ${this.name}`);
            }
          });
        }
        return;
      }

      case 'switchLevel': {
        const target = this.brightnessTarget;
        if (target) {
          target.confirmed = target.dispatched && event.value === target.value;
          if (!target.confirmed) {
            return;
          }
          if (!this.brightnessInProgress) {
            this.clearBrightnessTarget();
          }
        }
        this.log.debug(`Event updating switchLevel capability for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, event.value);
        return;
      }

      case 'colorTemperature': {
        if (event.attribute !== 'colorTemperature' || typeof event.value !== 'number' ||
          !Number.isFinite(event.value) || event.value <= 0) {
          return;
        }
        this.log.debug(`Event updating colorTemperature capability for ${this.name} to ${event.value}`);
        if (this.adaptiveLighting?.isAdaptiveLightingActive() && event.eventTime !== undefined) {
          const expected = this.expectedAdaptive;
          const ownEvent = expected && event.eventTime >= expected.time - 1000 &&
            Date.now() - expected.time < 15000 && Math.abs(expected.kelvin - event.value) <= 50;
          if (!ownEvent) {
            this.adaptiveLighting.disableAdaptiveLighting();
            this.pendingAdaptive = undefined;
          }
        }
        this.updateColorTemperatureRange();
        const hbTemperature = Math.round(1000000 / event.value);
        this.syncColorFromTemperature(hbTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, hbTemperature);
        return;
      }

      case 'colorControl': {
        this.log.debug(`Event for colorControl, attribute is ${event.attribute}, value is ${event.value}`);
        if (this.adaptiveLighting?.isAdaptiveLightingActive() && event.eventTime !== undefined &&
          (event.attribute === 'hue' || event.attribute === 'saturation')) {
          const expected = this.expectedAdaptive;
          const expectedColor = expected && this.platform.api.hap.ColorUtils
            .colorTemperatureToHueAndSaturation(Math.round(1000000 / expected.kelvin));
          const expectedValue = expectedColor && (event.attribute === 'hue' ? expectedColor.hue / 360 * 100 : expectedColor.saturation);
          const ownEvent = expected && expectedValue !== undefined && typeof event.value === 'number' &&
            event.eventTime >= expected.time - 1000 && Date.now() - expected.time < 15000 &&
            Math.abs(expectedValue - event.value) <= 5;
          if (!ownEvent) {
            this.adaptiveLighting.disableAdaptiveLighting();
            this.pendingAdaptive = undefined;
            this.setColorMode();
          }
        }
        if (event.attribute === 'hue') {
          if (typeof event.value !== 'number' || !Number.isFinite(event.value) || event.value < 0 || event.value > 100) {
            return;
          }
          this.currentColor.hue = event.value;
          const hueArc = Math.round((event.value / 100) * 360);
          this.service.updateCharacteristic(this.platform.Characteristic.Hue, hueArc);
        } else if (event.attribute === 'saturation') {
          if (typeof event.value === 'number' && Number.isFinite(event.value) && event.value >= 0 && event.value <= 100) {
            this.currentColor.saturation = event.value;
            this.service.updateCharacteristic(this.platform.Characteristic.Saturation, event.value);
          }
        }
      }

    }
  }

}
