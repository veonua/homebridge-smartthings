import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class StatelessProgrammableSwitchService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities:string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.StatelessProgrammableSwitch);
    // Set the event handlers
    this.log.debug(`Adding StatelessProgrammableSwitchService to ${this.name}`);
  }

  public processEvent(event: ShortEvent): void {
    if (event.capability === 'button' && event.attribute === 'button' && typeof event.value === 'string') {
      this.log.debug(`Event updating button capability for ${this.name} to ${event.value}`);
      const characteristicValue = this.mapValue(event.value);
      if (characteristicValue !== undefined) {
        this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, characteristicValue);
      }
    }
  }

  private mapValue(inboundValue: string) : CharacteristicValue|undefined {
    switch (inboundValue) {
      case 'pushed':
      case 'down' :
        return(this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
      case 'held':
        return(this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
      default:
        if (inboundValue.startsWith('pushed') || inboundValue.startsWith('down')) {
          return(this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        } else {
          return undefined;
        }
    }
  }
}
