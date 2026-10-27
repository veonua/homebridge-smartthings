import { X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http2 from 'node:http2';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';

interface HubCredentials {
  hubId: string;
  hubHost: string;
  hubPort?: number;
  access_token: string;
  public_certificate: string;
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 6;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_COMMANDS = 32;

export class LocalHubHttpError extends Error {
  constructor(public readonly statusCode: number) {
    super(`Local hub returned HTTP ${statusCode}`);
  }
}

export interface LocalHubCommand {
  capability: string;
  command: string;
  component?: string;
  arguments?: unknown[];
}

/** Client for the SmartThings hub's local API. */
export class LocalHubClient {
  private activeRequests = 0;
  private readonly waitingRequests: Array<() => void> = [];

  constructor(private readonly tokenFile: string) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** A successful response means the hub accepted every command, not that a device has acted. */
  async executeCommands(deviceId: string, commands: LocalHubCommand[]): Promise<void> {
    if (typeof deviceId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(deviceId) ||
      !Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS ||
      commands.some(command => !command || typeof command.capability !== 'string' || !command.capability ||
        command.capability.length > 256 || typeof command.command !== 'string' || !command.command ||
        command.command.length > 256 || (command.component !== undefined &&
          (typeof command.component !== 'string' || !command.component || command.component.length > 256)) ||
        (command.arguments !== undefined && !Array.isArray(command.arguments)))) {
      throw new Error('Invalid local hub command');
    }
    let body: string;
    try {
      body = JSON.stringify({ commands: commands.map(command => ({
        component: command.component ?? 'main', capability: command.capability, command: command.command,
        arguments: command.arguments ?? [],
      })) });
    } catch {
      throw new Error('Invalid local hub command');
    }
    if (Buffer.byteLength(body) > MAX_COMMAND_BYTES) {
      throw new Error('Local hub command exceeded size limit');
    }
    // Never retry a POST: even an interrupted response may have applied the command.
    const response = await this.request<{ results?: unknown }>(
      'POST', `/devices/${encodeURIComponent(deviceId)}/commands`, body);
    if (!response || !Array.isArray(response.results) || response.results.length !== commands.length ||
      response.results.some(result => !result || typeof result !== 'object' ||
        typeof result.id !== 'string' || !result.id ||
        (result.status !== 'ACCEPTED' && result.status !== 'COMPLETED'))) {
      throw new Error('Local hub did not accept every command');
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: string): Promise<T> {
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>(resolve => this.waitingRequests.push(resolve));
    } else {
      this.activeRequests++;
    }
    try {
      return await this.requestOnce<T>(method, path, body);
    } finally {
      const next = this.waitingRequests.shift();
      if (next) {
        next();
      } else {
        this.activeRequests--;
      }
    }
  }

  private async requestOnce<T>(method: 'GET' | 'POST', path: string, body?: string): Promise<T> {
    // Only relative API paths are allowed; never forward the token to a URL.
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) {
      throw new Error('Invalid local hub API path');
    }

    let credentials: HubCredentials;
    try {
      credentials = JSON.parse(await fs.readFile(this.tokenFile, 'utf8')) as HubCredentials;
    } catch {
      throw new Error('Could not read local hub credentials');
    }
    if (!credentials || typeof credentials.hubId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentials.hubId) ||
      typeof credentials.hubHost !== 'string' ||
      !(isIP(credentials.hubHost) || /^[a-z0-9.-]+$/i.test(credentials.hubHost)) ||
      typeof credentials.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(credentials.access_token) ||
      typeof credentials.public_certificate !== 'string' || !credentials.public_certificate ||
      (credentials.hubPort !== undefined && (!Number.isInteger(credentials.hubPort) ||
        credentials.hubPort < 1 || credentials.hubPort > 65535))) {
      throw new Error('Invalid local hub credentials');
    }

    const servername = `svc-hla-tcp.hub-${credentials.hubId}.smartthings`;
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(credentials.public_certificate);
    } catch {
      throw new Error('Invalid local hub certificate');
    }
    if (!certificate.checkHost(servername)) {
      throw new Error('Local hub certificate hostname mismatch');
    }
    const host = isIP(credentials.hubHost) === 6 ? `[${credentials.hubHost}]` : credentials.hubHost;
    const origin = `https://${host}:${credentials.hubPort ?? 8766}`;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const session = http2.connect(origin, {
        ca: credentials.public_certificate,
        servername,
        rejectUnauthorized: true,
      });
      const finish = (error?: Error, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        session.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(value as T);
        }
      };
      const timer = setTimeout(() => finish(new Error('Local hub request timed out')), REQUEST_TIMEOUT_MS);
      // Avoid exposing request headers or credentials through underlying error messages.
      session.on('error', () => finish(new Error('Local hub connection failed')));
      session.once('connect', () => {
        if (settled) {
          return;
        }
        const socket = session.socket as TLSSocket;
        if (!socket.authorized || socket.alpnProtocol !== 'h2' ||
          socket.getPeerCertificate().fingerprint256 !== certificate.fingerprint256) {
          finish(new Error('Local hub TLS verification failed'));
          return;
        }
        let request: http2.ClientHttp2Stream;
        try {
          request = session.request({
            ':method': method,
            ':path': path,
            'accept': 'application/vnd.smartthings+json;v=1',
            'authorization': `Bearer ${credentials.access_token}`,
            'x-hub-identifier': credentials.hubId,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          });
        } catch {
          finish(new Error('Local hub request failed'));
          return;
        }
        let status = 0;
        let size = 0;
        const chunks: Buffer[] = [];
        request.on('response', headers => {
          status = Number(headers[':status']);
        });
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new Error('Local hub response exceeded size limit'));
          } else {
            chunks.push(chunk);
          }
        });
        request.on('error', () => finish(new Error('Local hub request failed')));
        request.on('end', () => {
          if (status < 200 || status >= 300) {
            finish(new LocalHubHttpError(status));
            return;
          }
          try {
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            finish(new Error('Local hub returned invalid JSON'));
          }
        });
        request.end(body);
      });
    });
  }

  async getDeviceIds(): Promise<Set<string>> {
    const response = await this.get<{ items?: unknown }>('/devices');
    if (!response || !Array.isArray(response.items) || response.items.some(item =>
      !item || typeof item !== 'object' || typeof item.deviceId !== 'string' || !item.deviceId)) {
      throw new Error('Local hub returned an invalid device list');
    }
    return new Set(response.items.map(item => item.deviceId));
  }
}
