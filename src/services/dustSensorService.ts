import { PlatformAccessory } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { SensorService } from './sensorService';
import { MultiServiceAccessory } from '../multiServiceAccessory';

export class DustSensorService extends SensorService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding Dust to ${this.name}`);

    this.initService(platform.Service.AirQualitySensor, platform.Characteristic.PM10Density, (status) => {
      const value = status.dustSensor.dustLevel.value;

      if (value === null || value === undefined) {
        this.log.warn(`${this.name} returned bad value for status`);
        throw('Bad Value');
      }
      return value;
    });
  }
}