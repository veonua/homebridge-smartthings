import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';

const stateMap =
{ 'off' : 0, 'heat' : 1, 'cool' : 2,
  'auto':3, 'eco':3, 'energysaveheat':3};

const stateMapRev = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto'};

export class ThermostatService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Thermostat);
    // Set the event handlers
    this.log.debug(`Adding ThermostatService to ${this.name}`);
    this.service.getCharacteristic(platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    if (this.findCapability('fanSpeed')) {
      this.service.getCharacteristic(platform.Characteristic.RotationSpeed)
        .onSet(this.setLevel.bind(this))
        .onGet(this.getLevel.bind(this));
    }

    this.service.getCharacteristic(platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: 17,
        maxValue: 32,
      })
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));


    let pollSensors = 10; // default to 10 seconds
    if (this.platform.config.PollSensorsSeconds !== undefined) {
      pollSensors = this.platform.config.PollSensorsSeconds;
    }

    if (pollSensors > 0) {
      multiServiceAccessory.startPollingState(pollSensors, this.getCurrentHeatingCoolingState.bind(this), this.service,
        platform.Characteristic.CurrentHeatingCoolingState, platform.Characteristic.TargetHeatingCoolingState,
        this.getTargetHeatingCoolingState.bind(this));

      multiServiceAccessory.startPollingState(pollSensors, this.getCurrentTemperature.bind(this), this.service,
        platform.Characteristic.CurrentTemperature,
        platform.Characteristic.TargetTemperature, this.getTargetTemperature.bind(this));
    }
  }

  // Set the target
  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    //this.log.debug('Received setTargetHeatingCoolingState(' + value + ') event for ' + this.name);

    if (!this.multiServiceAccessory.isOnline) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const targetState = stateMapRev[+value];
    this.multiServiceAccessory.sendCommand('thermostatMode', 'setThermostatMode', [targetState] ).then((success) => {
      if (success) {
        this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
      } else {
        this.log.error(`Command failed for ${this.name}`);
      }
    });
  }

  // Get the current state of the lock
  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getSwitchState() event for ' + this.name);

    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (success) {
          const status = this.deviceStatus.status;
          if (status.thermostatMode === undefined) {
            resolve(this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
            return;
          }

          const value = stateMap[status.thermostatMode.thermostatMode.value];
          resolve(value);
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async setLevel(value: CharacteristicValue): Promise<void> {
    this.log.debug('Received setLevel(' + value + ') event for ' + this.name);

    return new Promise<void>((resolve, reject) => {
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(this.accessory.context.device.label + ' is offline');
        return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }

      let level = 0;

      // Level is 0 (off), 1 (low), 2 (medium), 3 (high)
      if (value === 0) {
        level = 0;
      } else if (value <= 33) {
        level = 1;
      } else if (value <= 66) {
        level = 2;
      } else {
        level = 3;
      }

      this.log.debug(`Setting value of ${this.name} to ${level}`);
      this.multiServiceAccessory.sendCommand('fanSpeed', 'setFanSpeed', [level]).then(success => {
        if (success) {
          this.log.debug('setLevel(' + value + ') SUCCESSFUL for ' + this.name);
          this.deviceStatus.timestamp = 0;
          resolve();
        } else {
          this.log.error(`Failed to send setLevel command for ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async getLevel(): Promise<CharacteristicValue> {
    this.log.debug('Received getLevel() event for ' + this.name);
    let level = 0;
    return new Promise<CharacteristicValue>((resolve, reject) => {
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.error(this.accessory.context.device.label + ' is offline');
        return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }

      this.getStatus().then((success) => {
        if (!success) {
          this.log.error(`Could not get device status for ${this.name}`);
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }

        if (this.deviceStatus?.status?.fanSpeed?.fanSpeed?.value !== undefined) {
          level = this.deviceStatus.status.fanSpeed.fanSpeed.value;
          let pct;
          if (level === 0) {
            pct = 0;
          } else if (level === 1) {
            pct = 33;
          } else if (level === 2) {
            pct = 66;
          } else {
            pct = 100;
          }
          this.log.debug('getLevel() SUCCESSFUL for ' + this.name + '. value = ' + pct);
          resolve(pct);

        } else {
          this.log.error('getLevel() FAILED for ' + this.name + '. Undefined value');
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    this.multiServiceAccessory.sendCommand('thermostatHeatingSetpoint', 'setHeatingSetpoint', [value] ).then((success) => {
      if (success) {
        this.log.debug('onSet(' + value + ') SUCCESSFUL for ' + this.name);
      } else {
        this.log.error(`Command failed for ${this.name}`);
      }
    });
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      if (!this.multiServiceAccessory.isOnline()) {
        this.log.info(`${this.name} is offline`);
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      this.getStatus().then(success => {
        if (!success) {
          return reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
        const value = this.deviceStatus.status.thermostatHeatingSetpoint.heatingSetpoint.value;
        const current = this.deviceStatus.status.temperatureMeasurement?.temperature?.value?? value;
        this.service.setCharacteristic(this.platform.Characteristic.CurrentTemperature, current);
        resolve(value);
      });
    });
  }
}