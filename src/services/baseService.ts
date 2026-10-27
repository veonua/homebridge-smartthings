import { PlatformAccessory, Logger, Service, WithUUID } from 'homebridge';
import { ShortEvent } from '../shortEvent';
import { MultiServiceAccessory } from '../multiServiceAccessory';
//import { BasePlatformAccessory } from '../basePlatformAccessory';
import { IKHomeBridgeHomebridgePlatform } from '../platform';

export class BaseService {
  protected accessory: PlatformAccessory;
  protected log: Logger;
  protected platform: IKHomeBridgeHomebridgePlatform;
  protected name = '';
  protected deviceStatus;
  protected multiServiceAccessory: MultiServiceAccessory;
  protected service: Service;
  public componentId: string;
  public capabilities: string[];

  constructor(platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
    componentId: string,
    capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {

    this.capabilities = capabilities;
    this.accessory = accessory;
    // this.service = this.accessory.getService(platform.Service.MotionSensor) || this.accessory.addService(platform.Service.MotionSensor);
    this.platform = platform;
    this.log = platform.log;
    this.multiServiceAccessory = multiServiceAccessory;
    this.name = name;
    this.deviceStatus = deviceStatus;
    this.service = new platform.Service.Switch;  // Placeholder
    this.componentId = componentId;
  }

  protected findCapability(capabilityToFind: string): boolean {
    let component;
    component = this.accessory.context.device.components.find(c => c.id === this.componentId);
    if (component === undefined) {
      component = this.accessory.context.device.components[0];
    }

    return component.capabilities.find(c => c.id === capabilityToFind);
  }

  protected setServiceType(serviceType: WithUUID<typeof Service>) {
    if (this.componentId === 'main') {
      this.service = this.accessory.getService(serviceType) ||
        this.accessory.addService(serviceType as unknown as Service);
    } else {
      this.log.debug(`Adding service to alternate component: ${this.componentId}`);
      this.service = this.accessory.getService(`${serviceType.name}-${this.componentId}`) ||
        this.accessory.addService(serviceType, `${serviceType.name}-${this.componentId}`, `${serviceType.name}-${this.componentId}`);
    }

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.context.device.label);
  }

  protected async sendCommandOrFail(capability: string, command: string, args?: unknown[]): Promise<void> {
    if (await this.multiServiceAccessory.ensureOnline()) {
      try {
        if (await this.multiServiceAccessory.sendCommand(capability, command, args, this.componentId)) {
          return;
        }
      } catch {
        // A rejected or uncertain command must be reported to HomeKit.
      }
    }
    this.log.error(`Command failed for ${this.name}`);
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  protected async getStatus(): Promise<boolean> {
    try {
      return await this.multiServiceAccessory.ensureOnline() && await this.multiServiceAccessory.refreshStatus();
    } catch {
      return false;
    }
  }

  protected async statusValue<T>(capability: string, attribute: string): Promise<T> {
    if (await this.getStatus()) {
      const value = this.deviceStatus.status?.[capability]?.[attribute]?.value;
      if (value !== undefined && value !== null) {
        return value as T;
      }
    }
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  public processEvent(event: ShortEvent) {
    this.log.debug(`${this.name} Received event with value ${event.value} - not implemented yet`);
  }
}
