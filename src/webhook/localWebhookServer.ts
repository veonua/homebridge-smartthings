import express from 'express';
import { SmartApp, SmartAppContext, } from '@smartthings/smartapp';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Logger } from 'homebridge';
import { ShortEvent } from './subscriptionHandler';
import { PlatformConfig } from 'homebridge';
import { AppEvent } from '@smartthings/smartapp/lib/lifecycle-events';

export class LocalWebhookServer {
  private app = express();
  
  private capabilitiesToSubscribe = [
    'switch',
    'switchLevel',
    'lock',
    'contactSensor',
    'motionSensor',
    'temperatureMeasurement',
    'illuminanceMeasurement',
    'thermostatCoolingSetpoint',
    'thermostatHeatingSetpoint',
    'thermostatMode',
    'windowShade',
    'windowShadeLevel'
  ];

  private async processDeviceEvent(context: SmartAppContext,
			eventData: AppEvent.DeviceEvent,
			eventTime?: string) {
/*
 Received event: {
 "eventId":"488b4baa-451a-11f0-b273-b34dfcf2419e",
 "locationId":"8db57189-6b62-4033-97d2-d2c53fdb599f",
 "ownerId":"8db57189-6b62-4033-97d2-d2c53fdb599f",
 "ownerType":"LOCATION",
 "deviceId":"1a846e4f-4b13-4a57-bef4-7301f0ec98fe",
 "componentId":"main",
 "capability":"switch",
 "attribute":"switch",
 "value":"on",
 "valueType":"string",
 "stateChange":true,
 "data":{},
 "subscriptionName":"switch-events"}
2025-06-09T10:12:44.303Z debug: RESPONSE: {
  "statusCode": 200,
  "eventData": {}
}
 */

    this.log.info(`Received event: ${JSON.stringify(eventData)}`);
    const shortEvent: ShortEvent = {
      deviceId: eventData.deviceId,
      componentId: eventData.componentId,
      capability: eventData.capability,
      attribute: eventData.attribute,
      value: eventData.value,
    };

    const device = this.devices.find(d => d.id === shortEvent.deviceId);
    if (device) {
      device.processEvent(shortEvent);
    } else {
      this.log.warn(`Device with ID ${shortEvent.deviceId} not found for event processing.`);
    }
  }
  
  private server; // NodeJS HTTP server
  constructor(private log: Logger, public readonly config: PlatformConfig, private devices: MultiServiceAccessory[], private port: number) {
    if (!config.SmartAppClientId || !config.SmartAppClientSecret || !config.SmartAppId) {
      this.log.error('SmartAppClientId, SmartAppClientSecret, and SmartAppId must be configured in the platform config.');
      throw new Error('Missing SmartApp configuration');
    }
    
    const smartapp = new SmartApp()
    .enableEventLogging(2)
    .clientId(config.SmartAppClientId).clientSecret(config.SmartAppClientSecret)
    .appId(config.SmartAppId).permissions(['r:devices:*', 'x:devices:*', 'r:locations:*', 'r:scenes:*'])
    .disableCustomDisplayName(true)
    .subscribedDeviceLifecycleEventHandler('lifecycle', async (context, event) => {
      this.log.info(`Lifecycle event: ${JSON.stringify(event)}`);
    })
    .subscribedDeviceHealthEventHandler('health', async (context, event) => {
      this.log.info(`Health event: ${JSON.stringify(event)}`);
    })
    // Configuration page definition
    .page('mainPage', (_, page) => {

        page.section('types', section => {
				section.booleanSetting('switches').defaultValue("true")
				section.booleanSetting('locks').defaultValue("true")
        section.booleanSetting('devices').defaultValue("true")
			});

			page.complete(true)
    })
    .updated(async (context: SmartAppContext, updateData: AppEvent.UpdateData) => {
      await context.api.subscriptions.delete()
      
      this.capabilitiesToSubscribe.forEach(async (capability) => {
        await context.api.subscriptions.subscribeToCapability(capability, "*", capability + "-events");
      });

      await context.api.subscriptions.subscribeToDeviceLifecycle("lifecycle");
      await context.api.subscriptions.subscribeToDeviceHealth("health");
    });

    this.capabilitiesToSubscribe.forEach((capability) => {
      smartapp.subscribedDeviceEventHandler(capability + '-events', async (context, event) => {
        return  this.processDeviceEvent(context, event);
      });
    });

    this.app.use(express.json());
    this.app.post('/webhook', (req, res) => {
      console.log(JSON.stringify(req.query));
      console.log(req.header('Authorization'));
      smartapp.handleHttpCallback(req, res);
    });
    this.app.post('/', (req, res) => {
      console.log(JSON.stringify(req.query));
      console.log(req.header('Authorization'));
      smartapp.handleHttpCallback(req, res);
    });

    // Optional manual event injection for testing via Postman
    this.app.post('/event', (req, res) => {
      const events: ShortEvent[] = req.body.events || [];
      events.forEach(event => {
        const device = this.devices.find(d => d.id === event.deviceId);
        if (device) {
          device.processEvent(event);
        }
      });
      res.sendStatus(200);
    });
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      this.log.info(`Local webhook listening on port ${this.port}`);
    });
  }

  stop() {
    this.server?.close();
  }
}
