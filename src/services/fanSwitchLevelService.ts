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
    return await this.statusValue<string>('switch', 'switch') === 'on';
  }

  async setLevel(value: CharacteristicValue): Promise<void> {
    await this.sendCommandOrFail('switchLevel', 'setLevel', [value]);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  async getLevel(): Promise<CharacteristicValue> {
    return this.statusValue<number>('switchLevel', 'level');
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