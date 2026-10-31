import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class WindowCoveringService extends BaseService {
  private targetPosition = 0;
  private timer;
  private states = {
    decreasing: this.platform.Characteristic.PositionState.DECREASING,
    increasing: this.platform.Characteristic.PositionState.INCREASING,
    stopped: this.platform.Characteristic.PositionState.STOPPED,
  };

  private currentPositionState = this.states.stopped;

  private useWindowShadeLevel = false;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.WindowCovering);
    // Set the event handlers
    this.log.debug(`Adding WindowCoveringService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));
    this.service.getCharacteristic(platform.Characteristic.PositionState)
      .onGet(this.getCurrentPositionState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TargetPosition)
      .onGet(this.getTargetPosition.bind(this))
      .onSet(this.setTargetPosition.bind(this));


    if (this.capabilities.includes('windowShadeLevel')) {
      this.useWindowShadeLevel = true;
    }

  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const capability = this.useWindowShadeLevel ? 'windowShadeLevel' : 'switchLevel';
    const command = this.useWindowShadeLevel ? 'setShadeLevel' : 'setLevel';
    await this.sendCommandOrFail(capability, command, [value]);
    this.targetPosition = value as number;
  }

  async getTargetPosition(): Promise<CharacteristicValue> {
    return new Promise(resolve => {
      resolve(this.targetPosition);
    });
  }

  async getCurrentPositionState(): Promise<CharacteristicValue> {
    const state = await this.statusValue<string>('windowShade', 'windowShade');
    this.currentPositionState = state === 'opening' ? this.states.decreasing :
      state === 'closing' ? this.states.increasing : this.states.stopped;
    return this.currentPositionState;
  }


  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getCurrentPosition(): Promise<CharacteristicValue> {
    return this.useWindowShadeLevel ? this.statusValue<number>('windowShadeLevel', 'shadeLevel') :
      this.statusValue<number>('switchLevel', 'level');
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'windowShadeLevel' || event.capability === 'switchLevel') {
      this.log.debug(`Event updating windowShadeLevel capability for ${this.name} to ${event.value}`);
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, event.value);
    } else if (event.capability === 'windowShade') {
      this.log.debug(`Event updating windowShade capability for ${this.name} to ${event.value}`);
      if (event.value === 'opening') {
        this.currentPositionState = this.states.decreasing;
      } else if (event.value === 'closing') {
        this.currentPositionState = this.states.increasing;
      } else {
        this.currentPositionState = this.states.stopped;
      }
      this.log.debug(`From event, setting characteristic to ${this.currentPositionState}`);
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.currentPositionState);
    }
  }


  // getPositionState(): number {
  //   this.log.debug('GetPositionState called, value: ' + this.shadeState);
  //   return this.shadeState;
  // }


}
