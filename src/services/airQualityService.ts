import { PlatformAccessory } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { SensorService } from './sensorService';
import { MultiServiceAccessory, Component } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class AirQualityService extends SensorService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus: Component) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding AirQualityService to ${this.name}`);
    this.initService(platform.Service.AirQualitySensor, platform.Characteristic.AirQuality, (status: Component['status']) => {
      const co2 = status.carbonDioxideMeasurement.carbonDioxide.value;
      const pm25Density = status.dustSensor.fineDustLevel.value;

      if (co2 === null || co2 === undefined) {
        this.log.warn(`${this.name} returned bad value for status`);
        throw('Bad Value');
      }

      this.service.setCharacteristic(platform.Characteristic.CarbonDioxideLevel, co2);
      this.service.setCharacteristic(platform.Characteristic.PM2_5Density, pm25Density);

      let score = 0;
      if (pm25Density > 55) {
        return this.platform.Characteristic.AirQuality.POOR;
      } else if (pm25Density > 30) {
        score = this.platform.Characteristic.AirQuality.INFERIOR;
      } else if (pm25Density > 15) {
        score = this.platform.Characteristic.AirQuality.FAIR;
      } else if (pm25Density > 7) {
        score = this.platform.Characteristic.AirQuality.GOOD;
      } else {
        score = this.platform.Characteristic.AirQuality.EXCELLENT;
      }

      if (co2 > 5000) {
        return this.platform.Characteristic.AirQuality.POOR;
      } else if (co2 > 2500) {
        score += this.platform.Characteristic.AirQuality.POOR;
      } else if (co2 > 2000) {
        score += this.platform.Characteristic.AirQuality.INFERIOR;
      } else if (co2 > 1500) {
        score += this.platform.Characteristic.AirQuality.FAIR;
      } else if (co2 > 1000) {
        score += this.platform.Characteristic.AirQuality.GOOD;
      }

      if (score > 4) {
        return this.platform.Characteristic.AirQuality.POOR;
      }
      return score;
    });
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'carbonDioxideMeasurement') {
      this.service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, event.value);
    } else if (event.capability === 'dustSensor') {
      this.service.updateCharacteristic(this.platform.Characteristic.PM2_5Density, event.value);
    } else {
      return;
    }

    this.getSensorState().then(value => {
      this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, value);
    }).catch(() => {
      this.log.warn(`Failed to update air quality for ${this.name}`);
    });
  }
}
