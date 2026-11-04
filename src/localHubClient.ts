import { X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http2, { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { performance } from 'node:perf_hooks';

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

export interface LocalCommandTiming {
  queueMs?: number;
  prepareMs?: number;
  connectMs?: number;
  responseMs?: number;
}

/** Client for the SmartThings hub's local API. */
export class LocalHubClient {
  private activeRequests = 0;
  private readonly waitingCommands: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly waitingReads: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private connection: { key: string; session: ClientHttp2Session; ready: Promise<ClientHttp2Session> } | undefined;
  private readonly sessions = new Set<ClientHttp2Session>();
  private closed = false;

  constructor(private readonly tokenFile: string) {}

  close(): void {
    this.closed = true;
    this.connection = undefined;
    for (const pending of [...this.waitingCommands.splice(0), ...this.waitingReads.splice(0)]) {
      pending.reject(new Error('Local hub client closed'));
    }
    for (const session of this.sessions) {
      session.destroy();
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** A successful response means the hub accepted every command, not that a device has acted. */
  async executeCommands(deviceId: string, commands: LocalHubCommand[], onTiming?: (timing: LocalCommandTiming) => void): Promise<void> {
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
    const timing: LocalCommandTiming | undefined = onTiming ? {} : undefined;
    try {
      const response = await this.request<{ results?: unknown }>(
        'POST', `/devices/${encodeURIComponent(deviceId)}/commands`, body, timing);
      if (!response || !Array.isArray(response.results) || response.results.length !== commands.length ||
        response.results.some(result => !result || typeof result !== 'object' ||
          typeof result.id !== 'string' || !result.id ||
          (result.status !== 'ACCEPTED' && result.status !== 'COMPLETED'))) {
        throw new Error('Local hub did not accept every command');
      }
    } finally {
      if (onTiming && timing) {
        try {
          onTiming(timing);
        } catch { /* Diagnostic callbacks must not change command outcomes. */ }
      }
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: string, timing?: LocalCommandTiming): Promise<T> {
    if (this.closed) {
      throw new Error('Local hub client closed');
    }
    const queuedAt = performance.now();
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve, reject) => {
        (method === 'POST' ? this.waitingCommands : this.waitingReads).push({ resolve, reject });
      });
    } else {
      this.activeRequests++;
    }
    if (timing) {
      timing.queueMs = performance.now() - queuedAt;
    }
    try {
      if (this.closed) {
        throw new Error('Local hub client closed');
      }
      return await this.requestOnce<T>(method, path, body, timing);
    } finally {
      const next = this.waitingCommands.shift() ?? this.waitingReads.shift();
      if (next) {
        next.resolve();
      } else {
        this.activeRequests--;
      }
    }
  }

  private sessionFor(origin: string, servername: string, certificate: X509Certificate, ca: string): Promise<ClientHttp2Session> {
    if (this.closed) {
      return Promise.reject(new Error('Local hub client closed'));
    }
    // Tokens authenticate individual streams, not the TLS session. A changed
    // destination or pinned certificate must always create a new session.
    const key = JSON.stringify([origin, servername, certificate.fingerprint256]);
    if (this.connection?.key === key && !this.connection.session.closed && !this.connection.session.destroyed) {
      return this.connection.ready;
    }
    // Let requests using the previous destination finish without replaying them.
    if (this.connection) {
      this.retireSession(this.connection.session);
    }
    const session = http2.connect(origin, { ca, servername, rejectUnauthorized: true });
    this.sessions.add(session);
    const invalidate = () => {
      if (this.connection?.session === session) {
        this.connection = undefined;
      }
    };
    const ready = new Promise<ClientHttp2Session>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        invalidate();
        reject(new Error(message));
      };
      const timer = setTimeout(() => {
        fail('Local hub connection timed out');
        session.destroy();
      }, REQUEST_TIMEOUT_MS);
      // Keep underlying TLS errors and credentials out of public error messages.
      session.on('error', () => {
        fail('Local hub connection failed');
        session.destroy();
      });
      session.once('goaway', () => {
        fail('Local hub connection closed');
        this.retireSession(session);
      });
      session.once('close', () => {
        fail('Local hub connection closed');
        this.sessions.delete(session);
      });
      session.once('connect', () => {
        const socket = session.socket as TLSSocket;
        if (!socket.authorized || socket.alpnProtocol !== 'h2' ||
          socket.getPeerCertificate().fingerprint256 !== certificate.fingerprint256) {
          fail('Local hub TLS verification failed');
          session.destroy();
          return;
        }
        clearTimeout(timer);
        // Idle connections must not keep Homebridge alive during shutdown.
        // Each active request has its own referenced deadline timer.
        session.unref();
        resolve(session);
      });
    });
    this.connection = { key, session, ready };
    return ready;
  }

  private retireSession(session: ClientHttp2Session): void {
    session.close();
    // A peer may send GOAWAY without closing its socket. Bound cleanup while
    // allowing already-sent requests their normal deadline to finish.
    const timer = setTimeout(() => session.destroy(), REQUEST_TIMEOUT_MS);
    timer.unref();
    session.once('close', () => clearTimeout(timer));
  }

  private async requestOnce<T>(method: 'GET' | 'POST', path: string, body?: string, timing?: LocalCommandTiming): Promise<T> {
    const preparingAt = performance.now();
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

    if (timing) {
      timing.prepareMs = performance.now() - preparingAt;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const connectingAt = performance.now();
      let sentAt: number | undefined;
      let request: ClientHttp2Stream | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timing && timing.connectMs === undefined) {
          timing.connectMs = performance.now() - connectingAt;
        }
        if (timing && sentAt !== undefined) {
          timing.responseMs = performance.now() - sentAt;
        }
        clearTimeout(timer);
        if (error) {
          request?.destroy();
          reject(error);
        } else {
          resolve(value as T);
        }
      };
      const timer = setTimeout(() => finish(new Error('Local hub request timed out')), REQUEST_TIMEOUT_MS);
      this.sessionFor(origin, servername, certificate, credentials.public_certificate).then(session => {
        if (settled) {
          return;
        }
        if (timing) {
          timing.connectMs = performance.now() - connectingAt;
        }
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
        request.on('close', () => finish(new Error('Local hub request closed')));
        request.on('end', () => {
          if (!status) {
            finish(new Error('Local hub request closed'));
            return;
          }
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
        sentAt = performance.now();
        request.end(body);
      }).catch(error => finish(error));
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
