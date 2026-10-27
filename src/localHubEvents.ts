import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import http2, { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';
import { isIP } from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TLSSocket } from 'node:tls';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT = 15000;
const CHECK_CREDENTIALS_MS = 30000;
const ROTATION_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FORBIDDEN_RECHECK_MS = 30000;
const MAX_UNRESOLVED_ARCHIVES = 6;
const KNOWN_ERRORS = new Set([
  'CertificateHostnameMismatch', 'CertificateVerificationFailed', 'ConnectionClosed', 'ConnectionFailed', 'ConnectionTimeout',
  'CredentialReadFailed', 'ExternalSubscriptionMissing', 'HubTokenExpired', 'InvalidCertificate', 'InvalidCredentials',
  'InvalidEventStream', 'InvalidRegistrationUrl', 'RequestFailed', 'RequestTimeout', 'ResponseTooLarge', 'Stopped',
  'StreamFailed', 'StreamRejected', 'StreamTimeout', 'SubscriptionCreationUnknown', 'SubscriptionLockBusy',
  'SubscriptionLockUnavailable', 'SubscriptionLookupFailed', 'SubscriptionMismatch', 'SubscriptionRotationLimited',
  'SubscriptionStateInvalid',
  'SubscriptionStateWriteFailed', 'UnsafePrivateFile', 'UnsafeStateDirectory',
]);
const SAFE_SYSTEM_ERRORS = new Set([
  'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ELOOP', 'ENOENT', 'ENOTFOUND', 'EPERM', 'EPIPE', 'ETIMEDOUT',
  'ERR_HTTP2_ERROR', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_INVALID_STREAM',
  'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_STREAM_CANCEL', 'ERR_HTTP2_STREAM_ERROR', 'ERR_INVALID_STATE', 'ERR_INVALID_URL',
  'ERR_STREAM_DESTROYED',
]);
type EventStage = 'credentials' | 'connection' | 'subscription' | 'stream';

class RequestNotSentError extends Error {
  readonly code = 'ERR_HTTP2_INVALID_SESSION';

  constructor() {
    super('RequestNotSent');
  }
}

function safeError(stage: EventStage, error: unknown): string {
  const value = error as { message?: unknown; code?: unknown } | null;
  if (typeof value?.message === 'string' && KNOWN_ERRORS.has(value.message)) {
    return value.message;
  }
  const systemCode = typeof value?.code === 'string' && SAFE_SYSTEM_ERRORS.has(value.code) ? value.code : undefined;
  const category = systemCode || (error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' :
    error instanceof SyntaxError ? 'SyntaxError' : 'Error');
  // The stage and code are both from fixed allowlists; never expose error text.
  return `LocalEventsFailed_${stage}_${category}`;
}

type Credential = { hubId: string; hubHost: string; hubPort?: number; access_token: string; public_certificate: string };
type Stored = {
  version: 1;
  hubId: string;
  locationIds: string[];
  name: string;
  stage: 'pending' | 'ready';
  subscriptionId?: string;
  ownership?: 'owned' | 'external';
  reason?: string;
  httpStatus?: number;
  lastRotationAt?: number;
  previousArchive?: string;
};
export interface LocalDeviceEvent {
  eventTime: number;
  eventType: 'DEVICE_EVENT';
  deviceEvent: {
    deviceId: string; locationId: string; componentId: string; capability: string; attribute: string; value: unknown;
    eventId?: string; unit?: string | null; data?: unknown;[key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface LocalHubEventsOptions {
  tokenFile: string;
  subscriptionFile: string;
  locationIds: string[];
  onConnected: () => void;
  onDisconnected: () => void;
  onDeviceEvent: (event: LocalDeviceEvent) => void;
  onError: (code: string) => void;
}

type Message = { event: string; data: string; id?: string };
/** Incremental SSE framing with bounded line and event sizes. */
export class SseParser {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private data: string[] = [];
  private dataSize = 0;
  private event = '';
  private id: string | undefined;

  constructor(private readonly callback: (message: Message) => void) { }

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) + this.dataSize > MAX_BYTES) {
      throw new Error('EventTooLarge');
    }
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match || (match[0] === '\r' && match.index === this.buffer.length - 1)) {
        return;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length) {
          this.callback({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
        }
        this.data = [];
        this.dataSize = 0;
        this.event = '';
        this.id = undefined;
        continue;
      }
      if (line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (field === 'data') {
        this.data.push(value);
        this.dataSize += Buffer.byteLength(value) + 1;
        if (this.dataSize > MAX_BYTES) {
          throw new Error('EventTooLarge');
        }
      } else if (field === 'event') {
        this.event = value;
      } else if (field === 'id' && !value.includes('\0')) {
        this.id = value;
      }
    }
  }
}

function validateEvent(message: Message, locations: string[]): LocalDeviceEvent | undefined {
  if (message.event !== 'DEVICE_EVENT') {
    return;
  }
  let data: any;
  try {
    data = JSON.parse(message.data);
  } catch {
    return;
  }
  const event = data?.deviceEvent;
  if (data?.eventType !== 'DEVICE_EVENT' || typeof data.eventTime !== 'number' || !Number.isFinite(data.eventTime) ||
    Math.abs(data.eventTime) > 8640000000000000 || !event || typeof event !== 'object' || Array.isArray(event) ||
    !['deviceId', 'locationId', 'componentId', 'capability', 'attribute'].every(key => typeof event[key] === 'string' && event[key]) ||
    !locations.includes(event.locationId) || !Object.prototype.hasOwnProperty.call(event, 'value') ||
    (event.eventId !== undefined && typeof event.eventId !== 'string') ||
    (event.unit !== undefined && event.unit !== null && typeof event.unit !== 'string')) {
    return;
  }
  return data as LocalDeviceEvent;
}

async function readPrivate(file: string): Promise<any> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > MAX_BYTES) {
      throw new Error('UnsafePrivateFile');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
async function directorySync(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (e: any) {
    if (!['EINVAL', 'ENOTSUP'].includes(e.code)) {
      throw e;
    }
  } finally {
    await handle.close();
  }
}
async function secureDirectory(file: string): Promise<void> {
  const st = await fs.lstat(path.dirname(file));
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) {
    throw new Error('UnsafeStateDirectory');
  }
}
async function saveState(file: string, state: Stored, create: boolean): Promise<void> {
  await secureDirectory(file);
  const target = create ? file : `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!create) {
      await fs.rename(target, file);
    }
    await directorySync(path.dirname(file));
  } finally {
    if (handle) {
      await handle.close();
    }
    if (!create) {
      try {
        await fs.unlink(target);
      } catch { /* No credentials are stored in the temporary state file. */ }
    }
  }
}
function validCredentials(value: any): value is Credential {
  return !!value && typeof value.hubId === 'string' && UUID.test(value.hubId) && typeof value.hubHost === 'string' &&
    (!!isIP(value.hubHost) || /^[a-z0-9.-]+$/i.test(value.hubHost)) &&
    (value.hubPort === undefined || (Number.isInteger(value.hubPort) && value.hubPort >= 1 && value.hubPort <= 65535)) &&
    typeof value.access_token === 'string' && /^[\x21-\x7e]+$/.test(value.access_token) &&
    typeof value.public_certificate === 'string' && !!value.public_certificate;
}
function originOf(c: Credential): string {
  const host = isIP(c.hubHost) === 6 ? `[${c.hubHost}]` : c.hubHost;
  return `https://${host}:${c.hubPort ?? 8766}`;
}
function registrationPath(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('InvalidRegistrationUrl');
  }
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || url.hash || !url.pathname.startsWith('/')) {
    throw new Error('InvalidRegistrationUrl');
  }
  return `${url.pathname}${url.search}`;
}
function matchesFilters(value: any, locations: string[]): boolean {
  if (!Array.isArray(value) || value.length !== 1) {
    return false;
  }
  const f = value[0];
  return f?.type === 'LOCATIONIDS' && Array.isArray(f.value) && f.value.length === locations.length &&
    locations.every(id => f.value.includes(id)) && (!f.eventType || (Array.isArray(f.eventType) && !f.eventType.length)) &&
    Object.entries(f).every(([key, v]) => ['type', 'value', 'eventType'].includes(key) || v === null || v === undefined ||
      (Array.isArray(v) && v.length === 0));
}
function idHash(c: Credential): string {
  return createHash('sha256').update(c.access_token).update(c.public_certificate).digest('hex');
}
function tokenExpiry(c: Credential): number | undefined {
  try {
    const claims = JSON.parse(Buffer.from(c.access_token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isSafeInteger(claims.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return;
  }
}

export class LocalHubEvents {
  private readonly locations: string[];
  private stopped = true;
  private creating = false;
  private reconnectRequested = false;
  private session: ClientHttp2Session | undefined;
  private stream: ClientHttp2Stream | undefined;
  private done: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private forbidden: { subscriptionId: string; credentials: string; firstSeen: number } | undefined;

  constructor(private readonly options: LocalHubEventsOptions) {
    this.locations = [...new Set(options.locationIds)].sort();
    if (!path.isAbsolute(options.tokenFile) || !path.isAbsolute(options.subscriptionFile) ||
      !this.locations.length || this.locations.some(id => !UUID.test(id))) {
      throw new Error('InvalidLocalEventsConfiguration');
    }
  }

  start(): void {
    if (!this.stopped || this.done) {
      return;
    }
    this.stopped = false;
    this.done = this.loop().finally(() => {
      this.done = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.stream?.close();
    // A POST that may have reached the hub must finish and persist its ID.
    if (!this.creating) {
      this.session?.destroy();
    }
    await this.done;
  }

  reconnect(): void {
    this.reconnectRequested = true;
    this.wake?.();
    if (!this.creating) {
      this.session?.destroy();
    }
  }

  private report(code: string): void {
    try {
      this.options.onError(code);
    } catch { /* Callback failures must not expose secrets or crash the worker. */ }
  }

  private async credentials(): Promise<Credential> {
    let c: unknown;
    try {
      c = await readPrivate(this.options.tokenFile);
    } catch {
      throw new Error('CredentialReadFailed');
    }
    if (!validCredentials(c)) {
      throw new Error('InvalidCredentials');
    }
    return c;
  }

  private async connect(c: Credential): Promise<ClientHttp2Session> {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(c.public_certificate);
    } catch {
      throw new Error('InvalidCertificate');
    }
    const servername = `svc-hla-tcp.hub-${c.hubId}.smartthings`;
    if (!cert.checkHost(servername)) {
      throw new Error('CertificateHostnameMismatch');
    }
    const session = http2.connect(originOf(c), { ca: c.public_certificate, servername, rejectUnauthorized: true });
    this.session = session;
    session.on('error', () => { });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('ConnectionTimeout')), TIMEOUT);
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      session.once('error', () => finish(new Error('ConnectionFailed')));
      session.once('close', () => finish(new Error('ConnectionClosed')));
      session.once('connect', () => {
        const socket = session.socket as TLSSocket;
        if (!socket.authorized || socket.alpnProtocol !== 'h2' || socket.getPeerCertificate().fingerprint256 !== cert.fingerprint256) {
          finish(new Error('CertificateVerificationFailed'));
        } else {
          finish();
        }
      });
    }).catch(error => {
      session.destroy(); throw error;
    });
    return session;
  }

  private async json(session: ClientHttp2Session, c: Credential, method: string, endpoint: string, body?: unknown): Promise<any> {
    // Node versions differ on whether request() throws for an already closed
    // session. Check before creating a stream so an unsent POST remains safe to retry.
    if (session.closed || session.destroyed) {
      throw new RequestNotSentError();
    }
    return new Promise((resolve, reject) => {
      let done = false;
      let status = 0;
      let size = 0;
      const chunks: Buffer[] = [];
      let req: ClientHttp2Stream;
      try {
        req = session.request({
          ':method': method, ':path': endpoint,
          authorization: `Bearer ${c.access_token}`, 'x-hub-identifier': c.hubId,
          accept: 'application/vnd.smartthings+json;v=1', ...(body ? { 'content-type': 'application/json' } : {}),
        });
      } catch (error: any) {
        // request() failed before a stream was created, so no POST was sent.
        if (['ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_STREAM'].includes(error?.code)) {
          reject(new RequestNotSentError());
        } else {
          reject(error);
        }
        return;
      }
      const finish = (error?: Error) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        if (error) {
          reject(error); return;
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          data = null;
        }
        resolve({ status, data });
      };
      const timer = setTimeout(() => {
        req.destroy(); finish(new Error('RequestTimeout'));
      }, TIMEOUT);
      req.on('response', h => {
        status = Number(h[':status']);
      });
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy(); finish(new Error('ResponseTooLarge'));
        } else {
          chunks.push(chunk);
        }
      });
      req.on('error', () => finish(new Error('RequestFailed')));
      req.on('aborted', () => finish(new Error('RequestFailed')));
      req.on('end', () => finish());
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  private async readState(c: Credential): Promise<Stored | undefined> {
    await secureDirectory(this.options.subscriptionFile);
    let saved: any;
    try {
      saved = await readPrivate(this.options.subscriptionFile);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return;
      }
      throw new Error('SubscriptionStateInvalid');
    }
    const external = saved?.ownership === 'external';
    if (!saved || saved.version !== 1 || saved.hubId !== c.hubId || !Array.isArray(saved.locationIds) ||
      saved.locationIds.length !== this.locations.length || !this.locations.every(id => saved.locationIds.includes(id)) ||
      typeof saved.name !== 'string' || (external
        ? !saved.name.trim() || saved.name.length > 128 || Array.from(saved.name as string)
          .some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        : !/^Homebridge local events [0-9a-f-]{36}$/i.test(saved.name)) ||
      ![undefined, 'owned', 'external'].includes(saved.ownership) ||
      (saved.lastRotationAt !== undefined && (!Number.isSafeInteger(saved.lastRotationAt) || saved.lastRotationAt < 0)) ||
      (saved.previousArchive !== undefined && (typeof saved.previousArchive !== 'string' ||
        !/^previous-[0-9a-f-]{36}\.json$/i.test(saved.previousArchive))) ||
      !['pending', 'ready'].includes(saved.stage) || (external && saved.stage !== 'ready') ||
      (saved.subscriptionId !== undefined && (typeof saved.subscriptionId !== 'string' || !UUID.test(saved.subscriptionId))) ||
      (saved.stage === 'ready' && !UUID.test(saved.subscriptionId || ''))) {
      throw new Error('SubscriptionStateInvalid');
    }
    return saved;
  }

  private verifyOwnership(data: any, saved: Stored): void {
    if (!data || data.subscriptionId !== saved.subscriptionId || data.name !== saved.name ||
      !matchesFilters(data.subscriptionFilters, this.locations)) {
      throw new Error('SubscriptionMismatch');
    }
  }

  private verifySubscription(data: any, saved: Stored, origin: string): string {
    this.verifyOwnership(data, saved);
    return registrationPath(data.registrationUrl, origin);
  }

  private async subscription(session: ClientHttp2Session, c: Credential): Promise<string> {
    return this.subscriptionLocked(session, c);
  }

  private async acquireStateLock(): Promise<() => Promise<void>> {
    await secureDirectory(this.options.subscriptionFile);
    if (!['linux', 'darwin'].includes(process.platform)) {
      throw new Error('SubscriptionLockUnavailable');
    }
    const lock = `${this.options.subscriptionFile}.lock`;
    try {
      const handle = await fs.open(lock, 'wx', 0o600);
      await handle.close();
    } catch (e: any) {
      if (e.code !== 'EEXIST') {
        throw new Error('SubscriptionLockUnavailable');
      }
    }
    const st = await fs.lstat(lock);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) {
      throw new Error('SubscriptionLockUnavailable');
    }
    const command = process.platform === 'darwin' ? '/usr/bin/lockf' : '/usr/bin/flock';
    const args = process.platform === 'darwin' ? ['-s', '-k', '-t', '0', lock] : ['-n', '-E', '75', lock];
    const holder = spawn(command, [...args, process.execPath, '-e',
      'process.stdin.on(\'end\',()=>process.exit(0));process.stdin.resume();process.stdout.write(\'locked\');'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    holder.stdin.on('error', () => { });
    let exited = false;
    let releasing = false;
    const closed = new Promise<void>(resolve => {
      holder.on('close', () => {
        exited = true;
        if (!releasing) {
          this.session?.destroy();
        }
        resolve();
      });
      holder.on('error', () => {
        exited = true; resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        holder.kill();
        finish(new Error('SubscriptionLockUnavailable'));
      }, TIMEOUT);
      holder.once('error', () => finish(new Error('SubscriptionLockUnavailable')));
      holder.once('close', () => finish(new Error('SubscriptionLockBusy')));
      let output = '';
      holder.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (!'locked'.startsWith(output)) {
          finish(new Error('SubscriptionLockUnavailable'));
        } else if (output === 'locked') {
          finish();
        }
      });
    }).catch(error => {
      holder.stdin.end(); throw error;
    });
    return async () => {
      releasing = true;
      if (!exited) {
        holder.stdin.end();
      }
      await closed;
    };
  }

  private async subscriptionLocked(session: ClientHttp2Session, c: Credential): Promise<string> {
    const file = this.options.subscriptionFile;
    let saved = await this.readState(c);
    let previous: Stored | undefined;
    if (saved?.stage === 'pending') {
      throw new Error('SubscriptionCreationUnknown');
    }
    if (saved) {
      let reply;
      try {
        reply = await this.json(session, c, 'GET', `/subscriptions/${saved.subscriptionId}`);
      } catch (error) {
        this.forbidden = undefined;
        throw error;
      }
      if (reply.status === 200) {
        this.forbidden = undefined;
        return this.verifySubscription(reply.data, saved, originOf(c));
      }
      if (saved.ownership === 'external') {
        this.forbidden = undefined;
        throw new Error(reply.status === 404 ? 'ExternalSubscriptionMissing' : 'SubscriptionLookupFailed');
      }
      const credentialHash = `${c.hubId}:${c.hubHost}:${c.hubPort ?? 8766}:${idHash(c)}`;
      if (reply.status === 403) {
        const now = Date.now();
        if (!this.forbidden || this.forbidden.subscriptionId !== saved.subscriptionId ||
          this.forbidden.credentials !== credentialHash || now < this.forbidden.firstSeen) {
          this.forbidden = { subscriptionId: saved.subscriptionId!, credentials: credentialHash, firstSeen: now };
          throw new Error('SubscriptionLookupFailed');
        }
        if (now - this.forbidden.firstSeen < FORBIDDEN_RECHECK_MS) {
          throw new Error('SubscriptionLookupFailed');
        }
      } else {
        this.forbidden = undefined;
        if (reply.status !== 404) {
          throw new Error('SubscriptionLookupFailed');
        }
      }
      const devices = await this.json(session, c, 'GET', '/devices');
      const current = await this.credentials();
      if (devices.status !== 200 || !Array.isArray(devices.data?.items) || devices.data.items.some(item =>
        !item || typeof item !== 'object' || typeof item.deviceId !== 'string' || !item.deviceId) ||
        `${current.hubId}:${current.hubHost}:${current.hubPort ?? 8766}:${idHash(current)}` !== credentialHash ||
        this.stopped || this.reconnectRequested) {
        throw new Error('SubscriptionLookupFailed');
      }
      // For legacy state, the last write time is a conservative lower bound.
      // Clock regressions and unreadable timestamps fail closed.
      const now = Date.now();
      let latestCreation = saved.lastRotationAt;
      if (latestCreation === undefined) {
        try {
          latestCreation = (await fs.stat(file)).mtimeMs;
        } catch {
          throw new Error('SubscriptionRotationLimited');
        }
      }
      if (!Number.isFinite(latestCreation) || latestCreation < 0 || now < latestCreation ||
        now - latestCreation < ROTATION_INTERVAL_MS) {
        throw new Error('SubscriptionRotationLimited');
      }
      const archiveName = `previous-${saved.subscriptionId}.json`;
      const archives = (await fs.readdir(path.dirname(file))).filter(name => /^previous-[0-9a-f-]{36}\.json$/i.test(name));
      if (archives.length > MAX_UNRESOLVED_ARCHIVES ||
        (archives.length === MAX_UNRESOLVED_ARCHIVES && !archives.includes(archiveName))) {
        throw new Error('SubscriptionRotationLimited');
      }
      // Keep the previous subscription before atomically replacing ready with
      // pending; 403 and 404 are both insufficient grounds to delete it.
      const archivePath = path.join(path.dirname(file), archiveName);
      try {
        await saveState(archivePath, saved, true);
      } catch (error: any) {
        if (error.code !== 'EEXIST') {
          throw new Error('SubscriptionStateWriteFailed');
        }
        const archived = await readPrivate(archivePath);
        if (JSON.stringify(archived) !== JSON.stringify(saved)) {
          throw new Error('SubscriptionStateInvalid');
        }
      }
      previous = saved;
      saved = { version: 1, hubId: c.hubId, locationIds: this.locations, name: `Homebridge local events ${randomUUID()}`,
        stage: 'pending', reason: 'AwaitingPostOutcome', previousArchive: archiveName,
        ...(previous.lastRotationAt !== undefined ? { lastRotationAt: previous.lastRotationAt } : {}) };
      await saveState(file, saved, false);
      this.forbidden = undefined;
    }
    if (this.stopped) {
      if (previous) {
        await saveState(file, previous, false);
      }
      throw new Error('Stopped');
    }
    if (!previous) {
      saved = { version: 1, hubId: c.hubId, locationIds: this.locations, name: `Homebridge local events ${randomUUID()}`,
        stage: 'pending', reason: 'AwaitingPostOutcome' };
      // O_EXCL prevents simultaneous processes from issuing two create requests.
      try {
        await saveState(file, saved, true);
      } catch (e: any) {
        if (e.code === 'EEXIST') {
          throw new Error('SubscriptionCreationUnknown');
        }
        throw new Error('SubscriptionStateWriteFailed');
      }
    }
    if (this.stopped) {
      if (previous) {
        await saveState(file, previous, false);
      } else {
        await fs.unlink(file);
        await directorySync(path.dirname(file));
      }
      throw new Error('Stopped');
    }
    if (!saved) {
      throw new Error('SubscriptionStateInvalid');
    }
    this.creating = true;
    try {
      let reply;
      try {
        let current: Credential;
        try {
          current = await this.credentials();
        } catch {
          throw new RequestNotSentError();
        }
        if (this.stopped || this.reconnectRequested || current.hubId !== c.hubId || current.hubHost !== c.hubHost ||
          (current.hubPort ?? 8766) !== (c.hubPort ?? 8766) || idHash(current) !== idHash(c)) {
          throw new RequestNotSentError();
        }
        reply = await this.json(session, c, 'POST', '/subscriptions', {
          name: saved.name, version: 1, subscriptionFilters: [{ type: 'LOCATIONIDS', value: this.locations }],
        });
      } catch (error: any) {
        if (error instanceof RequestNotSentError) {
          // The request never had a stream. Removing the marker is safe and lets
          // the bounded session retry create exactly one subscription.
          try {
            if (previous) {
              await saveState(file, previous, false);
            } else {
              await fs.unlink(file);
              await directorySync(path.dirname(file));
            }
          } catch {
            throw new Error('SubscriptionCreationUnknown');
          }
          throw error;
        }
        const reason = ['RequestTimeout', 'RequestFailed', 'ResponseTooLarge'].includes(error?.message)
          ? error.message : 'PostOutcomeUnknown';
        try {
 await saveState(file, { ...saved, reason }, false);
} catch {
 this.report('SubscriptionStateWriteFailed');
}
        throw new Error('SubscriptionCreationUnknown');
      }
      const candidateId = typeof reply.data?.subscriptionId === 'string' && UUID.test(reply.data.subscriptionId)
        ? reply.data.subscriptionId : undefined;
      saved = { ...saved, ...(candidateId ? { subscriptionId: candidateId } : {}),
        reason: reply.status === 0 ? 'PostOutcomeUnknown' : reply.status === 200 ? 'ResponseReceived' : 'UnexpectedHttpStatus',
        ...(reply.status >= 100 && reply.status <= 599 ? { httpStatus: reply.status } : {}) };
      // Keep any candidate before validating ownership, URL or other response fields.
      try {
 await saveState(file, saved, false);
} catch {
        this.report('SubscriptionStateWriteFailed');
        throw new Error('SubscriptionCreationUnknown');
      }
      // A failed/ambiguous response may already have created a subscription. Keep pending and never retry blindly.
      if (reply.status !== 200 || !candidateId) {
        if (!candidateId && reply.status === 200) {
          try {
 await saveState(file, { ...saved, reason: 'MissingSubscriptionId' }, false);
} catch {
 this.report('SubscriptionStateWriteFailed');
}
        }
        throw new Error('SubscriptionCreationUnknown');
      }
      const ready: Stored = { version: 1, hubId: saved.hubId, locationIds: saved.locationIds,
        name: saved.name, stage: 'ready', subscriptionId: candidateId,
        lastRotationAt: Date.now() };
      try {
 this.verifyOwnership(reply.data, ready);
} catch {
        try {
 await saveState(file, { ...saved, reason: 'OwnershipMismatch' }, false);
} catch {
 this.report('SubscriptionStateWriteFailed');
}
        throw new Error('SubscriptionCreationUnknown');
      }
      try {
        const registration = registrationPath(reply.data.registrationUrl, originOf(c));
        await saveState(file, ready, false);
        return registration;
      } catch {
        try {
 await saveState(file, { ...saved, reason: 'InvalidRegistrationOrStateWrite' }, false);
} catch {
 this.report('SubscriptionStateWriteFailed');
}
        // The server may have created a subscription even though its response
        // cannot be used. Retain the ID and pending marker for manual recovery.
        throw new Error('SubscriptionCreationUnknown');
      }
    } catch (error: unknown) {
      if (error instanceof RequestNotSentError) {
        throw error;
      }
      throw new Error('SubscriptionCreationUnknown');
    } finally {
      this.creating = false;
    }
  }

  private async receive(session: ClientHttp2Session, c: Credential, endpoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let connected = false;
      let checkRunning = false;
      const req = session.request({
        ':method': 'GET', ':path': endpoint, authorization: `Bearer ${c.access_token}`,
        'x-hub-identifier': c.hubId, accept: 'text/event-stream',
      });
      this.stream = req;
      const expiry = tokenExpiry(c);
      const hash = idHash(c);
      const finish = (error?: Error) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timeout);
        clearInterval(interval);
        if (connected) {
          try {
            this.options.onDisconnected();
          } catch { /* Ignore callback failures. */ }
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = setTimeout(() => finish(new Error('StreamTimeout')), TIMEOUT);
      const interval = setInterval(async () => {
        if (checkRunning || finished) {
          return;
        }
        checkRunning = true;
        try {
          const next = await this.credentials();
          if (idHash(next) !== hash || next.hubId !== c.hubId || next.hubHost !== c.hubHost || next.hubPort !== c.hubPort ||
            (expiry !== undefined && Date.now() >= expiry)) {
            session.destroy();
          }
        } catch {
          session.destroy();
        } finally {
          checkRunning = false;
        }
      }, CHECK_CREDENTIALS_MS);
      interval.unref();
      const parser = new SseParser(message => {
        const event = validateEvent(message, this.locations);
        if (event) {
          try {
            this.options.onDeviceEvent(event);
          } catch {
            this.report('EventCallbackFailed');
          }
        }
      });
      req.on('response', h => {
        if (Number(h[':status']) !== 200 || !String(h['content-type'] || '').toLowerCase().startsWith('text/event-stream')) {
          finish(new Error('StreamRejected'));
          return;
        }
        clearTimeout(timeout);
        connected = true;
        try {
          this.options.onConnected();
        } catch {
          this.report('ConnectedCallbackFailed');
        }
      });
      req.on('data', (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch {
          finish(new Error('InvalidEventStream'));
        }
      });
      req.on('error', () => finish(new Error('StreamFailed')));
      req.on('aborted', () => finish(new Error('StreamFailed')));
      req.on('end', () => finish());
      req.on('close', () => finish());
      req.end();
    });
  }

  private async loop(): Promise<void> {
    let failures = 0;
    let closedSessionRetries = 0;
    while (!this.stopped) {
      let connected = false;
      let retryClosedSession = false;
      let stage: EventStage = 'credentials';
      try {
        this.reconnectRequested = false;
        const c = await this.credentials();
        if (this.stopped) {
          break;
        }
        if (this.reconnectRequested) {
          continue;
        }
        const expiry = tokenExpiry(c);
        if (expiry !== undefined && expiry <= Date.now()) {
          throw new Error('HubTokenExpired');
        }
        stage = 'subscription';
        const release = await this.acquireStateLock();
        let streamResult: Promise<void> | undefined;
        try {
          if (this.stopped || this.reconnectRequested) {
            continue;
          }
          stage = 'connection';
          const session = await this.connect(c);
          if (this.stopped || this.reconnectRequested) {
            continue;
          }
          stage = 'subscription';
          const endpoint = await this.subscription(session, c);
          if (this.stopped || this.reconnectRequested) {
            continue;
          }
          connected = true;
          stage = 'stream';
          // Open the stream before releasing the lock so the hub has an active
          // request rather than an idle session while the lock helper exits.
          streamResult = this.receive(session, c, endpoint);
          void streamResult.catch(() => {});
        } finally {
          await release();
        }
        await streamResult;
        closedSessionRetries = 0;
        failures = 0;
      } catch (error: unknown) {
        const code = safeError(stage, error);
        const systemCode = (error as { code?: unknown } | null)?.code;
        retryClosedSession = ['ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_STREAM'].includes(
          typeof systemCode === 'string' ? systemCode : '',
        ) && closedSessionRetries < 2;
        if (retryClosedSession) {
          closedSessionRetries++;
        } else {
          closedSessionRetries = 0;
        }
        if (!this.stopped && !this.reconnectRequested && !retryClosedSession) {
          this.report(code);
        }
        if (['SubscriptionCreationUnknown', 'SubscriptionMismatch', 'SubscriptionStateInvalid',
          'ExternalSubscriptionMissing'].includes(code)) {
          break;
        }
        failures++;
      } finally {
        this.stream?.close();
        this.stream = undefined;
        this.session?.destroy();
        this.session = undefined;
      }
      if (this.stopped) {
        break;
      }
      if (this.reconnectRequested) {
        continue;
      }
      const wait = retryClosedSession ? 250 * closedSessionRetries : Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
      await new Promise<void>(resolve => {
        this.wake = () => {
          clearTimeout(timer); this.wake = undefined; resolve();
        };
        const timer = setTimeout(this.wake, Math.round(wait * (0.8 + Math.random() * 0.4)));
        timer.unref();
      });
      // 'connected' means a stream was opened; a brief disconnect still backs off.
      if (connected) {
        failures = Math.max(failures, 1);
      }
    }
    this.stopped = true;
  }

  /** Explicitly remove only the subscription whose stored name, ID and filter still match. */
  async removeSubscription(): Promise<void> {
    if (!this.stopped || this.done) {
      throw new Error('StopBeforeRemovingSubscription');
    }
    const release = await this.acquireStateLock();
    try {
      const c = await this.credentials();
      const saved = await this.readState(c);
      if (!saved) {
        return;
      }
      if (saved.ownership === 'external') {
        throw new Error('ExternalSubscriptionReadOnly');
      }
      if (!saved.subscriptionId) {
        throw new Error('SubscriptionCreationUnknown');
      }
      const session = await this.connect(c);
      try {
        const current = await this.json(session, c, 'GET', `/subscriptions/${saved.subscriptionId}`);
        if (current.status !== 404) {
          if (current.status !== 200) {
            throw new Error('SubscriptionLookupFailed');
          }
          this.verifyOwnership(current.data, saved);
          const deleted = await this.json(session, c, 'DELETE', `/subscriptions/${saved.subscriptionId}`);
          if (deleted.status !== 404 && (deleted.status < 200 || deleted.status >= 300)) {
            throw new Error('SubscriptionDeleteFailed');
          }
        }
        await fs.unlink(this.options.subscriptionFile);
        await directorySync(path.dirname(this.options.subscriptionFile));
      } finally {
        session.destroy();
        this.session = undefined;
      }
    } finally {
      await release();
    }
  }
}
