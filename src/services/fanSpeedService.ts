import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class FanSpeedService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);
    this.setServiceType(platform.Service.Fan);

    // Set the event handlers
    this.log.debug(`Adding FanSpeedService to ${this.name}`);
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
    const level = value === 0 ? 0 : value as number <= 33 ? 1 : value as number <= 66 ? 2 : 3;
    await this.sendCommandOrFail('fanSpeed', 'setFanSpeed', [level]);
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

        if (this.deviceStatus.status.fanSpeed.fanSpeed.value !== undefined) {
          level = this.deviceStatus.status.fanSpeed.fanSpeed.value;
          const pct = this.mapLevelToPercent(level);
          this.log.debug('getLevel() SUCCESSFUL for ' + this.name + '. value = ' + pct);
          resolve(pct);

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

      case 'fanSpeed': {
        this.log.debug(`Event updating fanSpeed capability for ${this.name} to ${event.value}`);
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.mapLevelToPercent(event.value));
      }
    }

  }

  private mapLevelToPercent(level: number): number {
    let pct;
    if (level === 0) {
      pct = 0;
    } else if (level === 1) {
      pct = 33;
    } else if (level === 2) {
      pct = 66;
    } else {
      pct = 100;
    }

    return pct;
  }
}