import { spawn } from 'node:child_process';
import path from 'node:path';

export interface RenewalResult {
  status: 'not_due' | 'renewed' | 'busy' | 'hub_validation_failed' | 'failed';
  code?: string;
  hubExpiresAt?: string;
  reauthRequired?: boolean;
}

/** Runs the credential worker under its cross-process OS lock. */
export class HubTokenManager {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<RenewalResult> | undefined;
  private stopped = true;
  private failures = 0;

  constructor(private readonly tokenFile: string) {}

  runOnce(): Promise<RenewalResult> {
    if (this.running) {
      return this.running;
    }
    this.running = this.runWorker().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  start(onResult: (result: RenewalResult) => void): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    const run = async () => {
      const result = await this.runOnce();
      if (this.stopped) {
        return;
      }
      onResult(result);
      if (['RefreshOutcomeUnknown', 'SamsungRotationSaveFailed', 'RefreshTokenExpired'].includes(result.code ?? '') ||
        result.reauthRequired) {
        // Intervention is required; restarting without resolving the pending
        // state cannot cause another potentially destructive refresh.
        this.stopped = true;
        return;
      }
      this.failures = result.status === 'failed' || result.status === 'hub_validation_failed' ? this.failures + 1 : 0;
      const delay = this.failures ? Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(this.failures - 1, 6)) : 60 * 60 * 1000;
      this.timer = setTimeout(run, Math.round(delay * (0.9 + Math.random() * 0.2)));
      this.timer.unref();
    };
    void run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private runWorker(): Promise<RenewalResult> {
    if (!path.isAbsolute(this.tokenFile)) {
      return Promise.resolve({ status: 'failed', code: 'InvalidTokenFilePath' });
    }
    const worker = path.resolve(__dirname, '../lib/hub-token.mjs');
    return new Promise(resolve => {
      let complete = false;
      let output = '';
      const child = spawn(process.execPath, [worker, 'run', this.tokenFile], { stdio: ['ignore', 'pipe', 'ignore'] });
      const finish = (result: RenewalResult) => {
        if (complete) {
          return;
        }
        complete = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ status: 'failed', code: 'WorkerTimedOut' });
      }, 120000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 4096) {
          child.kill();
          finish({ status: 'failed', code: 'InvalidWorkerOutput' });
        }
      });
      child.on('error', () => finish({ status: 'failed', code: 'WorkerStartFailed' }));
      child.on('close', () => {
        try {
          const parsed = JSON.parse(output);
          const allowed = ['not_due', 'renewed', 'busy', 'hub_validation_failed', 'failed'];
          if (!parsed || !allowed.includes(parsed.status)) {
            throw new Error();
          }
          const result: RenewalResult = { status: parsed.status };
          if (typeof parsed.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(parsed.code)) {
            result.code = parsed.code;
          }
          if (typeof parsed.hubExpiresAt === 'string' && !Number.isNaN(Date.parse(parsed.hubExpiresAt))) {
            result.hubExpiresAt = parsed.hubExpiresAt;
          }
          if (parsed.reauthRequired === true) {
            result.reauthRequired = true;
          }
          finish(result);
        } catch {
          finish({ status: 'failed', code: 'InvalidWorkerOutput' });
        }
      });
    });
  }
}
