import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class FanSwitchLevelService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilitites: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilitites, multiServiceAccessory, name, deviceStatus);
    this.setServiceType(platform.Service.Fan);

    // Set the event handlers
    this.log.debug(`Adding FanSwitchLevelService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.RotationSpeed)
      .onSet(this.setLevel.bind(this))
      .onGet(this.getLevel.bind(this));

  }

  // Set the target
  async setSwitchState(value: CharacteristicValue): Promise<void> {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);
    await this.sendCommandOrFail('switch', value ? 'on' : 'off');
  }

  // Get the current state of the lock
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

        if (this.deviceStatus.status.switchLevel.level.value !== undefined) {
          level = this.deviceStatus.status.switchLevel.level.value;
          this.log.debug('getLevel() SUCCESSFUL for ' + this.name + '. value = ' + level);
          resolve(level);

        } else {
          this.log.error('getLevel() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
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
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, event.value);
      }
    }
  }
}