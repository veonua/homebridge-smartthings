import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../shortEvent';

export class ThermostatService extends BaseService {
  targetHeatingCoolingState: CharacteristicValue;
  targetTemperature: number;
  units = 'C';
  supportsOperatingState = false;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.setServiceType(platform.Service.Thermostat);
    // Set the event handlers
    this.log.debug(`Adding ThermostatService to ${this.name}`);

    const component = this.multiServiceAccessory.components.find((c) => c.componentId === componentId);
    if (component && component.capabilities.find((cap) => cap === 'thermostatOperatingState')) {
    //if (this.multiServiceAccessory.capabilities.find((c) => c.id === 'thermostatOperatingState')) {
      this.supportsOperatingState = true;
    }
    this.service.getCharacteristic(platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));
    this.service.getCharacteristic(platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));
    this.service.getCharacteristic(platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    this.targetHeatingCoolingState = platform.Characteristic.TargetHeatingCoolingState.OFF;
    this.targetTemperature = 20;

    // TODO: get the current mode and set targetHeatingCoolingState

    // set targets

    void this.getCurrentHeatingCoolingState().then(value => {
      this.targetHeatingCoolingState = value;
    })
      .catch(() => this.log.debug(`Initial thermostat mode unavailable for ${this.name}`));
    void this.getCurrentTemperature().then(value => {
      this.targetTemperature = value as number;
    })
      .catch(() => this.log.debug(`Initial thermostat temperature unavailable for ${this.name}`));

  }

  // TARGET STATE CALLBACKS
  async getTargetHeatingCoolingState():Promise<CharacteristicValue> {
    this.log.debug('Received getTargetHeatingCoolingState for ' + this.name);
    return new Promise((resolve) => {
      // If we don't have the capability of thermostatMode, then just return AUTO
      if (this.capabilities.find((c) => c === 'thermostatMode') === undefined) {
        resolve(this.targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
        return;
      }
      this.getStatus().then(success => {
        let state;
        if (success) {
          state = this.deviceStatus.status.thermostatMode.thermostatMode.value;
          if (state === null || state === undefined) {
            this.log.error(`Received invalid heating / cooling state from ${this.name}`);
            resolve(this.targetHeatingCoolingState);
            return;
          }
          switch(state) {
            case 'cool':
              resolve(this.targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.COOL);
              return;

            case 'heat':
              resolve(this.targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
              return;

            case 'auto':
              resolve(this.targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
              return;

            default:
              resolve(this.targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.OFF);
              return;
          }
        } else {
          resolve(this.targetHeatingCoolingState);
          return;
        }
      });
    });
  }

  // Set the target state of the thermostat
  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    if (this.capabilities.find(c => c === 'thermostatMode') === undefined) {
      this.targetHeatingCoolingState = value;
      return;
    }
    let command = 'off';
    switch (value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO: command = 'auto'; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL: command = 'cool'; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT: command = 'heat'; break;
    }
    await this.sendCommandOrFail('thermostatMode', command);
    this.targetHeatingCoolingState = value;
  }

  // CURRENT STATE
  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.log.debug('Received getCurrentHeatingCoolingState() event for ' + this.name);

    return new Promise((resolve, reject) => {

      if (this.capabilities.find((c) => c === 'thermostatMode') === undefined) {
        this.log.debug(`Thermostat ${this.name} does not support thermostatMode.  Returning OFF`);
        resolve(this.platform.Characteristic.CurrentHeatingCoolingState.OFF);
        return;
      }

      this.getStatus().then(success => {
        if (success) {
          let thermostatMode;
          try {
            thermostatMode = this.deviceStatus.status.thermostatMode.thermostatMode.value;
          } catch {
            this.log.warn(`Missing thermostatMode from ${this.name}`);
            resolve(this.targetHeatingCoolingState);
            return;
          }
          this.log.debug(`thermostatMode value from ${this.name}: ${thermostatMode}`);

          switch (thermostatMode) {
            case 'cool':
              resolve(this.platform.Characteristic.CurrentHeatingCoolingState.COOL);
              break;

            case 'heat':
              resolve(this.platform.Characteristic.CurrentHeatingCoolingState.HEAT);
              break;

            default:
              resolve(this.platform.Characteristic.CurrentHeatingCoolingState.OFF);
          }
        } else {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
      });
    });
  }

  // CURRENT TEMP
  async getCurrentTemperature(): Promise<CharacteristicValue> {
    this.log.debug('Received getCurrentTemperature for ' + this.name);
    return new Promise((resolve) => {
      this.getStatus().then((success) => {
        if (success) {
          if (this.deviceStatus.status.temperatureMeasurement.temperature.value === null ||
            this.deviceStatus.status.temperatureMeasurement.temperature.value === undefined ||
            this.deviceStatus.status.temperatureMeasurement.temperature.unit === null ||
            this.deviceStatus.status.temperatureMeasurement.temperature.unit === undefined) {
            this.log.warn(`${this.name} returned bad value for status`);
            throw ('Bad Value');
          }
          if (this.deviceStatus.status.temperatureMeasurement.temperature.unit === 'F') {
            this.log.debug('Converting temp to celcius');
            this.units = 'F';
            resolve((this.deviceStatus.status.temperatureMeasurement.temperature.value as number - 32) * (5 / 9)); // Convert to Celcius
          } else {
            this.units = 'C';
            resolve(this.deviceStatus.status.temperatureMeasurement.temperature.value);
          }
        } else {
          // reject (new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          // For some reason, when homekit makes this call and it fails, Homebridge crashes.  So we will simply return zero.
          this.log.warn(`Failed to get status for ${this.name}`);
          resolve(0);
        }
      });
    });
  }

  // TARGET TEMP
  async getTargetTemperature():Promise<CharacteristicValue> {
    this.log.debug('Received GetTargetTemperature for ' + this.name);
    let temp;
    const state = await this.getTargetHeatingCoolingState();

    if (state === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
      temp = this.deviceStatus.status.thermostatCoolingSetpoint?.coolingSetpoint?.value;
    } else {
      temp = this.deviceStatus.status.thermostatHeatingSetpoint?.heatingSetpoint?.value;
    }

    if (temp === null || temp === undefined) {
      this.log.warn(`Target temperature not available for ${this.name}`);
      return this.targetTemperature ?? 0;
    }

    if (this.units === 'F') {
      temp = (temp - 32) * (5 / 9); // Convert to C
    }
    this.targetTemperature = temp;
    return temp;
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const cooling = this.targetHeatingCoolingState === this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    const capability = cooling ? 'thermostatCoolingSetpoint' : 'thermostatHeatingSetpoint';
    const command = cooling ? 'setCoolingSetpoint' : 'setHeatingSetpoint';
    const convertedTemp = this.units === 'F' ? (value as number * (9 / 5)) + 32 : value;
    await this.sendCommandOrFail(capability, command, [convertedTemp]);
    this.targetTemperature = value as number;
  }

  // DISPLAY UNITS
  getTemperatureDisplayUnits(): CharacteristicValue {
    this.log.debug('Received getTemperatureDislayUnits for ' + this.name);
    if (this.units === 'C') {
      return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    } else {
      return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }
  }

  setTemperatureDisplayUnits(value: CharacteristicValue) {
    // Nothing to do as there is no way to send this off to Smartthings
    this.log.debug(`Received request to set display units to ${value}.  No equivalent in Smartthings...`);
    return;
  }

  public processEvent(event: ShortEvent): void {
    this.log.debug(`Updating ${event.attribute} for ${this.name} from event to ${event.value}`);
    if (event.capability === 'temperatureMeasurement' && event.attribute === 'temperature') {
      const unit = event.unit || this.deviceStatus.status.temperatureMeasurement?.temperature?.unit;
      if ((unit === 'C' || unit === 'F') && typeof event.value === 'number') {
        this.units = unit;
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature,
          unit === 'F' ? (event.value - 32) * (5 / 9) : event.value);
      }
      return;
    }
    if ((event.capability === 'thermostatHeatingSetpoint' && event.attribute === 'heatingSetpoint') ||
      (event.capability === 'thermostatCoolingSetpoint' && event.attribute === 'coolingSetpoint')) {
      const cooling = this.targetHeatingCoolingState === this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      if ((event.capability === 'thermostatCoolingSetpoint') !== cooling) {
        return;
      }
      const unit = event.unit || this.deviceStatus.status[event.capability]?.[event.attribute]?.unit ||
        this.deviceStatus.status.temperatureMeasurement?.temperature?.unit;
      this.publishTargetTemperature(event.value, unit);
    } else if (event.capability === 'thermostatMode' && event.attribute === 'thermostatMode') {
      let value: CharacteristicValue;
      switch (event.value) {
        case 'cool':
          value = this.platform.Characteristic.TargetHeatingCoolingState.COOL;
          break;

        case 'heat':
          value = this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
          break;

        case 'auto':
          value = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
          break;

        case 'off':
          value = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
          break;
        default:
          return;
      }
      this.targetHeatingCoolingState = value;
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, value);
      const cooling = value === this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      const capability = cooling ? 'thermostatCoolingSetpoint' : 'thermostatHeatingSetpoint';
      const attribute = cooling ? 'coolingSetpoint' : 'heatingSetpoint';
      const target = this.deviceStatus.status[capability]?.[attribute];
      const unit = target?.unit || this.deviceStatus.status.temperatureMeasurement?.temperature?.unit;
      this.publishTargetTemperature(target?.value, unit);
    } else {
      return;
    }
  }

  private publishTargetTemperature(value: unknown, unit: unknown): void {
    if ((unit !== 'F' && unit !== 'C') || typeof value !== 'number' || !Number.isFinite(value)) {
      return;
    }
    this.targetTemperature = unit === 'F' ? (value - 32) * (5 / 9) : value;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.targetTemperature);
  }

}
