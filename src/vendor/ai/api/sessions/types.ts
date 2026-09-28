import type { ChildProcess } from 'node:child_process';

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type {
  AgentLaunchBehaviorOptions,
  AgentModel,
  AgentRole,
  AgentSessionActivity,
  AgentSessionProcessOutcome,
  AgentRuntimeMode as ApiAgentRuntimeMode,
  AgentSession as ApiAgentSession,
  AgentSessionEnvMode as ApiAgentSessionEnvMode,
  AgentSessionOptions as ApiAgentSessionOptions,
  TokenUsage as ApiTokenUsage,
  SessionLogger,
} from '../types.js';

import { inferModelFamily } from '../../shared/modelFamily.js';
import { resolveModel } from '../../targets/registry.js';

export type AgentName = AgentModel;

export type AgentRuntimeMode = ApiAgentRuntimeMode;

export type AgentSession = ApiAgentSession;

export type AgentSessionOptions = ApiAgentSessionOptions;

export interface ChildProcessOutcomeTracker {
  complete(input: { exitCode: null | number; signal: NodeJS.Signals | null }): AgentSessionProcessOutcome;
  recordActivity(activity: AgentSessionActivity): void;
}

export interface InternalAgentSessionOptions {
  agent: AgentName;
  /** CLI behavior options for session-backed agent turns. */
  behavior?: AgentLaunchBehaviorOptions;
  contextPrompt: string;
  /** Environment variables passed to the agent process. */
  env?: Record<string, string>;
  /** Controls whether env augments or replaces process.env. */
  envMode?: ApiAgentSessionEnvMode;
  /** Idle budget in ms: send() kills the child + rejects if no stdout/stderr arrives within this window. Disabled when undefined. */
  idleTimeoutMs?: number;
  logger?: SessionLogger;
  /** Absolute wall-clock budget in ms for each send() turn. Disabled when undefined. */
  maxTurnMs?: number;
  /** Paths to MCP config files to pass via --mcp-config flags. */
  mcpConfig?: string[];
  /** Exact registered model ID to use for this session when supported. */
  modelId?: string;
  /** Callback invoked with byte-count-only child-process activity. */
  onActivity?: (activity: AgentSessionActivity) => void;
  /** Callback invoked after a child process closes with sanitized lifecycle evidence. */
  onProcessOutcome?: (outcome: AgentSessionProcessOutcome) => void;
  /** Callback invoked when token usage is available after a response. */
  onTokenUsage?: (usage: TokenUsageInfo) => void;
  /** Prefix applied to stdout/stderr lines when logging. */
  outputPrefix?: string;
  /** Underlying child process, if available (CLI-backed sessions only). */
  process?: ChildProcess;
  /** Directory the agent should treat as its working directory (generally the worktree). */
  projectRoot: string;
  /** Reasoning effort level for models that support it (e.g., GPT via Codex CLI: low, medium, high, xhigh). */
  reasoning?: string;
  /** Caller-supplied model identifier before canonical alias resolution. */
  requestedModelId?: string;
  /** Sentinel string emitted by the agent to signal response completion. */
  responseSentinel: string;
  /** Agent role selected for this session. */
  role?: AgentRole;
  /** Launch runtime mode. */
  runtimeMode?: AgentRuntimeMode;
  /** Session ID for resuming a previous session. */
  sessionId?: string;
  /** When true, passes --strict-mcp-config to the agent CLI. */
  strictMcpConfig?: boolean;
  /** Exact Superpowers SKILL.md files selected by the trusted parent. */
  superpowersSkillReferences?: string[];
  /** Optional label for the transcript log written to .ai/logs. */
  transcriptLabel?: string;
  /** Explicit absolute transcript path prepared by the parent lifecycle. */
  transcriptPath?: string;
}

export interface ResolvedSessionModel {
  args: string[];
  providerId: string;
  providerModelId: string;
  requestedModelId: string;
  resolvedModelId: string;
}

export type TokenUsageInfo = ApiTokenUsage;

/**
 * Thrown by a CLI-backed session's `send()` when the child process produces no
 * stdout/stderr for `idleTimeoutMs` (it is hung). Host-generic — the reviewer
 * maps this to a ReviewerTimeoutError with cancellation_reason=idle_timeout.
 */
export class SessionIdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number) {
    super(`Session send produced no output for ${String(idleTimeoutMs)}ms (idle timeout).`);
    this.name = 'SessionIdleTimeoutError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/**
 * Thrown by a CLI-backed session's `send()` when the child process exceeds the
 * configured wall-clock budget, even if it is still producing output.
 */
export class SessionMaxTurnTimeoutError extends Error {
  readonly maxTurnMs: number;

  constructor(maxTurnMs: number) {
    super(`Session send exceeded max turn duration of ${String(maxTurnMs)}ms.`);
    this.name = 'SessionMaxTurnTimeoutError';
    this.maxTurnMs = maxTurnMs;
  }
}

/** Stable adapter-owned failure for malformed or incomplete CLI protocols. */
export class SessionProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SessionProtocolError';
  }
}

/**
 * Tracks the minimal, safe child lifecycle evidence shared by CLI adapters.
 * A terminal outcome is emitted only from the process `close` event so stdio
 * accounting is complete before a parent makes a health decision.
 */
export function createChildProcessOutcomeTracker(now: () => number = Date.now): ChildProcessOutcomeTracker {
  const startedAtMs = now();
  let firstActivityMs: number | undefined;
  let lastActivityMs: number | undefined;
  let stderrBytes = 0;
  let stdoutBytes = 0;

  return {
    complete(input): AgentSessionProcessOutcome {
      return {
        completionMs: Math.max(0, now() - startedAtMs),
        exitCode: input.exitCode,
        ...(firstActivityMs !== undefined ? { firstActivityMs } : {}),
        ...(lastActivityMs !== undefined ? { lastActivityMs } : {}),
        receivedBytes: stdoutBytes + stderrBytes,
        signal: input.signal,
        stderrBytes,
        stdoutBytes,
      };
    },
    recordActivity(activity): void {
      const activityMs = Math.max(0, now() - startedAtMs);
      firstActivityMs ??= activityMs;
      lastActivityMs = activityMs;
      if (activity.source === 'stdout') {
        stdoutBytes += activity.bytes;
      } else {
        stderrBytes += activity.bytes;
      }
    },
  };
}

export const NO_DEPRECATION_FLAG = '--no-deprecation';

export const sessionHelpers = {
  buildProcessEnv(options: Pick<InternalAgentSessionOptions, 'env' | 'envMode'>): NodeJS.ProcessEnv {
    if (options.envMode === 'replace') {
      return { ...(options.env ?? {}) };
    }

    return {
      ...process.env,
      ...options.env,
    };
  },

  prepareTranscriptPath(
    options: Pick<InternalAgentSessionOptions, 'projectRoot' | 'transcriptLabel' | 'transcriptPath'>,
  ): null | string {
    if (options.transcriptPath !== undefined) {
      if (!isAbsolute(options.transcriptPath) || resolve(options.transcriptPath) !== options.transcriptPath) {
        throw new Error('transcriptPath must be an absolute normalized path.');
      }
      return options.transcriptPath;
    }
    if (typeof options.transcriptLabel !== 'string' || options.transcriptLabel.length === 0) {
      return null;
    }
    const directory = resolve(options.projectRoot, '.ai', 'logs');
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    return resolve(directory, `${options.transcriptLabel}.log`);
  },
  resolveModelArgs(options: Pick<InternalAgentSessionOptions, 'agent' | 'modelId' | 'requestedModelId'>): string[] {
    return this.resolveModelSelection(options)?.args ?? [];
  },
  resolveModelSelection(
    options: Pick<InternalAgentSessionOptions, 'agent' | 'modelId' | 'requestedModelId'>,
  ): ResolvedSessionModel | undefined {
    if (typeof options.modelId !== 'string' || options.modelId.trim().length === 0) {
      return undefined;
    }

    const requestedModelId = options.modelId.trim();
    const resolved = resolveModel(requestedModelId);
    const family = inferModelFamily(resolved.model.id);
    if (family !== options.agent) {
      throw new Error(`Model "${options.modelId}" does not match session agent "${options.agent}".`);
    }
    const trimmedOriginalRequest = options.requestedModelId?.trim();
    const originalRequest =
      trimmedOriginalRequest === undefined || trimmedOriginalRequest.length === 0
        ? requestedModelId
        : trimmedOriginalRequest;
    if (resolveModel(originalRequest).resolvedId !== resolved.resolvedId) {
      throw new Error('Requested model identifier does not match the resolved session model.');
    }
    return {
      args: [...resolved.model.args],
      providerId: resolved.model.provider.id,
      providerModelId: resolved.model.providerModel ?? resolved.resolvedId,
      requestedModelId: originalRequest,
      resolvedModelId: resolved.resolvedId,
    };
  },
  writeLogMessage(opts: {
    logger: InternalAgentSessionOptions['logger'];
    logPath: null | string;
    message: string;
    prefix: string;
  }): void {
    if (opts.logger !== undefined) {
      const lines = opts.message.split('\n');
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        opts.logger.debug(`${opts.prefix}: ${line}`);
      }
    }

    if (opts.logPath !== null) {
      const suffix = opts.message.endsWith('\n') ? '' : '\n';
      appendTranscriptMessage(opts.logPath, `${opts.message}${suffix}`);
    }
  },
};

/**
 * Estimate token count from text length.
 * Uses a rough approximation of ~4 characters per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function appendTranscriptMessage(logPath: string, message: string): void {
  const canonicalDirectory = realpathSync(dirname(logPath));
  const canonicalPath = resolve(canonicalDirectory, basename(logPath));
  if (canonicalPath !== logPath) {
    throw new Error('unsafe_transcript_path: transcript evidence path is not canonical.');
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      canonicalPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    const transcriptStat = fstatSync(descriptor);
    if (
      !transcriptStat.isFile() ||
      transcriptStat.nlink !== 1 ||
      (typeof process.getuid === 'function' && transcriptStat.uid !== process.getuid())
    ) {
      throw new Error('unsafe_transcript_path: transcript evidence must use an owner-only regular file.');
    }
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, message, null, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') {
      throw new Error('unsafe_transcript_path: transcript evidence path changed before write.', { cause: error });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}
