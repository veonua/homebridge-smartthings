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
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getSwitchState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          let switchState;
          try {
            switchState = this.deviceStatus.status.switch.switch.value;
          } catch {
            this.log.error(`Missing switch status from ${this.name}`);
          }
          this.log.debug(`Switch value from ${this.name}: ${switchState}`);
          resolve(switchState === 'on');
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'switch') {
      this.log.debug(`Event updating switch capability for ${this.name} to ${event.value}`);
      this.service.updateCharacteristic(this.platform.Characteristic.On, event.value === 'on');
    }
  }
}