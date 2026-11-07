import { PlatformAccessory, CharacteristicValue, WithUUID, Characteristic, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';

export abstract class SensorService extends BaseService {
  statusTranslation: (status) => CharacteristicValue | null = () => {
    return null;
  };


  characteristic: WithUUID<new () => Characteristic> | undefined;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);
  }

  protected initService(sensorService: WithUUID<typeof Service>, sensorCharacteristic: WithUUID<new () => Characteristic>,
    statusTranslation: (status) => CharacteristicValue) {
    this.statusTranslation = statusTranslation;
    this.setServiceType(sensorService);
    this.characteristic = sensorCharacteristic;

    // Set the event handlers
    this.service.getCharacteristic(sensorCharacteristic)
      .onGet(this.getSensorState.bind(this));


  }

  // Get the current state of the sensor
  async getSensorState(): Promise<CharacteristicValue> {
    this.log.debug('Received getSensorState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          let value;
          try {
            value = this.statusTranslation(this.deviceStatus.status);
            this.log.debug(`State for ${this.name}: ${value}`);
            resolve(value);
            return;
          } catch {
            this.log.warn(`Bad status from ${this.name}.  Keeping the service available for recovery.`);
            reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST));
            return;
          }
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }
}
