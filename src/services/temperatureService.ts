import { PlatformAccessory } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { SensorService } from './sensorService';
import { ShortEvent } from '../shortEvent';

export class TemperatureService extends SensorService {
  private unit: string | undefined;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding TemperatureService to ${this.name}`);

      this.initService(platform.Service.TemperatureSensor, platform.Characteristic.CurrentTemperature, (status) => {
        if (status.temperatureMeasurement.temperature.value === null || status.temperatureMeasurement.temperature.value === undefined ||
          status.temperatureMeasurement.temperature.unit === null || status.temperatureMeasurement.temperature.unit === undefined) {
          this.log.warn(`${this.name} returned bad value for status`);
          throw('Bad Value');
        }
      if (status.temperatureMeasurement.temperature.unit === 'F') {
        this.unit = 'F';
        this.log.debug('Converting temp to celcius');
        return (status.temperatureMeasurement.temperature.value as number -  32) * (5/9) ; // Convert to Celcius
      } else {
        this.unit = 'C';
        return status.temperatureMeasurement.temperature.value;
      }
    });
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability !== 'temperatureMeasurement' || event.attribute !== 'temperature' || typeof event.value !== 'number') {
      return;
    }
    const unit = event.unit || this.deviceStatus.status.temperatureMeasurement?.temperature?.unit || this.unit;
    if (unit !== 'F' && unit !== 'C') {
      return;
    }
    this.unit = unit;
    this.log.debug(`Event updating temperature measurement for ${this.name} to ${event.value}`);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      unit === 'F' ? (event.value - 32) * (5/9) : event.value);
  }
}
