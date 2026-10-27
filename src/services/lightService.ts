import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class LightService extends BaseService {

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

    this.setServiceType(platform.Service.Lightbulb);

    // Set the event handlers
    this.log.debug(`Adding LightService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

    // if (accessory.context.device.components[0].capabilities.find(c => c.id === 'switchLevel')) {
    if (this.findCapability('switchLevel')) {
      this.log.debug(`${this.name} supports switchLevel`);
      this.service.getCharacteristic(platform.Characteristic.Brightness)
        .onSet(this.setLevel.bind(this))
        .onGet(this.getLevel.bind(this));
    }

    // If this bulb supports colorTemperature, then add those handlers
    // if (accessory.context.device.components[0].capabilities.find(c => c.id === 'colorTemperature')) {
    if (this.findCapability('colorTemperature')) {
      this.log.debug(`${this.name} supports colorTemperature`);
      this.service.getCharacteristic(platform.Characteristic.ColorTemperature)
        .onSet(this.setColorTemp.bind(this))
        .onGet(this.getColorTemp.bind(this));
    }

    // If we support color control...
    //if (accessory.context.device.components[0].capabilities.find(c => c.id === 'colorControl')) {
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

  }


  async setSwitchState(value: CharacteristicValue): Promise<void> {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);
    await this.sendCommandOrFail('switch', value ? 'on' : 'off');
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  async getSwitchState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getSwitchState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          const switchState = this.deviceStatus.status.switch.switch.value;
          this.log.debug(`SwitchState value from ${this.name}: ${switchState}`);
          resolve(switchState === 'on');
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async setLevel(value: CharacteristicValue): Promise<void> {
    await this.sendCommandOrFail('switchLevel', 'setLevel', [value]);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  async getLevel(): Promise<CharacteristicValue> {
    this.log.debug('Received getLevel() event for ' + this.name);
    let level = 0;

    return new Promise<CharacteristicValue>((resolve, reject) => {

      this.getStatus().then((success) => {
        if (!success) {
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        try {
          if (this.deviceStatus.status.switchLevel.level.value !== undefined) {
            level = this.deviceStatus.status.switchLevel.level.value;
            this.log.debug('getLevel() SUCCESSFUL for ' + this.name + '. value = ' + level);
            resolve(level);
          } else {
            this.log.error('getLevel() FAILED for ' + this.name + '. Undefined value');
            reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          }
        } catch (e) {
          this.log.error('getLevel() FAILED for ' + this.name + '. Error: ' + e);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async setColorTemp(value: CharacteristicValue): Promise<void> {
    const stValue = 6500 - Math.round((value as number - 140) / 360 * 6500) + 1;
    await this.sendCommandOrFail('colorTemperature', 'setColorTemperature', [stValue]);
  }

  async getColorTemp(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then((success) => {
        if (!success) {
          //this.online = false;
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        let stTemperature;

        if (this.deviceStatus.status.colorTemperature.colorTemperature.value !== undefined) {
          stTemperature = Math.min(this.deviceStatus.status.colorTemperature.colorTemperature.value, 6500);
          this.log.debug('getColorTemperature() SUCCESSFUL for ' + this.name + '. value = ' + stTemperature);
          // Convert number to the homebridge compatible value
          const hbTemperature = 500 - ((stTemperature / 6500) * 360);
          resolve(hbTemperature);

        } else {
          this.log.error('getColorTemperature() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

      });
    });
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
  }

  async getHue(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then((success) => {
        if (!success) {
          //this.online = false;
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        if (this.deviceStatus.status.colorControl.hue.value !== undefined) {
          const hue = this.deviceStatus.status.colorControl.hue.value;
          this.log.debug('getHue() SUCCESSFUL for ' + this.name + '. value = ' + hue);
          this.currentColor.hue = hue;
          const hueArc = Math.round((hue / 100) * 360);
          this.log.debug(`Hue Percent of ${hue} converted to ${hueArc}.`);
          resolve(hueArc);

        } else {
          this.log.error('getHue() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

      });
    });
  }

  async setSaturation(value: CharacteristicValue): Promise<void> {
    const saturation = value as number;
    if (this.requireSetColor) {
      await this.setColor(this.currentColor.hue, saturation);
    } else {
      await this.sendCommandOrFail('colorControl', 'setSaturation', [saturation]);
    }
    this.currentColor.saturation = saturation;
  }

  async getSaturation(): Promise<CharacteristicValue> {
    const success = await this.getStatus();
    const saturation = success ? this.deviceStatus.status?.colorControl?.saturation?.value : undefined;
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
        this.log.debug(`Event updating switch capability for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.On, event.value === 'on');
        return;
      }

      case 'switchLevel': {
        this.log.debug(`Event updating switchLevel capability for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, event.value);
        return;
      }

      case 'colorTemperature': {
        this.log.debug(`Event updating colorTemperature capability for ${this.name} to ${event.value}`);
        const stTemperature = Math.min(event.value, 6500);
        this.log.debug('getColorTemperature() SUCCESSFUL for ' + this.name + '. value = ' + stTemperature);
        // Convert number to the homebridge compatible value
        const hbTemperature = 500 - ((stTemperature / 6500) * 360);
        this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, hbTemperature);
        return;
      }

      case 'colorControl': {
        this.log.debug(`Event for colorControl, attribute is ${event.attribute}, value is ${event.value}`);
        if (event.attribute === 'hue') {
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
