import express from 'express';
import { SmartApp } from '@smartthings/smartapp';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Logger } from 'homebridge';
import { ShortEvent } from './subscriptionHandler';

export class LocalWebhookServer {
  private app = express();
  private smartapp = new SmartApp().enableEventLogging(2)
    .subscribedEventHandler('deviceEvent', async (context, event) => {
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
    });
  private server; // NodeJS HTTP server
  constructor(private log: Logger, private devices: MultiServiceAccessory[], private port: number) {
    this.app.use(express.json());
    this.app.post('/', (req, res) => {
      this.smartapp.handleHttpCallback(req, res);
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
