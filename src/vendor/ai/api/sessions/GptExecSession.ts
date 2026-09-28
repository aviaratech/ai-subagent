import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { GptJsonEvent } from '../../shared/jsonEvents.js';
import type { AgentSessionCapabilities } from '../types.js';
import type { AgentSession, InternalAgentSessionOptions } from './types.js';

import { AGENT_MODEL_GPT } from '../../shared/agentConstants.js';
import { shouldBypassAutomation } from '../../shared/autonomyPolicy.js';
import { buildContextReadPrompt, writeContextFile } from '../../shared/contextFiles.js';
import { createIdleWatchdog } from '../../shared/idleWatchdog.js';
import { extractGptAgentMessages, extractGptSessionId, extractGptTokenUsage } from '../../shared/jsonEvents.js';
import { resolveBinaryPath } from '../../shared/resolveBinary.js';
import { MODEL_TRANSPORTS } from '../../shared/modelPolicy.js';
import { resolveGptLaunchBinary } from '../../targets/constants.js';
import { terminateProcessWithGrace } from './processTermination.js';
import {
  createChildProcessOutcomeTracker,
  estimateTokens,
  NO_DEPRECATION_FLAG,
  sessionHelpers,
  SessionIdleTimeoutError,
  SessionMaxTurnTimeoutError,
  SessionProtocolError,
} from './types.js';

const REPLACE_ENV_SHELL_INCLUDE_ONLY = [
  'COLORTERM',
  'COLUMNS',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LINES',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
] as const;

/**
 * GPT agent session using exec mode with resume for persistent context.
 * Each send() spawns a new `codex exec` or `codex exec resume` process.
 */
export class GptExecSession extends EventEmitter implements AgentSession {
  private activeProcess: ChildProcess | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly logPath: null | string;
  private sessionId: null | string = null;

  constructor(private readonly options: InternalAgentSessionOptions) {
    super();
    if (typeof this.options.sessionId === 'string') {
      this.sessionId = this.options.sessionId;
    }
    this.logPath = sessionHelpers.prepareTranscriptPath(this.options);
    this.writeLog('[session] initialized gpt exec session');
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.writeLog('[session] disposing gpt exec session');
    this.disposePromise = this.terminateActiveProcess().finally(() => {
      this.emit('exit', 0, null);
    });
    return this.disposePromise;
  }

  getCapabilities(): AgentSessionCapabilities {
    const transport = MODEL_TRANSPORTS['codex-cli'];
    return {
      fork: transport.fork,
      interrupt: transport.interrupt,
      queue: transport.queue,
      resume: transport.resume,
    };
  }

  getSessionId(): string | undefined {
    return this.sessionId ?? undefined;
  }

  interrupt(): Promise<void> {
    return this.terminateActiveProcess();
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  onExit(listener: (code: null | number, signal: NodeJS.Signals | null) => void): void {
    this.on('exit', listener);
  }

  send(input: string): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error('Cannot send message: gpt exec session already disposed.'));
    }

    const trimmed = input.trim();
    this.writeLog(`\n[automation] >>>\n${trimmed}\n[automation] <<<`);

    const env = this.buildEnv();
    const modelSelection = sessionHelpers.resolveModelSelection({
      agent: this.options.agent,
      ...(this.options.modelId !== undefined ? { modelId: this.options.modelId } : {}),
      ...(this.options.requestedModelId !== undefined ? { requestedModelId: this.options.requestedModelId } : {}),
    });
    const args = this.buildArgs(env);
    return new Promise<string>((resolve, reject) => {
      const gptLaunchBinary = resolveGptLaunchBinary({
        env,
        projectRoot: this.options.projectRoot,
        ...(this.options.runtimeMode !== undefined ? { runtimeMode: this.options.runtimeMode } : {}),
      });
      const gptBinary = resolveBinaryPath(gptLaunchBinary, env);
      const proc = spawn(gptBinary, args, {
        cwd: this.options.projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.activeProcess = proc;
      const processOutcome = createChildProcessOutcomeTracker();

      // Single-settle guard: ensures idle/exit/error can each race but only one
      // wins. settle() calls watchdog.clear(); onIdle() calls settle() — both
      // reference watchdog/settle by closure (they are only invoked at runtime,
      // after all declarations are complete).
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
        fn();
      };
      const watchdog = createIdleWatchdog({
        idleTimeoutMs,
        onIdle: () => {
          void terminateProcessWithGrace(proc);
          settle(() => {
            // onIdle only fires when the watchdog is active, which requires
            // idleTimeoutMs > 0 (createIdleWatchdog is a no-op otherwise), so
            // the ?? 0 fallback is unreachable — kept only to satisfy the type.
            reject(new SessionIdleTimeoutError(idleTimeoutMs ?? 0));
          });
        },
      });
      // Start the idle countdown immediately so a child that never emits
      // anything is caught, not just one that goes silent after emitting.
      watchdog.reset();
      if (maxTurnMs !== undefined && maxTurnMs > 0) {
        maxTurnHandle = setTimeout(() => {
          void terminateProcessWithGrace(proc);
          settle(() => {
            reject(new SessionMaxTurnTimeoutError(maxTurnMs));
          });
        }, maxTurnMs);
        maxTurnHandle.unref();
      }

      let stdoutBuffer = '';
      let stderrBuffer = '';
      const jsonEvents: GptJsonEvent[] = [];
      let malformedJson = false;

      const parseJsonLine = (line: string): void => {
        if (line.trim().length === 0) {
          return;
        }
        try {
          const event: unknown = JSON.parse(line);
          if (typeof event !== 'object' || event === null || typeof (event as { type?: unknown }).type !== 'string') {
            malformedJson = true;
            return;
          }
          jsonEvents.push(event as GptJsonEvent);
        } catch {
          malformedJson = true;
        }
      };

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');

      proc.stdout.on('data', (chunk: string) => {
        const bytes = Buffer.byteLength(chunk, 'utf8');
        processOutcome.recordActivity({ bytes, source: 'stdout' });
        this.options.onActivity?.({
          bytes,
          source: 'stdout',
        });
        watchdog.reset();
        this.writeLog(chunk);

        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          parseJsonLine(line);
        }
      });

      proc.stderr.on('data', (chunk: string) => {
        const bytes = Buffer.byteLength(chunk, 'utf8');
        processOutcome.recordActivity({ bytes, source: 'stderr' });
        this.options.onActivity?.({
          bytes,
          source: 'stderr',
        });
        watchdog.reset();
        stderrBuffer += chunk;
        this.writeLog(chunk);
      });

      proc.once('close', (code, signal) => {
        this.options.onProcessOutcome?.(processOutcome.complete({ exitCode: code, signal }));
        if (this.activeProcess === proc) {
          this.activeProcess = undefined;
        }
        if (code !== 0) {
          settle(() => {
            reject(new Error(formatGptExecFailure({ code, events: jsonEvents, stderr: stderrBuffer })));
          });
          return;
        }
        parseJsonLine(stdoutBuffer);
        if (malformedJson) {
          settle(() => {
            reject(new SessionProtocolError('gpt_malformed_output', 'Codex emitted a non-JSON or malformed event.'));
          });
          return;
        }
        if (!jsonEvents.some(event => event.type === 'turn.completed' || event.type === 'response.completed')) {
          settle(() => {
            reject(
              new SessionProtocolError('gpt_terminal_event_missing', 'Codex exited without a completed turn event.'),
            );
          });
          return;
        }

        let actualInputTokens: number | undefined;
        let actualOutputTokens: number | undefined;
        let providerTokenUsage: NonNullable<ReturnType<typeof extractGptTokenUsage>>['provider'] | undefined;

        if (this.sessionId === null) {
          const extractedSessionId = extractGptSessionId(jsonEvents);
          if (extractedSessionId !== undefined) {
            this.sessionId = extractedSessionId;
            this.writeLog(`[session] captured session ID: ${this.sessionId}`);
          }
        }
        const agentMessages = extractGptAgentMessages(jsonEvents);
        const tokenUsage = extractGptTokenUsage(jsonEvents);
        if (tokenUsage !== undefined) {
          actualInputTokens = tokenUsage.input;
          actualOutputTokens = tokenUsage.output;
          providerTokenUsage = tokenUsage.provider;
        }
        const response = agentMessages.join('\n');

        this.writeLog(`\n[gpt response]\n${response}\n[/gpt response]`);

        if (this.options.onTokenUsage !== undefined) {
          this.options.onTokenUsage({
            ...(modelSelection !== undefined ? { attributionSource: 'exact-launch-contract' as const } : {}),
            inputTokens: actualInputTokens ?? estimateTokens(trimmed),
            model: AGENT_MODEL_GPT,
            outputTokens: actualOutputTokens ?? estimateTokens(response),
            ...(providerTokenUsage !== undefined ? { provider: providerTokenUsage } : {}),
            ...(modelSelection !== undefined
              ? {
                  providerId: modelSelection.providerId,
                  ...(this.options.reasoning !== undefined ? { reasoningEffort: this.options.reasoning } : {}),
                  requestedModelId: modelSelection.requestedModelId,
                  resolvedModelId: modelSelection.resolvedModelId,
                }
              : {}),
          });
        }

        settle(() => {
          resolve(response);
        });
      });

      proc.once('error', error => {
        if (this.activeProcess === proc) {
          this.activeProcess = undefined;
        }
        settle(() => {
          reject(error);
        });
      });

      proc.stdin.write(`${trimmed}\n`);
      proc.stdin.end();
    });
  }

  suspend(): Promise<void> {
    return this.dispose();
  }

  private buildArgs(env: NodeJS.ProcessEnv): string[] {
    const modelArgs = sessionHelpers.resolveModelArgs({
      agent: this.options.agent,
      ...(this.options.modelId !== undefined ? { modelId: this.options.modelId } : {}),
      ...(this.options.requestedModelId !== undefined ? { requestedModelId: this.options.requestedModelId } : {}),
    });
    const isResume = this.sessionId !== null;
    const safetyArgs = this.buildSafetyArgs(env, { mode: isResume ? 'resume' : 'exec' });
    const shellEnvironmentArgs = this.buildShellEnvironmentArgs();
    const reasoningArgs = this.buildReasoningArgs();
    if (this.sessionId === null) {
      const args = ['exec', '--json', ...safetyArgs];
      args.push(...modelArgs, ...shellEnvironmentArgs);
      args.push(...reasoningArgs);

      args.push('--cd', this.options.projectRoot, '-');
      return args;
    }

    return [
      'exec',
      'resume',
      '--json',
      ...safetyArgs,
      ...modelArgs,
      ...shellEnvironmentArgs,
      ...reasoningArgs,
      this.sessionId,
      '-',
    ];
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = sessionHelpers.buildProcessEnv(this.options);

    const nodeOptions = env.NODE_OPTIONS ?? '';
    if (!nodeOptions.includes(NO_DEPRECATION_FLAG)) {
      env.NODE_OPTIONS = `${nodeOptions} ${NO_DEPRECATION_FLAG}`.trim();
    }

    const { promptPath } = writeContextFile({
      fileName: 'gpt-context.txt',
      projectRoot: this.options.projectRoot,
      prompt: this.options.contextPrompt,
    });

    env.CODEX_INITIAL_MESSAGE = buildContextReadPrompt(promptPath);
    env.PR_READY_DEFAULT ??= 'true';
    env.AI_AGENT_IDENTITY ??= AGENT_MODEL_GPT;
    if (this.options.behavior?.sandbox === 'read-only') {
      env.GIT_OPTIONAL_LOCKS = '0';
    }

    return env;
  }

  private buildReasoningArgs(): string[] {
    if (typeof this.options.reasoning !== 'string' || this.options.reasoning.length === 0) {
      return [];
    }

    return ['-c', `model_reasoning_effort=${this.options.reasoning}`];
  }

  private buildSafetyArgs(env: NodeJS.ProcessEnv, options: { mode: 'exec' | 'resume' }): string[] {
    const args: string[] = [];
    const sandbox = this.options.behavior?.sandbox;
    if (sandbox === 'read-only' || sandbox === 'workspace-write') {
      if (options.mode === 'resume') {
        args.push('-c', `sandbox_mode=${JSON.stringify(sandbox)}`);
      } else {
        args.push('--sandbox', sandbox);
      }
    }
    if (
      shouldBypassAutomation({
        ...(this.options.behavior !== undefined ? { behavior: this.options.behavior } : {}),
        env,
      })
    ) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    return args;
  }

  private buildShellEnvironmentArgs(): string[] {
    if (this.options.envMode === 'replace') {
      return ['-c', `shell_environment_policy.include_only=${JSON.stringify(REPLACE_ENV_SHELL_INCLUDE_ONLY)}`];
    }

    if (this.sessionId === null) {
      return ['-c', 'shell_environment_policy.inherit=all'];
    }

    return [];
  }

  private terminateActiveProcess(): Promise<void> {
    const proc = this.activeProcess;
    if (proc === undefined) {
      return Promise.resolve();
    }
    this.activeProcess = undefined;
    return terminateProcessWithGrace(proc);
  }

  private writeLog(message: string): void {
    sessionHelpers.writeLogMessage({
      logger: this.options.logger,
      logPath: this.logPath,
      message,
      prefix: this.options.outputPrefix ?? this.options.agent,
    });
  }
}

function classifyGptFailure(input: string): 'authentication' | 'capacity' | 'launch' | 'model' | 'network' {
  if (/auth|api.?key|unauthori[sz]ed|\b401\b/u.test(input)) {
    return 'authentication';
  }
  if (/capacity|quota|rate.?limit|too.?many.?requests|\b429\b/u.test(input)) {
    return 'capacity';
  }
  if (/model|not.?found|unsupported|\b404\b/u.test(input)) {
    return 'model';
  }
  if (/network|connect|dns|timeout|unavailable|\b5\d\d\b/u.test(input)) {
    return 'network';
  }
  return 'launch';
}

function formatGptExecFailure(input: { code: null | number; events: GptJsonEvent[]; stderr: string }): string {
  const failureEvent = [...input.events]
    .reverse()
    .find(event => event.type.toLowerCase().includes('failed') || event.type.toLowerCase().includes('error'));
  const eventRecord = failureEvent as Record<string, unknown> | undefined;
  const nestedError =
    typeof eventRecord?.error === 'object' && eventRecord.error !== null
      ? (eventRecord.error as Record<string, unknown>)
      : undefined;
  const providerCode = sanitizedFailureAtom(eventRecord?.code) ?? sanitizedFailureAtom(nestedError?.code) ?? 'none';
  const eventType = sanitizedFailureAtom(failureEvent?.type) ?? 'none';
  const classificationInput = [
    input.stderr,
    failureEvent?.type,
    providerCode,
    typeof eventRecord?.error === 'string' ? eventRecord.error : undefined,
    typeof eventRecord?.message === 'string' ? eventRecord.message : undefined,
    typeof nestedError?.message === 'string' ? nestedError.message : undefined,
    typeof nestedError?.type === 'string' ? nestedError.type : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase();
  const category = classifyGptFailure(classificationInput);
  return `gpt exec exited with code ${String(input.code)}: category=${category} event=${eventType} provider_code=${providerCode}.`;
}

function sanitizedFailureAtom(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(trimmed) ? trimmed : undefined;
}
