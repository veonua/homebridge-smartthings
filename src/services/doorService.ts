import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class DoorService extends BaseService {
  private targetState = this.platform.Characteristic.TargetDoorState.OPEN;
  private doorInTransitionStart = 0;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    // This can either be a Door or Garage Door Opener

    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);
    this.setServiceType(platform.Service.GarageDoorOpener);
    // Set the event handlers
    this.log.debug(`Adding DoorService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TargetDoorState)
      .onGet(this.getTargetDoorState.bind(this))
      .onSet(this.setTargetDoorState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.ObstructionDetected)
      .onGet(() => false);

    // Set Target State to current state to start
    this.getCurrentDoorState().then(currentState => {
      if (currentState === platform.Characteristic.CurrentDoorState.OPEN) {
        this.targetState = platform.Characteristic.TargetDoorState.OPEN;
      } else {
        this.targetState = platform.Characteristic.TargetDoorState.CLOSED;
      }
    }).catch(() => {
      this.log.error(`Failed to get current state for ${this.name} on init`);
      this.targetState = platform.Characteristic.TargetDoorState.CLOSED;
    });

  }

  // Return the current target state
  async getTargetDoorState(): Promise<CharacteristicValue> {
    if (Date.now() - this.doorInTransitionStart > 20000) {
      const state = await this.statusValue<string>('doorControl', 'door');
      this.targetState = state === 'closed' || state === 'closing' ?
        this.platform.Characteristic.TargetDoorState.CLOSED : this.platform.Characteristic.TargetDoorState.OPEN;
    }
    return this.targetState;
  }

  // Set the target state of the door
  async setTargetDoorState(value: CharacteristicValue): Promise<void> {
    const command = value === this.platform.Characteristic.TargetDoorState.CLOSED ? 'close' : 'open';
    await this.sendCommandOrFail('doorControl', command);
    this.targetState = value as number;
    this.doorInTransitionStart = Date.now();
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, value);
    this.multiServiceAccessory.forceNextStatusRefresh();
  }

  // Get the current state of the door
  async getCurrentDoorState(): Promise<CharacteristicValue> {
    return this.mapDoorState(await this.statusValue<string>('doorControl', 'door'));
  }

  public processEvent(event: ShortEvent): void {
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, this.mapDoorState(event.value));
    if (event.value === 'closed' || event.value === 'closing') {
      this.targetState = this.platform.Characteristic.TargetDoorState.CLOSED;
    } else {
      this.targetState = this.platform.Characteristic.TargetDoorState.OPEN;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.targetState);
  }

  private mapDoorState(doorState: string): CharacteristicValue {
    switch (doorState) {
      case 'closed':
        return(this.platform.Characteristic.CurrentDoorState.CLOSED);
      case 'closing':
        return(this.platform.Characteristic.CurrentDoorState.CLOSING);
      case 'open':
        return(this.platform.Characteristic.CurrentDoorState.OPEN);
      case 'opening':
        return(this.platform.Characteristic.CurrentDoorState.OPENING);
      default: {
        return(this.platform.Characteristic.CurrentDoorState.CLOSED);
      }
    }
  }
}
