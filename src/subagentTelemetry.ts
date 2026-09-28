import type { AgentModelName, AgentSessionProcessOutcome } from './vendor/ai/index.js';
import { createLocalJsonlTelemetrySink, type TelemetrySink } from './vendor/telemetry/index.js';

import { randomUUID } from 'node:crypto';

import type { SubagentType } from './presets.js';

export interface CreateSubagentTelemetryOptions {
  onError?: (error: unknown) => void;
  rootDir?: string;
  sink?: TelemetrySink;
}

export type SubagentCleanupOutcome = 'failed' | 'not_required' | 'succeeded';

export type SubagentParentSessionIdSource =
  | 'env:AI_AGENT_SESSION_ID'
  | 'env:AI_SUBAGENT_PARENT_SESSION_ID'
  | 'env:CODEX_SESSION_ID'
  | 'env:CODEX_THREAD_ID'
  | 'fallback:server_run_id';

export interface SubagentTelemetry {
  close(): Promise<void>;
  recordEvent(event: SubagentTelemetryEvent): void;
}

export interface SubagentTelemetryEvent {
  agentId?: string;
  agentType?: SubagentType;
  attributionSource?: 'exact-launch-contract' | 'provider-event';
  backendSessionId?: string;
  capabilitiesUsed?: string[];
  capabilityInspectionStatus?: 'ok' | 'unavailable';
  capabilityMcpServers?: string[];
  capabilityMissing?: string[];
  capabilityPlugins?: string[];
  capabilitySkills?: string[];
  childDepth?: number;
  cleanupOutcome?: SubagentCleanupOutcome;
  costUsd?: number;
  current?: number;
  depth: number;
  effectiveModelId?: string;
  effectiveProvider?: string;
  effectiveReasoningEffort?: string;
  elapsedMs?: number;
  envKey?: string;
  errorMessage?: string;
  eventType: SubagentTelemetryEventType;
  hostEffectiveModelId?: string;
  limit?: number;
  limitName?: string;
  maxOutputBytes?: number;
  model?: AgentModelName;
  modelId?: string;
  noNestedDelegation?: true;
  operation?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  parentAgentId?: string;
  parentSessionId: string;
  parentSessionIdSource: SubagentParentSessionIdSource;
  pollCount?: number;
  preflightAuthMode?: 'host-subscription' | 'provider-api-key';
  preflightTransport?: string;
  preflightVersion?: string;
  processCompletionMs?: number;
  processExitCode?: null | number;
  processFirstActivityMs?: number;
  processLastActivityMs?: number;
  processReceivedBytes?: number;
  processSignal?: NodeJS.Signals | null;
  processStderrBytes?: number;
  processStdoutBytes?: number;
  project?: string;
  provider?: string;
  providerTerminalStatus?: string;
  reasoningEffort?: string;
  requestedModelId?: string;
  requestedProvider?: string;
  requestedReasoningEffort?: string;
  requiresOpenRouter?: boolean;
  resolvedModelId?: string;
  resolvedProvider?: string;
  resolvedReasoningEffort?: string;
  resultBytes?: number;
  resultTruncated?: boolean;
  resumed?: boolean;
  schemaVersion: 2;
  selectedSkillDigests?: string[];
  selectedSkills?: string[];
  serverRunId: string;
  status: 'error' | 'ok';
  structuredOutput?: NonNullable<AgentSessionProcessOutcome['structuredOutput']>;
  terminalCause?: string;
  terminalOutcome?: string;
  terminalOwner?: SubagentTerminalOwner;
  terminalStatus?: string;
  totalCachedInputTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningOutputTokens?: number;
  totalTokens?: number;
  transcriptRef?: string;
  turnCachedInputTokens?: number;
  turnInputTokens?: number;
  turnOutputTokens?: number;
  turnReasoningOutputTokens?: number;
  turnTokens?: number;
  turnUsageReported?: boolean;
  verificationGreenCount?: number;
  verificationRedCount?: number;
  verificationStatus?: string;
  waitMs?: number;
}

export type SubagentTelemetryEventType =
  | 'budget_rejected'
  | 'close'
  | 'dispose'
  | 'preflight'
  | 'spawn'
  | 'turn_completed'
  | 'turn_failed';

export interface SubagentTelemetryIdentity {
  parentAgentId?: string;
  parentSessionId: string;
  parentSessionIdSource: SubagentParentSessionIdSource;
  serverRunId: string;
}

export type SubagentTerminalOwner = 'adapter' | 'parent' | 'policy' | 'provider' | 'runtime';

export function createSubagentTelemetry(options: CreateSubagentTelemetryOptions = {}): SubagentTelemetry {
  const sink =
    options.sink ??
    createLocalJsonlTelemetrySink({ ...(options.rootDir !== undefined ? { rootDir: options.rootDir } : {}) });
  const onError = options.onError ?? defaultTelemetryErrorHandler;
  const pending = new Set<Promise<void>>();
  let closed = false;

  async function writeEvent(event: SubagentTelemetryEvent): Promise<void> {
    const inputSummary = removeUndefined({ ...event, v: event.schemaVersion });

    await sink.upsertSession({
      host: 'ai-subagent',
      metadata: removeUndefined({
        parentAgentId: event.parentAgentId,
        parentSessionId: event.parentSessionId,
        parentSessionIdSource: event.parentSessionIdSource,
        plugin: 'ai-subagent',
        project: event.project,
        schemaVersion: event.schemaVersion,
        serverRunId: event.serverRunId,
      }),
      sessionId: event.parentSessionId,
    });
    await sink.recordEvent({
      ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
      eventType: event.eventType,
      inputSummary,
      plugin: 'ai-subagent',
      sessionId: event.parentSessionId,
      source: 'orchestrator',
      status: event.status,
      toolName: event.operation ?? event.eventType,
    });
  }

  return {
    async close(): Promise<void> {
      closed = true;
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
      await sink.close();
    },
    recordEvent(event): void {
      if (closed) {
        onError(new Error('local_telemetry_closed: cannot record ai-subagent telemetry after close.'));
        return;
      }
      const operation = writeEvent(event).catch(onError);
      pending.add(operation);
      void operation.finally(() => {
        pending.delete(operation);
      });
    },
  };
}

export function resolveSubagentTelemetryIdentity(
  env: NodeJS.ProcessEnv,
  serverRunId = randomUUID(),
): SubagentTelemetryIdentity {
  const parentSession = firstNonEmptyEnv(env, [
    ['AI_SUBAGENT_PARENT_SESSION_ID', 'env:AI_SUBAGENT_PARENT_SESSION_ID'],
    ['CODEX_SESSION_ID', 'env:CODEX_SESSION_ID'],
    ['CODEX_THREAD_ID', 'env:CODEX_THREAD_ID'],
    ['AI_AGENT_SESSION_ID', 'env:AI_AGENT_SESSION_ID'],
  ]);
  const currentAgentId = asNonEmptyString(env.AI_SUBAGENT_AGENT_ID);

  return {
    ...(currentAgentId !== undefined ? { parentAgentId: currentAgentId } : {}),
    parentSessionId: parentSession?.value ?? serverRunId,
    parentSessionIdSource: parentSession?.source ?? 'fallback:server_run_id',
    serverRunId,
  };
}

function asNonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultTelemetryErrorHandler(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[ai-subagent] Local telemetry write failed: ${message}\n`);
}

function firstNonEmptyEnv(
  env: NodeJS.ProcessEnv,
  candidates: readonly (readonly [key: string, source: SubagentParentSessionIdSource])[],
): undefined | { source: SubagentParentSessionIdSource; value: string } {
  for (const [key, source] of candidates) {
    const value = asNonEmptyString(env[key]);
    if (value !== undefined) {
      return { source, value };
    }
  }
  return undefined;
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
