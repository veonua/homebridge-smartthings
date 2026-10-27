import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class SwitchService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities:string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Switch);
    // Set the event handlers
    this.log.debug(`Adding SwitchService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getSwitchState.bind(this))
      .onSet(this.setSwitchState.bind(this));

  }

  // Set the target state of the lock
  async setSwitchState(value: CharacteristicValue): Promise<void> {
    this.log.debug('Received setSwitchState(' + value + ') event for ' + this.name);
    await this.sendCommandOrFail('switch', value ? 'on' : 'off');
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  // Get the current state of the lock
  async getSwitchState(): Promise<CharacteristicValue> {
    return await this.statusValue<string>('switch', 'switch') === 'on';
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'switch') {
      this.log.debug(`Event updating switch capability for ${this.name} to ${event.value}`);
      this.service.updateCharacteristic(this.platform.Characteristic.On, event.value === 'on');
    }
  }
}