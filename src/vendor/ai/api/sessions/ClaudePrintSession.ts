import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ClaudeJsonEvent } from '../../shared/jsonEvents.js';
import type { AgentSessionCapabilities } from '../types.js';
import type { AgentSession, InternalAgentSessionOptions } from './types.js';

import { AGENT_MODEL_CLAUDE } from '../../shared/agentConstants.js';
import { shouldBypassAutomation } from '../../shared/autonomyPolicy.js';
import { buildContextReadPrompt, writeContextFile } from '../../shared/contextFiles.js';
import { createIdleWatchdog } from '../../shared/idleWatchdog.js';
import { MODEL_TRANSPORTS, resolveModelReasoningEffort } from '../../shared/modelPolicy.js';
import {
  extractClaudeModelIds,
  extractClaudePrimaryModelIds,
  extractClaudeSessionId,
  extractClaudeTextParts,
  extractClaudeTokenUsage,
} from '../../shared/jsonEvents.js';
import { resolveBinaryPath } from '../../shared/resolveBinary.js';
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

const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'] as const;
const CLAUDE_BUILDER_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;
const CLAUDE_READ_ONLY_ALLOW_RULES = [
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git rev-parse *)',
] as const;
const CLAUDE_BUILDER_ALLOW_RULES = [
  ...CLAUDE_READ_ONLY_ALLOW_RULES,
  'Bash(node --test *)',
  'Bash(pnpm test *)',
  'Bash(pnpm run test *)',
  'Bash(pnpm run checks *)',
  'Bash(pnpm run build *)',
  'Bash(pnpm run typecheck *)',
  'Bash(pnpm run lint *)',
  'Bash(pnpm run format *)',
  'Bash(pnpm --filter * test *)',
  'Bash(pnpm --filter * build *)',
  'Bash(pnpm --filter * typecheck *)',
] as const;

/**
 * Claude session using --print mode for each message (no persistent session support yet).
 * Similar to GptExecSession but spawns `claude --print` for each send().
 */
export class ClaudePrintSession extends EventEmitter implements AgentSession {
  private activeProcess: ChildProcess | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly logPath: null | string;
  private sessionId: string | undefined;

  constructor(private readonly options: InternalAgentSessionOptions) {
    super();
    this.sessionId = this.options.sessionId;
    this.logPath = sessionHelpers.prepareTranscriptPath(this.options);
    this.writeLog('[session] initialized claude print session');
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.writeLog('[session] disposing claude print session');
    this.disposePromise = this.terminateActiveProcess().finally(() => {
      this.emit('exit', 0, null);
    });
    return this.disposePromise;
  }

  getCapabilities(): AgentSessionCapabilities {
    const transport = MODEL_TRANSPORTS['claude-code'];
    return {
      fork: transport.fork,
      interrupt: transport.interrupt,
      queue: transport.queue,
      resume: transport.resume,
    };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
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
      return Promise.reject(new Error('Cannot send message: claude print session already disposed.'));
    }

    const trimmed = input.trim();
    this.writeLog(`\n[automation] >>>\n${trimmed}\n[automation] <<<`);

    const env = this.buildEnv();
    const contextReadInstruction = env.CLAUDE_INITIAL_MESSAGE?.trim();
    const turnInput =
      contextReadInstruction === undefined || contextReadInstruction.length === 0
        ? trimmed
        : `${contextReadInstruction}\n\n${trimmed}`;
    const modelSelection = sessionHelpers.resolveModelSelection({
      agent: this.options.agent,
      ...(this.options.modelId !== undefined ? { modelId: this.options.modelId } : {}),
      ...(this.options.requestedModelId !== undefined ? { requestedModelId: this.options.requestedModelId } : {}),
    });
    // Use stream-json output with --verbose: emits a rich event stream that acts
    // as the liveness/heartbeat signal (frequent JSONL events while Claude works)
    // and captures provider-reported token usage. Parsing is unchanged — the same
    // parseJsonLines/extractClaudeTextParts/extractClaudeTokenUsage/extractClaudeSessionId
    // helpers that launch.ts uses on stream-json output work here too.
    const args = ['--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose'];
    args.push(...(modelSelection?.args ?? []));
    appendManagedPermissionArgs(args, this.options);
    if (typeof this.options.reasoning === 'string' && this.options.reasoning.length > 0) {
      if (modelSelection !== undefined) {
        resolveModelReasoningEffort(modelSelection.resolvedModelId, this.options.reasoning);
      }
      args.push('--effort', this.options.reasoning);
    }
    if (this.sessionId !== undefined) {
      args.push('--resume', this.sessionId);
    }
    if (
      shouldBypassAutomation({
        ...(this.options.behavior !== undefined ? { behavior: this.options.behavior } : {}),
        env,
      })
    ) {
      args.push('--dangerously-skip-permissions');
    }
    if (this.options.runtimeMode !== 'host-native' && this.options.strictMcpConfig === true) {
      args.push('--strict-mcp-config');
    }
    if (this.options.runtimeMode !== 'host-native' && this.options.mcpConfig !== undefined) {
      for (const config of this.options.mcpConfig) {
        args.push('--mcp-config', config);
      }
    }

    return new Promise<string>((resolve, reject) => {
      const claudeBinary = resolveBinaryPath(AGENT_MODEL_CLAUDE, env);
      const proc = spawn(claudeBinary, args, {
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
            reject(classifyClaudeFailure({ code, stderr: stderrBuffer, stdout: stdoutBuffer }));
          });
          return;
        }

        const rawOutput = stdoutBuffer.trim();

        // Parse JSON response using shared helpers
        let events: ClaudeJsonEvent[];
        try {
          events = parseClaudeTerminalEvents(rawOutput);
        } catch (error) {
          settle(() => {
            reject(
              error instanceof Error
                ? error
                : new SessionProtocolError('claude_malformed_output', 'Claude output parsing failed.'),
            );
          });
          return;
        }
        const extractedSessionId = extractClaudeSessionId(events);
        if (extractedSessionId !== undefined) {
          this.sessionId = extractedSessionId;
        }
        const textParts = extractClaudeTextParts(events);
        const messageText = textParts.join('');
        const normalizedUsage = extractClaudeTokenUsage(events);
        const usageModelIds = extractClaudeModelIds(events);
        const primaryModelIds = extractClaudePrimaryModelIds(events);
        const providerModelIds = primaryModelIds.length > 0 ? primaryModelIds : usageModelIds;
        const acceptedProviderModelIds =
          modelSelection === undefined
            ? undefined
            : new Set([modelSelection.providerModelId, modelSelection.resolvedModelId]);
        if (
          modelSelection !== undefined &&
          (providerModelIds.length > 1 ||
            (providerModelIds.length === 1 && acceptedProviderModelIds?.has(providerModelIds[0] ?? '') !== true))
        ) {
          settle(() => {
            reject(
              new SessionProtocolError(
                'claude_unexpected_model_attribution',
                'Claude reported a model that did not match the exact launch contract.',
              ),
            );
          });
          return;
        }

        if (messageText.length === 0) {
          settle(() => {
            reject(
              new SessionProtocolError(
                'claude_malformed_output',
                'Claude terminal output did not contain a response body.',
              ),
            );
          });
          return;
        }
        const finalText = messageText;

        this.writeLog(`\n[claude response]\n${finalText}\n[/claude response]`);

        // Report token usage: prefer provider-reported, fall back to estimation
        if (this.options.onTokenUsage !== undefined) {
          this.options.onTokenUsage({
            ...(modelSelection !== undefined
              ? {
                  attributionSource:
                    providerModelIds.length === 1 ? ('provider-event' as const) : ('exact-launch-contract' as const),
                  ...(providerModelIds.length === 1 ? { effectiveModelId: modelSelection.resolvedModelId } : {}),
                }
              : {}),
            inputTokens: normalizedUsage?.input ?? estimateTokens(turnInput),
            model: AGENT_MODEL_CLAUDE,
            outputTokens: normalizedUsage?.output ?? estimateTokens(finalText),
            ...(normalizedUsage?.provider !== undefined ? { provider: normalizedUsage.provider } : {}),
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
          resolve(finalText);
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

      // Write input to stdin
      proc.stdin.write(`${turnInput}\n`);
      proc.stdin.end();
    });
  }

  suspend(): Promise<void> {
    return this.dispose();
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = sessionHelpers.buildProcessEnv(this.options);

    const nodeOptions = env.NODE_OPTIONS ?? '';
    if (!nodeOptions.includes(NO_DEPRECATION_FLAG)) {
      env.NODE_OPTIONS = `${nodeOptions} ${NO_DEPRECATION_FLAG}`.trim();
    }

    const { promptPath } = writeContextFile({
      fileName: 'claude-context.txt',
      projectRoot: this.options.projectRoot,
      prompt: this.options.contextPrompt,
    });

    env.CLAUDE_INITIAL_MESSAGE = buildContextReadPrompt(promptPath);
    env.PR_READY_DEFAULT ??= 'true';
    env.AI_AGENT_IDENTITY ??= AGENT_MODEL_CLAUDE;

    return env;
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
      prefix: this.options.outputPrefix ?? AGENT_MODEL_CLAUDE,
    });
  }
}

function appendManagedPermissionArgs(args: string[], options: InternalAgentSessionOptions): void {
  const sandbox = options.behavior?.sandbox;
  if (options.runtimeMode === 'host-native' || (sandbox !== 'read-only' && sandbox !== 'workspace-write')) {
    return;
  }

  const writable = sandbox === 'workspace-write';
  const tools = writable ? CLAUDE_BUILDER_TOOLS : CLAUDE_READ_ONLY_TOOLS;
  const canonicalProjectRoot = realpathSync(options.projectRoot);
  const projectPattern = claudePermissionAbsolutePath(canonicalProjectRoot);
  const allowRules: string[] = [
    `Read(${projectPattern}/**)`,
    `Glob(${projectPattern}/**)`,
    `Grep(${projectPattern}/**)`,
    ...(writable ? [`Edit(${projectPattern}/**)`, `Write(${projectPattern}/**)`] : []),
    ...(writable ? CLAUDE_BUILDER_ALLOW_RULES : CLAUDE_READ_ONLY_ALLOW_RULES),
  ];
  for (const reference of options.superpowersSkillReferences ?? []) {
    allowRules.push(`Read(${claudePermissionAbsolutePath(reference)})`);
  }

  args.push('--permission-mode', 'dontAsk', '--setting-sources', '');
  args.push('--settings', buildManagedClaudeSettings(options));
  args.push('--tools', tools.join(','));
  args.push('--allowedTools', allowRules.join(','));
  const skillDirectories = [...new Set((options.superpowersSkillReferences ?? []).map(dirname))];
  if (skillDirectories.length > 0) {
    args.push('--add-dir', ...skillDirectories);
  }
}

function buildManagedClaudeSettings(options: InternalAgentSessionOptions): string {
  const canonicalProjectRoot = realpathSync(options.projectRoot);
  const allowedReadPaths = new Set<string>([canonicalProjectRoot]);
  for (const reference of options.superpowersSkillReferences ?? []) {
    allowedReadPaths.add(dirname(reference));
  }
  for (const pathEntry of (options.env?.PATH ?? process.env.PATH ?? '').split(':')) {
    if (pathEntry.startsWith('/')) {
      allowedReadPaths.add(pathEntry);
    }
  }
  return JSON.stringify({
    sandbox: {
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      enabled: true,
      failIfUnavailable: true,
      filesystem: {
        allowRead: [...allowedReadPaths],
        denyRead: ['~/'],
      },
      network: { allowedDomains: [] },
    },
  });
}

function classifyClaudeFailure(input: { code: null | number; stderr: string; stdout: string }): Error {
  if (hasClaudeEventType(input.stdout, 'rate_limit_event')) {
    return new SessionProtocolError(
      'claude_capacity_exhausted',
      'Claude subscription capacity is unavailable. Retry only after capacity returns.',
    );
  }
  return new Error(formatClaudeFailure(input));
}

function claudePermissionAbsolutePath(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error('Managed Claude permission paths must be absolute.');
  }
  return `/${path}`;
}

function formatClaudeFailure(input: { code: null | number; stderr: string }): string {
  const normalized = input.stderr.toLowerCase();
  let category = 'launch';
  if (/auth|login|subscription|unauthori[sz]ed|\b401\b/u.test(normalized)) {
    category = 'authentication';
  } else if (/capacity|quota|rate.?limit|too.?many.?requests|\b429\b/u.test(normalized)) {
    category = 'capacity';
  } else if (/model|not.?found|unsupported|\b404\b/u.test(normalized)) {
    category = 'model';
  } else if (/network|connect|dns|timeout|unavailable|\b5\d\d\b/u.test(normalized)) {
    category = 'network';
  }
  return `claude_print_failed: Claude exited with code ${String(input.code)}; category=${category}.`;
}

function hasClaudeEventType(output: string, expectedType: string): boolean {
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(line);
      if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === expectedType) {
        return true;
      }
    } catch {
      // Unknown non-zero output keeps the compact generic launch classification.
    }
  }
  return false;
}

function parseClaudeTerminalEvents(output: string): ClaudeJsonEvent[] {
  const events: ClaudeJsonEvent[] = [];
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new SessionProtocolError('claude_malformed_output', 'Claude emitted a non-JSON event.');
    }
    if (typeof event !== 'object' || event === null || typeof (event as { type?: unknown }).type !== 'string') {
      throw new SessionProtocolError('claude_malformed_output', 'Claude emitted a malformed event.');
    }
    events.push(event as ClaudeJsonEvent);
  }
  if (!events.some(event => event.type === 'result')) {
    throw new SessionProtocolError('claude_terminal_event_missing', 'Claude exited without a terminal result event.');
  }
  return events;
}
