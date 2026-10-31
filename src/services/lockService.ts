import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class LockService extends BaseService {
  private targetState = 0;
  private lockInTransitionStart = 0;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.LockMechanism);
    // Set the event handlers
    this.log.debug(`Adding LockService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));

    // Set Target State to current state to start
    this.getLockCurrentState().then(currentState => {
      if (currentState === platform.Characteristic.LockCurrentState.UNSECURED) {
        this.targetState = platform.Characteristic.LockTargetState.UNSECURED;
      } else {
        this.targetState = platform.Characteristic.LockTargetState.SECURED;
      }
    }).catch(() => {
      this.log.error(`Failed to get current state for ${this.name} on init`);
      this.targetState = platform.Characteristic.LockTargetState.SECURED;
    });

  }

  // Return the current target state
  async getLockTargetState(): Promise<number> {
    if (Date.now() - this.lockInTransitionStart > 10000) {
      const state = await this.statusValue<string>('lock', 'lock');
      this.targetState = state === 'locked' ? this.platform.Characteristic.LockTargetState.SECURED :
        this.platform.Characteristic.LockTargetState.UNSECURED;
    }
    return this.targetState;
  }

  // Set the target state of the lock
  async setLockTargetState(value: CharacteristicValue): Promise<void> {
    await this.sendCommandOrFail('lock', value ? 'lock' : 'unlock');
    this.targetState = value as number;
    this.lockInTransitionStart = Date.now();
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, value);
  }

  // Get the current state of the lock
  async getLockCurrentState(): Promise<CharacteristicValue> {
    return this.mapLockState(await this.statusValue<string>('lock', 'lock'));
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Event updating lock capability for ${this.name} to ${event.value}`);
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.mapLockState(event.value));
    if (event.value === 'locked') {
      this.targetState = this.platform.Characteristic.LockTargetState.SECURED;
      this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);
    } else {
      this.targetState = this.platform.Characteristic.LockTargetState.UNSECURED;
      this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);
    }
  }

  public mapLockState(lockState:string): CharacteristicValue {
    switch (lockState) {
      case 'locked': {
        return(this.platform.Characteristic.LockCurrentState.SECURED);
      }
      case 'unlocked':
      case 'unlocked with timeout': {
        return(this.platform.Characteristic.LockCurrentState.UNSECURED);
      }
      default: {
        return(this.platform.Characteristic.LockCurrentState.UNKNOWN);
      }
    }

  }
}
