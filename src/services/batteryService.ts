import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class BatteryService extends BaseService {

  public processEvent(event: ShortEvent): void {
    if (event.capability !== 'battery' || event.attribute !== 'battery' || typeof event.value !== 'number') {
      return;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.BatteryLevel, event.value);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, event.value <= 30 ?
      this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
      this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  }

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);
    this.setServiceType(platform.Service.Battery);

    this.log.debug(`Adding BatteryService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));

    this.service.getCharacteristic(platform.Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));

  }

  async getBatteryLevel(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getBatteryLevel() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          const batteryLevel = this.deviceStatus.status.battery.battery.value;
          if (batteryLevel === null) {
            return reject (new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          }
          this.log.debug(`Battery value from ${this.name}: ${batteryLevel}`);
          resolve(batteryLevel);
        } else {
          reject (new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async getStatusLowBattery(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getStatusLowBattery() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          const batteryLevel = this.deviceStatus.status.battery.battery.value;
          if (batteryLevel === null) {
            return reject (new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          }
          if (batteryLevel > 40) {
            this.log.debug(`${this.name} battery level normal`);
          } else {
            this.log.debug(`${this.name} battery level LOW`);
          }
          resolve(batteryLevel <= 30 ?
            this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
            this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        } else {
          reject (new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }
}
