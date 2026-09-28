import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { AgentSessionCapabilities } from '../types.js';
import type { AgentSession, InternalAgentSessionOptions } from './types.js';

import { getAgentConfig } from '../../shared/agentConfigs.js';
import { buildContextReadPrompt, writeContextFile } from '../../shared/contextFiles.js';
import { createIdleWatchdog } from '../../shared/idleWatchdog.js';
import { resolveBinaryPath } from '../../shared/resolveBinary.js';
import { terminateProcessWithGrace } from './processTermination.js';
import {
  createChildProcessOutcomeTracker,
  estimateTokens,
  NO_DEPRECATION_FLAG,
  sessionHelpers,
  SessionIdleTimeoutError,
  SessionMaxTurnTimeoutError,
} from './types.js';

export class CliAgentSession extends EventEmitter implements AgentSession {
  readonly process: ChildProcessWithoutNullStreams;
  private buffer = '';
  private disposed = false;
  private lastInput = '';
  private readonly logPath: null | string;
  private readonly logPrefix: string;
  private pending: null | {
    reject: (reason?: unknown) => void;
    resolve: (value: string) => void;
    settle: (fn: () => void) => void;
    watchdog: ReturnType<typeof createIdleWatchdog>;
  } = null;
  private readonly processOutcome = createChildProcessOutcomeTracker();
  private readonly sessionId: string | undefined;

  constructor(private readonly options: InternalAgentSessionOptions) {
    super();
    this.sessionId = this.options.sessionId;
    this.logPrefix = this.options.outputPrefix ?? this.options.agent;
    const env = this.buildEnv();
    const agentBinary = resolveBinaryPath(this.options.agent, env);

    this.process = spawn(agentBinary, this.buildArgs(), {
      cwd: this.options.projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.logPath = sessionHelpers.prepareTranscriptPath(this.options);

    this.process.stdin.setDefaultEncoding('utf8');
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');

    // Handle stdin errors (e.g., EPIPE when process closes stdin)
    this.process.stdin.on('error', (error: Error) => {
      this.writeLog(`[session] stdin error: ${error.message}`);
      const pending = this.pending;
      if (pending !== null) {
        pending.settle(() => {
          pending.reject(error);
        });
      }
    });

    this.process.stdout.on('data', (chunk: string) => {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      this.processOutcome.recordActivity({ bytes, source: 'stdout' });
      this.options.onActivity?.({
        bytes,
        source: 'stdout',
      });
      this.handleData(chunk);
    });

    this.process.stderr.on('data', (chunk: string) => {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      this.processOutcome.recordActivity({ bytes, source: 'stderr' });
      this.options.onActivity?.({
        bytes,
        source: 'stderr',
      });
      this.handleData(chunk);
    });

    this.process.once('exit', (code, signal) => {
      this.disposed = true;
      const pending = this.pending;
      if (pending !== null) {
        pending.settle(() => {
          pending.reject(
            new Error(
              `${this.options.agent} session exited before completing the response (code=${String(
                code,
              )}, signal=${String(signal)}).`,
            ),
          );
        });
      }
      this.emit('exit', code, signal);
    });
    this.process.once('close', (code, signal) => {
      this.options.onProcessOutcome?.(this.processOutcome.complete({ exitCode: code, signal }));
    });

    this.writeLog(
      `[session] spawned ${this.options.agent} (pid ${this.process.pid !== undefined ? String(this.process.pid) : 'unknown'})`,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.writeLog('[session] disposing');
    await new Promise<void>(resolve => {
      this.process.once('exit', () => {
        resolve();
      });
      this.process.kill();
      // Fallback timeout in case kill fails silently.
      setTimeout(() => {
        resolve();
      }, 2_000);
    });
  }

  getCapabilities(): AgentSessionCapabilities {
    return { fork: false, interrupt: false, queue: false, resume: false };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  interrupt(): Promise<void> {
    return Promise.reject(new Error('This CLI session does not support interrupting an active turn.'));
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  onExit(listener: (code: null | number, signal: NodeJS.Signals | null) => void): void {
    this.on('exit', listener);
  }

  send(input: string): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error('Cannot send message: agent session already disposed.'));
    }
    if (this.pending !== null) {
      return Promise.reject(new Error('Cannot send message: previous request still in progress.'));
    }

    const trimmed = input.trim();
    this.lastInput = trimmed;
    this.writeLog(`\n[automation] >>>\n${trimmed}\n[automation] <<<`);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const idleTimeoutMs = this.options.idleTimeoutMs;
      const maxTurnMs = this.options.maxTurnMs;
      let maxTurnHandle: NodeJS.Timeout | undefined;
      const clearMaxTurnTimer = (): void => {
        if (maxTurnHandle !== undefined) {
          clearTimeout(maxTurnHandle);
          maxTurnHandle = undefined;
        }
      };
      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        watchdog.clear();
        clearMaxTurnTimer();
        if (this.pending?.settle === settle) {
          this.pending = null;
        }
        fn();
      };
      const watchdog = createIdleWatchdog({
        idleTimeoutMs,
        onIdle: () => {
          void terminateProcessWithGrace(this.process);
          settle(() => {
            reject(new SessionIdleTimeoutError(idleTimeoutMs ?? 0));
          });
        },
      });

      this.pending = { reject, resolve, settle, watchdog };
      watchdog.reset();
      if (maxTurnMs !== undefined && maxTurnMs > 0) {
        maxTurnHandle = setTimeout(() => {
          void terminateProcessWithGrace(this.process);
          settle(() => {
            reject(new SessionMaxTurnTimeoutError(maxTurnMs));
          });
        }, maxTurnMs);
        maxTurnHandle.unref();
      }

      try {
        // Plain text format for all agents in CliAgentSession
        this.process.stdin.write(`${trimmed}\n\n`);
      } catch (error) {
        settle(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
    });
  }

  suspend(): Promise<void> {
    return this.dispose();
  }

  private buildArgs(): string[] {
    // Generic CLI agent session - no special args needed
    return [];
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = sessionHelpers.buildProcessEnv(this.options);

    const nodeOptions = env.NODE_OPTIONS ?? '';
    if (!nodeOptions.includes(NO_DEPRECATION_FLAG)) {
      env.NODE_OPTIONS = `${nodeOptions} ${NO_DEPRECATION_FLAG}`.trim();
    }

    const { promptPath } = writeContextFile({
      fileName: `${this.options.agent}-context.txt`,
      projectRoot: this.options.projectRoot,
      prompt: this.options.contextPrompt,
    });
    const initialPrompt = buildContextReadPrompt(promptPath);

    const { initialMessageEnvVar } = getAgentConfig(this.options.agent);
    if (initialMessageEnvVar !== undefined) {
      env[initialMessageEnvVar] = initialPrompt;
    }

    env.PR_READY_DEFAULT ??= 'true';

    return env;
  }

  private handleData(chunk: string): void {
    this.writeLog(chunk);
    this.pending?.watchdog.reset();
    this.buffer += chunk;

    const sentinelIndex = this.buffer.indexOf(this.options.responseSentinel);
    if (sentinelIndex === -1) {
      return;
    }

    const response = this.buffer.slice(0, sentinelIndex).trimEnd();
    this.buffer = this.buffer.slice(sentinelIndex + this.options.responseSentinel.length);

    const pending = this.pending;
    if (pending === null) {
      return;
    }
    if (this.options.onTokenUsage !== undefined) {
      this.options.onTokenUsage({
        inputTokens: estimateTokens(this.lastInput),
        model: this.options.agent,
        outputTokens: estimateTokens(response),
      });
    }

    pending.settle(() => {
      pending.resolve(response);
    });
  }

  private writeLog(message: string): void {
    sessionHelpers.writeLogMessage({
      logger: this.options.logger,
      logPath: this.logPath,
      message,
      prefix: this.logPrefix,
    });
  }
}
