import { PlatformAccessory, Logger, API, Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';
import axios = require('axios');
import { IKHomeBridgeHomebridgePlatform } from './platform';
import { ShortEvent } from './shortEvent';

interface DeviceStatus {
  timestamp: number;
  status?: Record<string, unknown>;
}
/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export abstract class BasePlatformAccessory {
  // protected service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */

  protected accessory: PlatformAccessory;
  protected platform: IKHomeBridgeHomebridgePlatform;
  public readonly name: string;
  protected characteristic: typeof Characteristic;
  protected log: Logger;
  protected baseURL: string;
  protected key: string;
  protected axInstance: axios.AxiosInstance;
  protected commandURL: string;
  protected statusURL: string;
  protected healthURL: string;
  protected api: API;
  protected online = true;
  protected deviceStatus: DeviceStatus = { timestamp: 0, status: undefined };
  protected failureCount = 0;
  protected giveUpTime = 0;
  protected commandInProgress = false;
  protected lastCommandCompleted = 0;

  protected statusQueryInProgress = false;
  protected lastStatusResult = true;

  get id() {
    return this.accessory.UUID;
  }

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    accessory: PlatformAccessory,
  ) {
    this.accessory = accessory;
    this.platform = platform;
    this.name = accessory.context.device.label;
    this.log = platform.log;
    this.baseURL = platform.config.BaseURL;
    this.key = platform.config.AccessToken;
    this.api = platform.api;
    const headerDict = { 'Authorization': 'Bearer: ' + this.key };

    this.axInstance = axios.create({
      baseURL: this.baseURL,
      headers: headerDict,
    });

    this.commandURL = 'devices/' + accessory.context.device.deviceId + '/commands';
    this.statusURL = 'devices/' + accessory.context.device.deviceId + '/status';
    this.healthURL = 'devices/' + accessory.context.device.deviceId + '/health';
    this.characteristic = platform.Characteristic;

    // set accessory information
    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, accessory.context.device.manufacturerName)
      .setCharacteristic(platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(platform.Characteristic.SerialNumber, 'Default-Serial');

    // // Find out if we are online
    this.axInstance.get(this.healthURL)
      .then(res => {
        if (res.data.state === 'ONLINE') {
          this.online = true;
        } else {
          this.online = false;
        }
      });
    // if (this.name === 'Test Lock') {
    //   platform.subscriptionHandler.addSubscription(this);
    // }
  }

  public abstract processEvent(event: ShortEvent):void;


  // Called by subclasses to refresh the status for the device.  Will only refresh if it has been more than
  // 4 seconds since last refresh
  //
  protected async refreshStatus(): Promise<boolean> {
    this.log.debug(`Refreshing status for ${this.name} - current timestamp is ${this.deviceStatus.timestamp}`);

    const tooOld = this.deviceStatus.status === undefined || (Date.now() - this.deviceStatus.timestamp > 5000);
    if (!tooOld) {
      return true;
    }

    if (this.statusQueryInProgress) {
      this.log.debug(`Status query already in progress for ${this.name}.  Waiting...`);
      await this.waitFor(() => !this.statusQueryInProgress);
      return this.lastStatusResult;
    }

    this.log.debug(`Calling Smartthings to get an update for ${this.name}`);
    this.statusQueryInProgress = true;
    this.failureCount = 0;
    await this.waitFor(() => !this.commandInProgress);

    try {
      const res = await this.axInstance.get(this.statusURL);
      if (res.data.components.main === undefined) {
        this.log.debug(`No status returned for ${this.name}`);
        this.lastStatusResult = false;
        return false;
      }

      this.deviceStatus.status = res.data.components.main;
      this.deviceStatus.timestamp = Date.now();
      this.log.debug(`Updated status for ${this.name}: ${JSON.stringify(this.deviceStatus.status)}`);
      this.lastStatusResult = true;
      return true;
    } catch (error) {
      this.failureCount++;
      this.log.error(`Failed to request status from ${this.name}: ${error}.  This is failure number ${this.failureCount}`);
      if (this.failureCount >= 5) {
        this.log.error(`Exceeded allowed failures for ${this.name}.  Device is offline`);
        this.giveUpTime = Date.now();
        this.online = false;
      }
      this.lastStatusResult = false;
      return false;
    } finally {
      this.statusQueryInProgress = false;
    }
  }

  /** Retained for subclasses built against earlier versions; periodic state polling is disabled. */
  protected startPollingState(pollSeconds: number, getValue: () => Promise<CharacteristicValue>, service: Service,
    characteristic: WithUUID<new () => Characteristic>, targetStateCharacteristic?: WithUUID<new () => Characteristic>,
    getTargetState?: () => Promise<CharacteristicValue>): NodeJS.Timeout | void {
    void [pollSeconds, getValue, service, characteristic, targetStateCharacteristic, getTargetState];
  }

  async sendCommand(capability: string, command: string, args?: unknown[]): Promise<boolean> {

    const cmd = {
      capability,
      command,
      ...(args ? { arguments: args } : {}),
    };

    const commandBody = JSON.stringify([cmd]);
    await this.waitFor(() => !this.commandInProgress);
    this.commandInProgress = true;
    try {
      await this.axInstance.post(this.commandURL, commandBody);
      this.log.debug(`${command} successful for ${this.name}`);
      this.deviceStatus.timestamp = 0; // Force a refresh on the next state request
      this.commandInProgress = false;
      return true;
    } catch (error) {
      this.log.error(`${command} failed for ${this.name}: ${error}`);
      return false;
    } finally {
      this.commandInProgress = false;
    }
  }

  // Wait for the condition to be true.  Will check every 500 ms
  private async waitFor(condition: () => boolean): Promise<void> {
    if (condition()) {
      return;
    }

    this.log.debug(`${this.name} command or request is waiting...`);
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (condition()) {
          this.log.debug(`${this.name} command or request is proceeding.`);
          clearInterval(interval);
          resolve();
        }
        this.log.debug(`${this.name} still waiting...`);
      }, 250);
    });
  }
}
