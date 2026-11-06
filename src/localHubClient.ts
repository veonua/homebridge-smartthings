import { X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http2, { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
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
const NETWORK_RETRY_MS = 30000;
const NETWORK_ERRORS = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

function networkErrorCode(error: unknown, seen = new Set<object>()): string | undefined {
  if (!error || typeof error !== 'object' || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  const failure = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof failure.code === 'string' && NETWORK_ERRORS.has(failure.code)) {
    return failure.code;
  }
  const cause = networkErrorCode(failure.cause, seen);
  if (cause) {
    return cause;
  }
  if (Array.isArray(failure.errors) && failure.errors.length) {
    const codes = failure.errors.map(item => networkErrorCode(item, new Set(seen)));
    // Do not hide an unrelated error mixed into an AggregateError.
    if (codes.every(code => code !== undefined)) {
      return codes[0];
    }
  }
  return undefined;
}

export class LocalHubUnavailableError extends Error {
  constructor(public readonly code: string, public readonly retryAt: number) {
    super(`Local hub temporarily unavailable (${code})`);
  }
}

interface ConnectionCallbacks {
  onUnavailable?: (code: string) => void;
  onRestored?: (durationMs: number) => void;
}

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
  private readonly waitingCommands: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly waitingReads: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private connection: { key: string; session: ClientHttp2Session; ready: Promise<ClientHttp2Session> } | undefined;
  private readonly sessions = new Set<ClientHttp2Session>();
  private readonly sessionFailures = new WeakMap<ClientHttp2Session, LocalHubUnavailableError>();
  private outage: { code: string; since: number; retryAt: number } | undefined;
  private closed = false;

  constructor(private readonly tokenFile: string, private readonly callbacks: ConnectionCallbacks = {}) {}

  get unavailableError(): LocalHubUnavailableError | undefined {
    return this.outage ? new LocalHubUnavailableError(this.outage.code, this.outage.retryAt) : undefined;
  }

  private unavailable(code: string): LocalHubUnavailableError {
    const first = !this.outage;
    const now = Date.now();
    this.outage = { code, since: this.outage?.since ?? now, retryAt: now + NETWORK_RETRY_MS };
    if (first && !this.closed) {
      try {
        this.callbacks.onUnavailable?.(code);
      } catch { /* Logging must not affect requests. */ }
    }
    return this.unavailableError!;
  }

  private restored(): void {
    if (this.outage && !this.closed) {
      const durationMs = Math.max(0, Date.now() - this.outage.since);
      this.outage = undefined;
      try {
        this.callbacks.onRestored?.(durationMs);
      } catch { /* Logging must not affect requests. */ }
    }
  }

  private checkAvailability(): void {
    if (this.outage && Date.now() < this.outage.retryAt) {
      throw this.unavailableError;
    }
  }

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
    if (this.closed) {
      throw new Error('Local hub client closed');
    }
    this.checkAvailability();
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve, reject) => {
        (method === 'POST' ? this.waitingCommands : this.waitingReads).push({ resolve, reject });
      });
    } else {
      this.activeRequests++;
    }
    try {
      if (this.closed) {
        throw new Error('Local hub client closed');
      }
      this.checkAvailability();
      const result = await this.requestOnce<T>(method, path, body);
      this.restored();
      return result;
    } catch (error) {
      if (error instanceof LocalHubHttpError) {
        this.restored();
      }
      throw error;
    } finally {
      const next = this.waitingCommands.shift() ?? this.waitingReads.shift();
      if (next) {
        next.resolve();
      } else {
        this.activeRequests--;
      }
    }
  }

  private async sessionFor(origin: string, servername: string, certificate: X509Certificate, ca: string): Promise<ClientHttp2Session> {
    if (this.closed) {
      return Promise.reject(new Error('Local hub client closed'));
    }
    this.checkAvailability();
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
      const fail = (error: Error) => {
        clearTimeout(timer);
        invalidate();
        reject(error);
      };
      const timer = setTimeout(() => {
        const error = this.unavailable('ETIMEDOUT');
        this.sessionFailures.set(session, error);
        fail(error);
        session.destroy();
      }, REQUEST_TIMEOUT_MS);
      // Keep underlying TLS errors and credentials out of public error messages.
      session.on('error', error => {
        const code = networkErrorCode(error);
        const failure = code ? this.unavailable(code) : new Error('Local hub connection failed');
        if (failure instanceof LocalHubUnavailableError) {
          this.sessionFailures.set(session, failure);
        }
        fail(failure);
        session.destroy();
      });
      session.once('goaway', () => {
        fail(new Error('Local hub connection closed'));
        this.retireSession(session);
      });
      session.once('close', () => {
        fail(new Error('Local hub connection closed'));
        this.sessions.delete(session);
      });
      session.once('connect', () => {
        const socket = session.socket as TLSSocket;
        if (!socket.authorized || socket.alpnProtocol !== 'h2' ||
          socket.getPeerCertificate().fingerprint256 !== certificate.fingerprint256) {
          fail(new Error('Local hub TLS verification failed'));
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
      let request: ClientHttp2Stream | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
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
        request.on('error', error => {
          const code = networkErrorCode(error);
          finish(this.sessionFailures.get(session) ?? (code ? this.unavailable(code) : new Error('Local hub request failed')));
        });
        request.on('close', () => finish(this.sessionFailures.get(session) ?? new Error('Local hub request closed')));
        request.on('end', () => {
          if (!status) {
            finish(this.sessionFailures.get(session) ?? new Error('Local hub request closed'));
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
