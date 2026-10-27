import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class ValveService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Valve);
    // Set the event handlers
    this.log.debug(`Adding ValveService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.Active)  // Always return true for active
      .onGet(this.getValveState.bind(this))
      .onSet(this.setValveState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.ValveType).onGet(() => platform.Characteristic.ValveType.IRRIGATION);
    this.service.getCharacteristic(platform.Characteristic.InUse)
      .onGet(this.getValveState.bind(this));
  }

  // Return the current target state
  async getValveState(): Promise<number> {
    // If it has been more than 10 seconds since we've sent a transition command,
    // reset the target state to the current state.

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        const valveState = this.deviceStatus.status.valve.valve.value;
        this.log.debug(`Received valve value of ${valveState} from Smartthings`);
        resolve(valveState === 'open' ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
      });
    });
  }

  // Set the target state of the valve
  async setValveState(value: CharacteristicValue): Promise<void> {
    const command = value === this.platform.Characteristic.Active.ACTIVE ? 'open' : 'close';
    await this.sendCommandOrFail('valve', command);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Event updating valve capability for ${this.name} to ${event.value}`);
    this.service.updateCharacteristic(this.platform.Characteristic.Active,
      event.value === 'open' ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
  }


}