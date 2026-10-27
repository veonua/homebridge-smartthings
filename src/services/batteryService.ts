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
    return this.statusValue<number>('battery', 'battery');
  }

  async getStatusLowBattery(): Promise<CharacteristicValue> {
    const battery = await this.statusValue<number>('battery', 'battery');
    return battery <= 30 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
      this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }
}
