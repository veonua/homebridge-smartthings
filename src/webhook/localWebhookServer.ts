import express from 'express';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Logger } from 'homebridge';
import { ShortEvent } from './subscriptionHandler';

export class LocalWebhookServer {
  private app = express();
  private server; // NodeJS HTTP server
  constructor(private log: Logger, private devices: MultiServiceAccessory[], private port: number) {
    this.app.use(express.json());
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
