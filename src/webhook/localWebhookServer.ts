import express from 'express';
import { SmartApp } from '@smartthings/smartapp';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Logger } from 'homebridge';
import { ShortEvent } from './subscriptionHandler';
import { PlatformConfig } from 'homebridge';

export class LocalWebhookServer {
  private app = express();
    
  private server; // NodeJS HTTP server
  constructor(private log: Logger, public readonly config: PlatformConfig, private devices: MultiServiceAccessory[], private port: number) {
    const smartapp = new SmartApp()
    .enableEventLogging(2)
    .clientId(config.SmartAppClientId || "8a4b3887-fa4e-4994-a067-7fcec1bfa61e")
    .clientSecret(config.SmartAppClientSecret || "bd932369-b1b5-4431-a739-3cfc26f6cb1c")
    .appId("a1fd6bcf-1d50-4e33-883a-4274db0d3fba").permissions(['r:devices:*', 'x:devices:*', 'r:locations:*', 'r:scenes:*'])
    .disableCustomDisplayName(true)
    .subscribedEventHandler('devices', async (context, event) => {
      this.log.info(`Received event: ${JSON.stringify(event)}`);
      const shortEvent: ShortEvent = {
        deviceId: event.deviceId,
        componentId: event.componentId,
        capability: event.capability,
        attribute: event.attribute,
        value: event.value,
      };

      const device = this.devices.find(d => d.id === shortEvent.deviceId);
      if (device) {
        device.processEvent(shortEvent);
      }
    })
    // Configuration page definition
    .page('mainPage', (_, page) => {

      // If the account exists, i.e. the user has logged in via the OAuth process, then display
			// the connection options
			page.section('types', section => {
				section.booleanSetting('switches').defaultValue("true")
				section.booleanSetting('locks').defaultValue("true")
        section.booleanSetting('devices').defaultValue("true")
			});

			page.complete(true)

      // prompts user to select a contact sensor
      page.section('sensors', section => {
        section
          .deviceSetting('contactSensor')
          .capabilities(['contactSensor'])
          .multiple(true)
          .required(false)
      })

      // prompts users to select one or more switch devices
      page.section('lights', section => {
        section
          .deviceSetting('lights')
          .capabilities(['switch'])
          .required(false)
          .multiple(true)
          .permissions('rx')
      })
    })
    .updated(async (context) => {
      await context.api.subscriptions.delete()
      await context.api.subscriptions.subscribeToCapability("switch", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("switchLevel", "*", "devices")

      await context.api.subscriptions.subscribeToCapability("lock", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("contactSensor", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("motionSensor", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("temperatureMeasurement", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("illuminanceMeasurement", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("powerMeter", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("energyMeter", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("switchLevel", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("thermostatCoolingSetpoint", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("thermostatHeatingSetpoint", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("thermostatMode", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("windowShade", "*", "devices")
      await context.api.subscriptions.subscribeToCapability("windowShadeLevel", "*", "devices")

    });

    this.app.use(express.json());
    this.app.get('/oauth', (req, res) => {
      console.log(JSON.stringify(req.query));
      res.send("OK");
    });
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
