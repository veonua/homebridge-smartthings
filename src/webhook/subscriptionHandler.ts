//import { RequestBody, ResponseBody } from '../webhook/subscriptionHandler;
import axios = require('axios');
//import { BasePlatformAccessory } from '../basePlatformAccessory';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { Logger, PlatformConfig } from 'homebridge';
import { WEBHOOK_URL, WH_CONNECT_RETRY_MINUTES, wait } from '../keyValues';
import { MultiServiceAccessory } from '../multiServiceAccessory';

export interface ShortEvent {
  deviceId: string;
  value: string | number | boolean | null;
  componentId: string;
  capability: string;
  attribute: string;
}

export interface RequestBody {
  timeout: number;
  deviceIds: string[];
}

export interface ResponseBody {
  timeout: boolean;
  events: ShortEvent [];
}

export class SubscriptionHandler {
  private config: PlatformConfig;
  private devices: MultiServiceAccessory[] = [];
  private deviceIds: string[] = [];

  private log: Logger;
  private shutdown = false;

  private axInstance: axios.AxiosInstance;

  constructor(platform: IKHomeBridgeHomebridgePlatform, devices: MultiServiceAccessory[]) {
    this.config = platform.config;
    this.log = platform.log;
    devices.forEach((device) => {
      this.deviceIds.push(device.id);
    });
    this.devices = devices;

    const headerDict = {
      'Authorization': 'Bearer: ' + this.config.WebhookToken,
      'Keep-Alive': 'timeout=120, max=1000',
    };

    this.axInstance = axios.default.create({
      baseURL: WEBHOOK_URL,
      headers: headerDict,
      timeout: 90000,
    });

  }

  async startService() {
    this.log.debug('Starting subscription handler');

    const request: RequestBody = {
      timeout: 85000,
      deviceIds: this.deviceIds,
    };

    while (!this.shutdown) {
      this.log.debug('Posting request to web hook');
      let response;
      try {
        response = await this.axInstance.post('clientrequest', request);
        this.log.debug(`Received response from webhook ${JSON.stringify(response.data)}`);
        const responseBody = response.data as ResponseBody;
        responseBody.events.forEach(event => {
          const device = this.devices.find(device => device.id === event.deviceId);
          if (device) {
            device.processEvent(event);
          }
        });
      } catch (error) {
        //this.shutdown = true;
        this.log.error(`Could not connect to web hook service: ${error}.  Will retry`);
        await wait(WH_CONNECT_RETRY_MINUTES * 60);
      }
    }
  }

  stopService() {
    this.shutdown = true;
  }
}