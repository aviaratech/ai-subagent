import type {
  AgentModelName,
  ApiAgentSession as AgentSession,
  ApiAgentSessionOptions as AgentSessionOptions,
  AgentSessionProcessOutcome,
  ContextSection,
  RestrictedCodexHome,
  TokenUsage,
} from './vendor/ai/index.js';

import {
  AGENT_MODEL_CLAUDE,
  AGENT_MODEL_GPT,
  AGENT_MODEL_XAI,
  createSession,
  getModelPolicyEntry,
  MODEL_TRANSPORTS,
  resolveModelReasoningEffort,
  runModelLaunchPreflight,
  writeRestrictedCodexHome,
} from './vendor/ai/index.js';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as lockfile from 'proper-lockfile';

import { resolveSubagentPreset, type SubagentType } from './presets.js';
import { validateSubagentProjectRoot } from './projectRoot.js';
import { buildSubagentRuntimeEnv } from './runtimeEnv.js';
import { renderSuperpowersBootstrap, resolveSuperpowersSkills, type SelectedSuperpowersSkills } from './superpowers.js';
import {
  createSubagentTelemetry,
  resolveSubagentTelemetryIdentity,
  type SubagentCleanupOutcome,
  type SubagentTelemetry,
  type SubagentTelemetryEvent,
  type SubagentTelemetryIdentity,
  type SubagentTerminalOwner,
} from './subagentTelemetry.js';

const RESPONSE_SENTINEL = '---AI_SUBAGENT_DONE---';
const REGISTRY_LOCK_RETRY_MS = 10;
const REGISTRY_LOCK_STALE_MS = 30_000;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_SUBAGENT_MAX_ACTIVE_AGENTS = 4;
const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
const DEFAULT_SUBAGENT_MAX_LIFECYCLE_CALLS = 60;
const DEFAULT_SUBAGENT_MAX_QUEUED_TURNS_PER_AGENT = 8;
const DEFAULT_SUBAGENT_MAX_SPAWNED_AGENTS = 50;
const MAX_SUBAGENT_BUDGET_COUNT = 1_000_000;
const MAX_SUBAGENT_OUTPUT_BYTES = 1_000_000;
const DEFAULT_SUBAGENT_MAX_OUTPUT_BYTES = MAX_SUBAGENT_OUTPUT_BYTES;
const MAX_STRUCTURED_SUMMARY_ARRAY_ITEMS = 20;
const MAX_STRUCTURED_SUMMARY_BLOCK_BYTES = 8_192;
const MAX_STRUCTURED_SUMMARY_STRING_BYTES = 256;

const TERMINAL_ERROR_OWNERS = new Map<string, SubagentTerminalOwner>([
  ['claude_capacity_exhausted', 'provider'],
  ['claude_malformed_output', 'adapter'],
  ['claude_terminal_event_missing', 'adapter'],
  ['claude_unexpected_model_attribution', 'policy'],
  ['gpt_malformed_output', 'adapter'],
  ['gpt_terminal_event_missing', 'adapter'],
  ['grok_acp_attribution_mismatch', 'policy'],
  ['grok_acp_process_failed', 'provider'],
  ['grok_acp_protocol_incomplete', 'provider'],
  ['grok_acp_protocol_malformed', 'adapter'],
  ['grok_acp_provider_failed', 'provider'],
  ['grok_acp_resume_unsupported', 'adapter'],
  ['grok_authentication_failed', 'provider'],
  ['grok_capacity_exhausted', 'provider'],
  ['grok_launch_failed', 'provider'],
  ['grok_output_limit_exceeded', 'adapter'],
  ['grok_prompt_too_large', 'adapter'],
  ['grok_session_cleanup_failed', 'runtime'],
  ['grok_skill_reference_invalid', 'policy'],
  ['grok_usage_balance_exhausted', 'provider'],
]);

export interface CloseAgentInput {
  target: string;
}

export interface PersistedSubagentRecord {
  agentType: SubagentType;
  attributionSource?: 'exact-launch-contract' | 'provider-event';
  backendSessionId?: string;
  cleanupOutcome?: SubagentCleanupOutcome;
  createdAt: number;
  effectiveProvider?: string;
  error?: string;
  hostEffectiveModelId?: string;
  hostEffectiveReasoningEffort?: string;
  id: string;
  lastActivityAt: number;
  model: AgentModelName;
  modelId: string;
  processOutcome?: SubagentProcessOutcome;
  projectRoot: string;
  providerTerminalStatus?: string;
  reasoningEffort?: string;
  requestedModelId?: string;
  requestedReasoningEffort?: string;
  selectedSkillDigests?: string[];
  selectedSkills?: string[];
  status: SubagentStatus;
  terminalCause?: string;
  terminalOwner?: SubagentTerminalOwner;
  totalCachedInputTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ResumeAgentInput {
  id: string;
}

export interface SendInputInput {
  interrupt?: boolean;
  items?: unknown[];
  message?: string;
  target: string;
}

export interface SpawnAgentInput {
  agentType?: string;
  forkContext?: boolean;
  items?: unknown[];
  message?: string;
  model?: string;
  projectRoot?: string;
  purpose?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export type SubagentProcessOutcome = AgentSessionProcessOutcome;

export interface SubagentProgress {
  activityCount: number;
  elapsedMs: number;
  firstActivityAtMs?: number;
  idleMs: number;
  lastActivityAtMs: number;
  receivedBytes: number;
  startedAtMs: number;
}

export interface SubagentRegistry {
  get(id: string): PersistedSubagentRecord | undefined;
  remove(id: string): void;
  upsert(record: PersistedSubagentRecord): void;
}

export interface SubagentRuntimeIsolation {
  cleanup: () => Promise<void>;
  codexHome?: RestrictedCodexHome;
  runtimeMode?: AgentSessionOptions['runtimeMode'];
}

export interface SubagentService {
  closeAgent(input: CloseAgentInput): Promise<SubagentSummary>;
  dispose(): Promise<void>;
  resumeAgent(input: ResumeAgentInput): Promise<SubagentSummary>;
  sendInput(input: SendInputInput): Promise<SubagentSummary>;
  spawnAgent(input: SpawnAgentInput): Promise<SubagentSummary>;
  waitAgent(input: WaitAgentInput): Promise<WaitAgentResult>;
}

export interface SubagentServiceDependencies {
  audit: (event: string, fields: Record<string, boolean | number | string | undefined>) => void;
  createSession: (options: AgentSessionOptions) => AgentSession;
  env: NodeJS.ProcessEnv;
  now: () => number;
  registry: SubagentRegistry;
  resolveSuperpowersSkills: typeof resolveSuperpowersSkills;
  runModelLaunchPreflight: typeof runModelLaunchPreflight;
  telemetry: SubagentTelemetry;
  telemetryIdentity: SubagentTelemetryIdentity;
  validateProjectRoot: typeof validateSubagentProjectRoot;
  writeRestrictedCodexHome: typeof writeRestrictedCodexHome;
}

export type SubagentStatus = 'closed' | 'completed' | 'error' | 'idle' | 'in_progress';

export interface SubagentStructuredSummary {
  changedFiles?: string[];
  commands?: string[];
  concerns?: string[];
  evidence?: {
    green?: string[];
    red?: string[];
  };
  terminalStatus?: string;
}

export interface SubagentSummary {
  agentType?: SubagentType;
  attributionSource?: 'exact-launch-contract' | 'provider-event';
  cleanupOutcome?: SubagentCleanupOutcome;
  effectiveModelId?: string;
  effectiveProvider?: string;
  effectiveReasoningEffort?: string;
  error?: string;
  id: string;
  model?: AgentModelName;
  modelId?: string;
  output?: string;
  outputBytes?: number;
  outputConsumed?: boolean;
  outputRef?: string;
  outputTruncated?: boolean;
  processOutcome?: SubagentProcessOutcome;
  progress?: SubagentProgress;
  providerTerminalStatus?: string;
  reasoningEffort?: string;
  requestedModelId?: string;
  requestedReasoningEffort?: string;
  status: SubagentStatus;
  structured?: SubagentStructuredSummary;
  summarySource?: SubagentSummarySource;
  terminalCause?: string;
  terminalOwner?: SubagentTerminalOwner;
}

export type SubagentSummarySource = 'none' | 'structured';

export interface WaitAgentInput {
  includeOutput?: boolean;
  targets: string[];
  timeoutMs?: number;
}

export interface WaitAgentResult {
  results: SubagentSummary[];
}

interface ActiveTurn {
  activityCount: number;
  firstActivityAtMs?: number;
  lastActivityAtMs: number;
  polls: number;
  processOutcome?: SubagentProcessOutcome;
  promise: Promise<TurnOutcome>;
  receivedBytes: number;
  startedAtMs: number;
  terminalOverride?: TerminalMetadata;
  tokenUsage?: TokenUsage;
}

type AgentSessionActivity = Parameters<NonNullable<AgentSessionOptions['onActivity']>>[0];

interface ManagedSubagent {
  activeTurn?: ActiveTurn;
  clock: () => number;
  lastOutput?: SubagentOutput;
  queuedTurns: QueuedTurn[];
  record: PersistedSubagentRecord;
  runtimeIsolation: SubagentRuntimeIsolation;
  session: AgentSession;
  suspended?: boolean;
  transcriptPath: string;
}

interface QueuedTurn {
  capabilitiesUsed?: string[];
  maxOutputBytes: number;
  message: string;
  operation: string;
}

type ShutdownOutcome = 'cleanup_failed' | 'registry_persist_failed' | 'suspended';

interface SubagentBudgetLedger {
  lifecycleCalls: number;
  spawnedAgents: number;
}

interface SubagentBudgetLimits {
  maxActiveAgents: number;
  maxDepth: number;
  maxLifecycleCalls: number;
  maxOutputBytes: number;
  maxQueuedTurnsPerAgent: number;
  maxSpawnedAgents: number;
}

interface SubagentOutput {
  bytes: number;
  consumed: boolean;
  ref: string;
  structured?: SubagentStructuredSummary;
  summarySource: SubagentSummarySource;
  text: string;
  truncated: boolean;
}

interface TerminalMetadata {
  providerTerminalStatus?: string;
  terminalCause: string;
  terminalOwner: SubagentTerminalOwner;
}

interface TurnOutcome {
  error?: string;
  output?: string;
  status: 'closed' | 'completed' | 'error';
}

class FileSubagentRegistry implements SubagentRegistry {
  private readonly lockPath: string;

  constructor(private readonly path = defaultRegistryPath()) {
    this.lockPath = `${path}.lock`;
  }

  get(id: string): PersistedSubagentRecord | undefined {
    return this.load().get(id);
  }

  remove(id: string): void {
    this.update(records => {
      records.delete(id);
    });
  }

  upsert(record: PersistedSubagentRecord): void {
    this.update(records => {
      records.set(record.id, record);
    });
  }

  private acquireLock(): () => void {
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        return lockfile.lockSync(this.path, {
          lockfilePath: this.lockPath,
          realpath: false,
          retries: 0,
          stale: REGISTRY_LOCK_STALE_MS,
        });
      } catch (error: unknown) {
        if (!isLockHeldError(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(`registry_lock_timeout: timed out waiting for ${this.lockPath}`);
        }
        sleepSync(REGISTRY_LOCK_RETRY_MS);
      }
    }
  }

  private flush(records: Map<string, PersistedSubagentRecord>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp-${process.pid.toString()}-${randomUUID()}`;
    writeFileSync(tempPath, `${JSON.stringify([...records.values()], null, 2)}\n`, 'utf8');
    renameSync(tempPath, this.path);
  }

  private load(): Map<string, PersistedSubagentRecord> {
    const records = new Map<string, PersistedSubagentRecord>();
    if (!existsSync(this.path)) {
      return records;
    }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as PersistedSubagentRecord[];
    for (const record of parsed) {
      records.set(record.id, record);
    }
    return records;
  }

  private update(operation: (records: Map<string, PersistedSubagentRecord>) => void): void {
    const releaseLock = this.acquireLock();
    try {
      const records = this.load();
      operation(records);
      this.flush(records);
    } finally {
      releaseLock();
    }
  }
}

class MemorySubagentRegistry implements SubagentRegistry {
  private readonly records = new Map<string, PersistedSubagentRecord>();

  get(id: string): PersistedSubagentRecord | undefined {
    return this.records.get(id);
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  upsert(record: PersistedSubagentRecord): void {
    this.records.set(record.id, record);
  }
}

class UnsafeTranscriptPathError extends Error {
  constructor() {
    super('unsafe_transcript_path: transcript evidence must use a contained non-symlink regular file.');
    this.name = 'UnsafeTranscriptPathError';
  }
}

export function createFileSubagentRegistry(path: string): SubagentRegistry {
  return new FileSubagentRegistry(path);
}

export function createMemorySubagentRegistry(): SubagentRegistry {
  return new MemorySubagentRegistry();
}

export function createSubagentService(overrides?: Partial<SubagentServiceDependencies>): SubagentService {
  const env = overrides?.env ?? process.env;
  const runtime = buildSubagentRuntimeEnv({ env });
  const telemetryIdentity = overrides?.telemetryIdentity ?? resolveSubagentTelemetryIdentity(runtime.runtimeEnv);
  const dependencies: SubagentServiceDependencies = {
    audit: overrides?.audit ?? logSubagentAuditEvent,
    createSession: overrides?.createSession ?? createSession,
    env: runtime.runtimeEnv,
    now: overrides?.now ?? Date.now,
    registry: overrides?.registry ?? new FileSubagentRegistry(),
    resolveSuperpowersSkills: overrides?.resolveSuperpowersSkills ?? resolveSuperpowersSkills,
    runModelLaunchPreflight: overrides?.runModelLaunchPreflight ?? runModelLaunchPreflight,
    telemetry: overrides?.telemetry ?? createSubagentTelemetry(),
    telemetryIdentity,
    validateProjectRoot: overrides?.validateProjectRoot ?? validateSubagentProjectRoot,
    writeRestrictedCodexHome: overrides?.writeRestrictedCodexHome ?? writeRestrictedCodexHome,
  };
  const forwardEnv = runtime.forwardEnv;
  const budgetLimits = resolveBudgetLimits(dependencies.env);
  // ai-subagent runs as a stdio MCP server scoped to one parent session, so these counters reset with the process.
  const budgetLedger: SubagentBudgetLedger = {
    lifecycleCalls: 0,
    spawnedAgents: 0,
  };
  const agents = new Map<string, ManagedSubagent>();

  const restorePersistedAgentForClose = async (record: PersistedSubagentRecord): Promise<ManagedSubagent> => {
    const backendSessionId = record.backendSessionId;
    if (backendSessionId === undefined || backendSessionId.trim().length === 0) {
      throw typedError('agent_not_found', record.id);
    }
    const preset = resolveSubagentPreset({ agentType: record.agentType, model: record.modelId });
    const projectRoot = cleanupProjectRoot({
      dependencies,
      persistedProjectRoot: record.projectRoot,
    });
    const runtimeIsolation = await createRuntimeIsolation({ dependencies, preset });
    try {
      const session = dependencies.createSession({
        behavior: preset.behavior,
        context: [],
        env: buildAgentEnv({
          agentId: record.id,
          baseEnv: forwardEnv,
          ...(runtimeIsolation.codexHome !== undefined ? { codexHome: runtimeIsolation.codexHome.codexHome } : {}),
          modelId: preset.modelId,
          parentAgentId: currentSubagentAgentId(dependencies.env),
          parentDepth: currentSubagentDepth(dependencies.env),
          parentSessionId: dependencies.telemetryIdentity.parentSessionId,
        }),
        envMode: 'replace',
        model: record.model,
        modelId: record.modelId,
        projectRoot,
        ...(record.reasoningEffort !== undefined ? { reasoning: record.reasoningEffort } : {}),
        responseSentinel: RESPONSE_SENTINEL,
        ...(runtimeIsolation.runtimeMode !== undefined ? { runtimeMode: runtimeIsolation.runtimeMode } : {}),
        sessionId: backendSessionId,
        ...(preset.role !== undefined ? { role: preset.role } : {}),
      });
      applyExactLaunchAttribution(record);
      return {
        clock: dependencies.now,
        queuedTurns: [],
        record,
        runtimeIsolation,
        session,
        transcriptPath: '',
      };
    } catch (error) {
      await runtimeIsolation.cleanup();
      throw error;
    }
  };

  return {
    async closeAgent(input: CloseAgentInput): Promise<SubagentSummary> {
      let existing = agents.get(input.target);
      if (existing === undefined) {
        const record = dependencies.registry.get(input.target);
        if (record !== undefined && record.status === 'closed') {
          return { id: input.target, status: 'closed' };
        }
        if (
          record === undefined ||
          record.backendSessionId === undefined ||
          record.backendSessionId.trim().length === 0
        ) {
          throw typedError('agent_not_found', input.target);
        }
        existing = await restorePersistedAgentForClose(record);
        agents.set(record.id, existing);
      }

      markSubagentClosing({ agent: existing, dependencies, operation: 'close_agent' });
      try {
        await disposeManagedSubagent(existing);
      } catch {
        existing.record.error = 'agent_cleanup_failed: child session cleanup did not complete; retry close_agent.';
        existing.record.cleanupOutcome = 'failed';
        existing.record.status = 'error';
        existing.record.terminalCause = 'cleanup_failed';
        existing.record.terminalOwner = 'runtime';
        existing.record.lastActivityAt = dependencies.now();
        dependencies.registry.upsert(existing.record);
        emitSubagentTelemetryEvent({
          agent: existing.record,
          dependencies,
          errorMessage: 'agent_cleanup_failed',
          eventType: 'close',
          operation: 'close_agent',
          status: 'error',
        });
        throw new Error(existing.record.error);
      }
      agents.delete(input.target);
      markSubagentClosed({ agent: existing, dependencies });
      emitSubagentTelemetryEvent({
        agent: existing.record,
        dependencies,
        eventType: 'close',
        operation: 'close_agent',
        status: 'ok',
      });
      return summarize(existing, { includeOutput: true });
    },

    async dispose(): Promise<void> {
      const openAgents = [...agents.values()];
      let shutdownResults: PromiseSettledResult<ShutdownOutcome>[] = [];
      try {
        shutdownResults = await Promise.allSettled(
          openAgents.map(async agent => {
            markSubagentClosing({ agent, dependencies, operation: 'dispose' });
            try {
              await suspendManagedSubagent(agent);
            } catch {
              agent.record.error = 'agent_cleanup_failed: child session cleanup did not complete during shutdown.';
              agent.record.cleanupOutcome = 'failed';
              agent.record.status = 'error';
              agent.record.terminalCause = 'cleanup_failed';
              agent.record.terminalOwner = 'runtime';
              delete agent.record.backendSessionId;
              agent.record.lastActivityAt = dependencies.now();
              try {
                dependencies.registry.upsert(agent.record);
              } catch {
                emitRegistryPersistFailure({
                  agent,
                  dependencies,
                  operation: 'dispose',
                  terminalOutcome: 'cleanup_persist_failed',
                });
              }
              emitSubagentTelemetryEvent({
                agent: agent.record,
                dependencies,
                errorMessage: 'agent_cleanup_failed',
                eventType: 'dispose',
                operation: 'dispose',
                status: 'error',
              });
              return 'cleanup_failed';
            }
            try {
              markSubagentSuspended({ agent, dependencies });
            } catch {
              emitRegistryPersistFailure({
                agent,
                dependencies,
                operation: 'dispose',
                terminalOutcome: 'suspended_persist_failed',
              });
              return 'registry_persist_failed';
            }
            emitSubagentTelemetryEvent({
              agent: agent.record,
              dependencies,
              eventType: 'dispose',
              operation: 'dispose',
              status: 'ok',
            });
            return 'suspended';
          }),
        );
      } finally {
        agents.clear();
        await dependencies.telemetry.close();
      }
      if (shutdownResults.some(result => result.status === 'fulfilled' && result.value === 'cleanup_failed')) {
        throw new Error('agent_cleanup_failed: one or more child sessions did not clean up during shutdown.');
      }
      if (shutdownResults.some(result => result.status === 'rejected' || result.value === 'registry_persist_failed')) {
        throw new Error(
          'agent_registry_persist_failed: child teardown completed, but one or more terminal records were not persisted.',
        );
      }
    },

    async resumeAgent(input: ResumeAgentInput): Promise<SubagentSummary> {
      const existing = agents.get(input.id);
      if (existing !== undefined) {
        return summarize(existing);
      }

      const record = dependencies.registry.get(input.id);
      if (record === undefined) {
        throw typedError('agent_not_found', input.id);
      }
      if (
        record.status === 'closed' ||
        record.backendSessionId === undefined ||
        record.backendSessionId.trim().length === 0
      ) {
        throw typedError('agent_not_resumable', input.id);
      }

      const preset = resolveSubagentPreset({ agentType: record.agentType, model: record.modelId });
      assertModelTransportCapability({ capability: 'resume', modelId: preset.modelId, operation: 'resume_agent' });
      record.projectRoot = dependencies.validateProjectRoot(record.projectRoot);
      const selectedSkills = dependencies.resolveSuperpowersSkills({
        agentType: preset.agentType,
        env: dependencies.env,
        purpose: purposeForRole(preset.agentType),
      });
      assertPersistedSkillSelection({ record, selectedSkills });
      if (record.reasoningEffort !== undefined) {
        resolveModelReasoningEffort(record.modelId, record.reasoningEffort);
      }
      applyExactLaunchAttribution(record);
      assertSubagentDepthAllowsLaunch({ env: dependencies.env, maxDepth: budgetLimits.maxDepth });
      assertLocalGrokAllowed({ env: dependencies.env, preset });
      assertOpenRouterKeyIfNeeded({ baseEnv: forwardEnv, modelId: preset.modelId });
      const preflight = await dependencies.runModelLaunchPreflight({
        cwd: record.projectRoot,
        env: buildAgentEnv({
          agentId: record.id,
          baseEnv: forwardEnv,
          modelId: preset.modelId,
          parentAgentId: currentSubagentAgentId(dependencies.env),
          parentDepth: currentSubagentDepth(dependencies.env),
          parentSessionId: dependencies.telemetryIdentity.parentSessionId,
        }),
        modelId: preset.modelId,
      });
      assertPreflightAttribution({ modelId: preset.modelId, preflight });
      emitPreflightTelemetry({ dependencies, preflight, record });
      assertCanActivateAgent({
        agents,
        dependencies,
        ledger: budgetLedger,
        limits: budgetLimits,
        operation: 'resume_agent',
      });
      const runtimeIsolation = await createRuntimeIsolation({ dependencies, preset });
      const transcriptPath = prepareSubagentTranscriptPath({
        env: forwardEnv,
        id: record.id,
        projectRoot: record.projectRoot,
      });
      const agentRef: { current?: ManagedSubagent } = {};
      const session = dependencies.createSession({
        behavior: preset.behavior,
        context: buildSessionContext(preset.instructions, selectedSkills),
        env: buildAgentEnv({
          agentId: record.id,
          baseEnv: forwardEnv,
          ...(runtimeIsolation.codexHome !== undefined ? { codexHome: runtimeIsolation.codexHome.codexHome } : {}),
          modelId: preset.modelId,
          parentAgentId: currentSubagentAgentId(dependencies.env),
          parentDepth: currentSubagentDepth(dependencies.env),
          parentSessionId: dependencies.telemetryIdentity.parentSessionId,
        }),
        envMode: 'replace',
        model: record.model,
        modelId: record.modelId,
        onActivity: activity => {
          if (agentRef.current !== undefined) {
            recordActiveTurnActivity({ activity, agent: agentRef.current });
          }
        },
        onProcessOutcome: outcome => {
          if (agentRef.current !== undefined) {
            recordActiveTurnProcessOutcome({ agent: agentRef.current, outcome });
          }
        },
        onTokenUsage: usage => {
          if (agentRef.current !== undefined) {
            recordActiveTurnTokenUsage({ agent: agentRef.current, usage });
          }
        },
        projectRoot: record.projectRoot,
        ...(record.reasoningEffort !== undefined ? { reasoning: record.reasoningEffort } : {}),
        responseSentinel: RESPONSE_SENTINEL,
        ...(runtimeIsolation.runtimeMode !== undefined ? { runtimeMode: runtimeIsolation.runtimeMode } : {}),
        sessionId: record.backendSessionId,
        superpowersSkillReferences: selectedSkills.references,
        ...(preset.role !== undefined ? { role: preset.role } : {}),
        transcriptPath,
      });

      record.status = 'idle';
      clearTerminalMetadata(record);
      record.lastActivityAt = dependencies.now();
      const agent: ManagedSubagent = {
        clock: dependencies.now,
        queuedTurns: [],
        record,
        runtimeIsolation,
        session,
        transcriptPath,
      };
      agentRef.current = agent;
      agents.set(record.id, agent);
      dependencies.registry.upsert(record);
      emitSpawnTelemetry({
        dependencies,
        operation: 'resume_agent',
        preset,
        record,
        resumed: true,
      });
      return summarize(agent);
    },

    async sendInput(input: SendInputInput): Promise<SubagentSummary> {
      const agent = requireOpenAgent({ agents, id: input.target, registry: dependencies.registry });
      assertCanStartTurn({
        agent,
        agents,
        dependencies,
        limits: budgetLimits,
        operation: 'send_input',
      });
      recordLifecycleCall({
        agent: agent.record,
        dependencies,
        ledger: budgetLedger,
        limit: budgetLimits.maxLifecycleCalls,
        operation: 'send_input',
      });
      const queuedTurn: QueuedTurn = {
        capabilitiesUsed: ['send'],
        maxOutputBytes: budgetLimits.maxOutputBytes,
        message: renderMessageInput({
          ...(input.items !== undefined ? { items: input.items } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
        }),
        operation: 'send_input',
      };
      const activeTurn = agent.activeTurn;
      if (activeTurn === undefined) {
        startTurn({ agent, dependencies, ...queuedTurn });
        return summarize(agent);
      }

      assertQueueCapacity({ agent, limit: budgetLimits.maxQueuedTurnsPerAgent });
      if (input.interrupt !== true) {
        queuedTurn.capabilitiesUsed = ['queue'];
        agent.queuedTurns.push(queuedTurn);
        return summarize(agent);
      }

      if (!agent.session.getCapabilities().interrupt) {
        throw typedError('agent_interrupt_unsupported', agent.record.id);
      }
      queuedTurn.capabilitiesUsed = ['interrupt'];
      agent.queuedTurns.unshift(queuedTurn);
      const previousTerminalOverride = activeTurn.terminalOverride;
      activeTurn.terminalOverride = { terminalCause: 'cancelled', terminalOwner: 'parent' };
      try {
        await agent.session.interrupt();
        await activeTurn.promise;
      } catch (error) {
        if (previousTerminalOverride === undefined) {
          delete activeTurn.terminalOverride;
        } else {
          activeTurn.terminalOverride = previousTerminalOverride;
        }
        const replacementIndex = agent.queuedTurns.indexOf(queuedTurn);
        if (replacementIndex !== -1) {
          agent.queuedTurns.splice(replacementIndex, 1);
        }
        throw error;
      }
      return summarize(agent);
    },

    async spawnAgent(input: SpawnAgentInput): Promise<SubagentSummary> {
      const preset = resolveSubagentPreset({
        ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      });
      assertSupportedSpawnOptions(input, preset.modelId);
      const reasoningEffort =
        input.reasoningEffort === undefined
          ? preset.defaultReasoningEffort
          : resolveModelReasoningEffort(preset.modelId, input.reasoningEffort);
      const projectRoot = dependencies.validateProjectRoot(input.projectRoot ?? process.cwd());
      const initialMessage = renderOptionalMessageInput({
        ...(input.items !== undefined ? { items: input.items } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
      });
      const selectedSkills = dependencies.resolveSuperpowersSkills({
        agentType: preset.agentType,
        env: dependencies.env,
        purpose: input.purpose ?? initialMessage ?? '',
      });
      assertLocalGrokAllowed({ env: dependencies.env, preset });
      assertSubagentDepthAllowsLaunch({ env: dependencies.env, maxDepth: budgetLimits.maxDepth });
      assertOpenRouterKeyIfNeeded({ baseEnv: forwardEnv, modelId: preset.modelId });
      const preflight = await dependencies.runModelLaunchPreflight({
        cwd: projectRoot,
        env: buildAgentEnv({
          agentId: 'preflight',
          baseEnv: forwardEnv,
          modelId: preset.modelId,
          parentAgentId: currentSubagentAgentId(dependencies.env),
          parentDepth: currentSubagentDepth(dependencies.env),
          parentSessionId: dependencies.telemetryIdentity.parentSessionId,
        }),
        modelId: preset.modelId,
      });
      assertPreflightAttribution({ modelId: preset.modelId, preflight });
      assertCanSpawnAgent({
        agents,
        dependencies,
        ledger: budgetLedger,
        limits: budgetLimits,
      });
      const runtimeIsolation = await createRuntimeIsolation({ dependencies, preset });
      const id = randomUUID();
      const transcriptPath = prepareSubagentTranscriptPath({ env: forwardEnv, id, projectRoot });
      const createdAt = dependencies.now();
      const record: PersistedSubagentRecord = {
        agentType: preset.agentType,
        attributionSource: 'exact-launch-contract',
        createdAt,
        id,
        lastActivityAt: createdAt,
        model: preset.model,
        modelId: preset.modelId,
        projectRoot,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        requestedModelId: input.model?.trim() ?? preset.modelId,
        ...(reasoningEffort !== undefined
          ? { requestedReasoningEffort: input.reasoningEffort?.trim() ?? reasoningEffort }
          : {}),
        selectedSkillDigests: selectedSkills.skills.map(skill => skill.digest),
        selectedSkills: selectedSkills.names,
        status: 'idle',
      };
      applyExactLaunchAttribution(record);

      emitPreflightTelemetry({ dependencies, preflight, record });

      const agentRef: { current?: ManagedSubagent } = {};
      const session = dependencies.createSession({
        behavior: preset.behavior,
        context: buildSessionContext(preset.instructions, selectedSkills),
        env: buildAgentEnv({
          agentId: id,
          baseEnv: forwardEnv,
          ...(runtimeIsolation.codexHome !== undefined ? { codexHome: runtimeIsolation.codexHome.codexHome } : {}),
          modelId: preset.modelId,
          parentAgentId: currentSubagentAgentId(dependencies.env),
          parentDepth: currentSubagentDepth(dependencies.env),
          parentSessionId: dependencies.telemetryIdentity.parentSessionId,
        }),
        envMode: 'replace',
        model: preset.model,
        modelId: preset.modelId,
        onActivity: activity => {
          if (agentRef.current !== undefined) {
            recordActiveTurnActivity({ activity, agent: agentRef.current });
          }
        },
        onProcessOutcome: outcome => {
          if (agentRef.current !== undefined) {
            recordActiveTurnProcessOutcome({ agent: agentRef.current, outcome });
          }
        },
        onTokenUsage: usage => {
          if (agentRef.current !== undefined) {
            recordActiveTurnTokenUsage({ agent: agentRef.current, usage });
          }
        },
        projectRoot,
        ...(reasoningEffort !== undefined ? { reasoning: reasoningEffort } : {}),
        responseSentinel: RESPONSE_SENTINEL,
        ...(runtimeIsolation.runtimeMode !== undefined ? { runtimeMode: runtimeIsolation.runtimeMode } : {}),
        superpowersSkillReferences: selectedSkills.references,
        transcriptPath,
        ...(preset.role !== undefined ? { role: preset.role } : {}),
      });

      const agent: ManagedSubagent = {
        clock: dependencies.now,
        queuedTurns: [],
        record,
        runtimeIsolation,
        session,
        transcriptPath,
      };
      agentRef.current = agent;
      agents.set(id, agent);
      dependencies.registry.upsert(record);
      auditSpawn({
        dependencies,
        preset,
        record,
      });
      emitSpawnTelemetry({
        dependencies,
        operation: 'spawn_agent',
        preset,
        record,
        resumed: false,
      });

      if (initialMessage !== undefined) {
        startTurn({
          agent,
          capabilitiesUsed: ['spawn'],
          dependencies,
          maxOutputBytes: budgetLimits.maxOutputBytes,
          message: initialMessage,
          operation: 'spawn_agent',
        });
      }

      return summarize(agent);
    },

    async waitAgent(input: WaitAgentInput): Promise<WaitAgentResult> {
      const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
      const includeOutput = input.includeOutput ?? true;
      for (const target of input.targets) {
        const agent = agents.get(target);
        if (agent?.activeTurn !== undefined) {
          agent.activeTurn.polls += 1;
        }
      }
      const summarizeTarget = (target: string): SubagentSummary => {
        const agent = agents.get(target);
        if (agent !== undefined) {
          return summarize(agent, { includeOutput });
        }
        const record = dependencies.registry.get(target);
        if (record !== undefined) {
          return summarizeRecord(record);
        }
        return { error: `agent_not_found: ${target}`, id: target, status: 'error' };
      };
      const terminalResults = (): SubagentSummary[] =>
        input.targets.map(summarizeTarget).filter(result => isWaitTerminalStatus(result.status));

      if (timeoutMs <= 0) {
        return { results: input.targets.map(summarizeTarget) };
      }
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const terminals = terminalResults();
        if (terminals.length > 0) {
          return { results: terminals };
        }
        const pending = input.targets
          .map(target => agents.get(target)?.activeTurn?.promise)
          .filter((promise): promise is Promise<TurnOutcome> => promise !== undefined);
        if (pending.length === 0) {
          return { results: input.targets.map(summarizeTarget) };
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return { results: input.targets.map(summarizeTarget) };
        }
        const waitTimeout = createWaitTimeout(remainingMs);
        let settled: boolean;
        try {
          settled = await Promise.race([...pending.map(promise => promise.then(() => true)), waitTimeout.promise]);
        } finally {
          waitTimeout.cancel();
        }
        if (!settled) {
          return { results: input.targets.map(summarizeTarget) };
        }
      }
    },
  };
}

function applyExactLaunchAttribution(record: PersistedSubagentRecord): void {
  if (record.attributionSource === 'provider-event') {
    return;
  }
  record.attributionSource = 'exact-launch-contract';
  record.effectiveProvider ??= providerForModel(record.modelId);
  record.hostEffectiveModelId ??= record.modelId;
  if (record.reasoningEffort !== undefined) {
    record.hostEffectiveReasoningEffort ??= record.reasoningEffort;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertCanActivateAgent(input: {
  agents: Map<string, ManagedSubagent>;
  dependencies: SubagentServiceDependencies;
  ledger: SubagentBudgetLedger;
  limits: SubagentBudgetLimits;
  operation: string;
}): void {
  const activeAgents = countBudgetActiveAgents(input.agents);
  if (activeAgents >= input.limits.maxActiveAgents) {
    throwBudgetExceeded({
      current: activeAgents,
      dependencies: input.dependencies,
      envKey: 'AI_SUBAGENT_MAX_ACTIVE_AGENTS',
      limit: input.limits.maxActiveAgents,
      limitName: 'max_active_agents',
      operation: input.operation,
    });
  }
  recordLifecycleCall({
    dependencies: input.dependencies,
    ledger: input.ledger,
    limit: input.limits.maxLifecycleCalls,
    operation: input.operation,
  });
}

function assertCanSpawnAgent(input: {
  agents: Map<string, ManagedSubagent>;
  dependencies: SubagentServiceDependencies;
  ledger: SubagentBudgetLedger;
  limits: SubagentBudgetLimits;
}): void {
  const activeAgents = countBudgetActiveAgents(input.agents);
  if (activeAgents >= input.limits.maxActiveAgents) {
    throwBudgetExceeded({
      current: activeAgents,
      dependencies: input.dependencies,
      envKey: 'AI_SUBAGENT_MAX_ACTIVE_AGENTS',
      limit: input.limits.maxActiveAgents,
      limitName: 'max_active_agents',
      operation: 'spawn_agent',
    });
  }
  if (input.ledger.spawnedAgents >= input.limits.maxSpawnedAgents) {
    throwBudgetExceeded({
      current: input.ledger.spawnedAgents,
      dependencies: input.dependencies,
      envKey: 'AI_SUBAGENT_MAX_SPAWNED_AGENTS',
      limit: input.limits.maxSpawnedAgents,
      limitName: 'max_spawned_agents',
      operation: 'spawn_agent',
    });
  }
  recordLifecycleCall({
    dependencies: input.dependencies,
    ledger: input.ledger,
    limit: input.limits.maxLifecycleCalls,
    operation: 'spawn_agent',
  });
  input.ledger.spawnedAgents += 1;
}

function assertCanStartTurn(input: {
  agent: ManagedSubagent;
  agents: Map<string, ManagedSubagent>;
  dependencies: SubagentServiceDependencies;
  limits: SubagentBudgetLimits;
  operation: string;
}): void {
  const activeAgents = countBudgetActiveAgents(input.agents);
  const nextActiveAgents = isActiveBudgetStatus(input.agent.record.status) ? activeAgents : activeAgents + 1;
  if (nextActiveAgents > input.limits.maxActiveAgents) {
    throwBudgetExceeded({
      agent: input.agent.record,
      current: activeAgents,
      dependencies: input.dependencies,
      envKey: 'AI_SUBAGENT_MAX_ACTIVE_AGENTS',
      limit: input.limits.maxActiveAgents,
      limitName: 'max_active_agents',
      operation: input.operation,
    });
  }
}

function assertLocalGrokAllowed(input: {
  env: NodeJS.ProcessEnv;
  preset: { model: AgentModelName; modelId: string };
}): void {
  if (input.preset.model !== AGENT_MODEL_XAI || input.preset.modelId !== 'grok-4.5') {
    return;
  }
  const executionEnvironment = input.env.AI_SUBAGENT_EXECUTION_ENV?.trim().toLowerCase();
  if (
    isTruthy(input.env.CI) ||
    isTruthy(input.env.GITHUB_ACTIONS) ||
    input.env.KUBERNETES_SERVICE_HOST !== undefined ||
    input.env.AWS_EXECUTION_ENV !== undefined ||
    executionEnvironment === 'ci' ||
    executionEnvironment === 'container' ||
    executionEnvironment === 'remote' ||
    executionEnvironment === 'server'
  ) {
    throw new Error(
      'grok_trusted_local_unavailable: native Grok subscription transport is restricted to an operator-owned local machine and is unavailable in CI or non-local execution.',
    );
  }
}

function assertModelTransportCapability(input: {
  capability: 'fork' | 'resume';
  modelId: string;
  operation: string;
}): void {
  const transport = getModelPolicyEntry(input.modelId)?.launch?.transport;
  if (transport === undefined || !MODEL_TRANSPORTS[transport][input.capability]) {
    throw new Error(`agent_${input.capability}_unsupported: ${input.operation} is unavailable for ${input.modelId}.`);
  }
}

function assertOpenRouterKeyIfNeeded(input: { baseEnv: Record<string, string>; modelId: string }): void {
  const provider = codexProviderForModel(input.modelId);
  if (provider !== undefined && input.baseEnv[provider.envKey] === undefined) {
    throw new Error(
      `missing_openrouter_api_key: ${provider.envKey} is required for ${input.modelId}/${provider.name} subagents.`,
    );
  }
}

function assertPathWithinRoot(rootPath: string, candidatePath: string): void {
  const relativePath = relative(realpathSync(rootPath), candidatePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new UnsafeTranscriptPathError();
  }
}

function assertPersistedSkillSelection(input: {
  record: PersistedSubagentRecord;
  selectedSkills: SelectedSuperpowersSkills;
}): void {
  const currentDigests = input.selectedSkills.skills.map(skill => skill.digest);
  if (
    input.record.selectedSkills === undefined ||
    input.record.selectedSkillDigests === undefined ||
    JSON.stringify(input.record.selectedSkills) !== JSON.stringify(input.selectedSkills.names) ||
    JSON.stringify(input.record.selectedSkillDigests) !== JSON.stringify(currentDigests)
  ) {
    throw new Error(
      'agent_resume_policy_drift: the selected Superpowers instructions changed; start a new child session.',
    );
  }
}

function assertPreflightAttribution(input: {
  modelId: string;
  preflight: Awaited<ReturnType<typeof runModelLaunchPreflight>>;
}): void {
  if (input.preflight.modelId !== input.modelId || input.preflight.providerId !== providerForModel(input.modelId)) {
    throw new Error(
      'model_preflight_attribution_mismatch: provider preflight did not match the resolved model policy.',
    );
  }
}

function assertQueueCapacity(input: { agent: ManagedSubagent; limit: number }): void {
  if (input.agent.queuedTurns.length >= input.limit) {
    throw new Error(
      `agent_queue_full: ${input.agent.record.id} already has ${String(input.limit)} bounded queued turns.`,
    );
  }
}

function assertSubagentDepthAllowsLaunch(input: { env: NodeJS.ProcessEnv; maxDepth: number }): void {
  const currentDepth = currentSubagentDepth(input.env);
  if (currentDepth >= input.maxDepth) {
    throw new Error(
      `subagent_recursion_depth_exceeded: AI_SUBAGENT_DEPTH=${String(currentDepth)} is at or above max_depth=${String(
        input.maxDepth,
      )}; raise AI_SUBAGENT_MAX_DEPTH only for an intentional bounded recursion test.`,
    );
  }
  if (currentDepth > 0) {
    throw new Error(
      'nested_delegation_disabled: ai-subagent children cannot launch nested subagents without a separately approved bounded delegation contract.',
    );
  }
}

function assertSupportedSpawnOptions(input: SpawnAgentInput, modelId: string): void {
  if (input.forkContext === true) {
    assertModelTransportCapability({ capability: 'fork', modelId, operation: 'spawn_agent' });
    throw new Error(
      'agent_fork_source_required: fork_context=true requires an exact source session binding, which this request does not provide.',
    );
  }
  if (input.serviceTier !== undefined && input.serviceTier.trim().length > 0) {
    throw new Error('unsupported_spawn_option: service_tier is not supported by ai-subagent yet.');
  }
}

function auditSpawn(input: {
  dependencies: SubagentServiceDependencies;
  preset: { agentType: SubagentType; model: AgentModelName; modelId: string; requiresOpenRouter: boolean };
  record: PersistedSubagentRecord;
}): void {
  input.dependencies.audit('subagent_spawn', {
    agentType: input.preset.agentType,
    model: input.preset.model,
    modelId: input.preset.modelId,
    provider: providerForModel(input.preset.modelId),
    ...(input.record.reasoningEffort !== undefined ? { reasoningEffort: input.record.reasoningEffort } : {}),
    ...(input.record.requestedModelId !== undefined ? { requestedModelId: input.record.requestedModelId } : {}),
    ...(input.record.requestedReasoningEffort !== undefined
      ? { requestedReasoningEffort: input.record.requestedReasoningEffort }
      : {}),
    resolvedModelId: input.record.modelId,
    ...(input.record.reasoningEffort !== undefined ? { resolvedReasoningEffort: input.record.reasoningEffort } : {}),
    requiresOpenRouter: input.preset.requiresOpenRouter,
  });
}

function buildAgentEnv(input: {
  agentId: string;
  baseEnv: Record<string, string>;
  codexHome?: string;
  modelId: string;
  parentAgentId?: string | undefined;
  parentDepth: number;
  parentSessionId: string;
}): Record<string, string> {
  assertOpenRouterKeyIfNeeded({
    baseEnv: input.baseEnv,
    modelId: input.modelId,
  });

  const env: Record<string, string> = {
    ...input.baseEnv,
    AI_SUBAGENT_AGENT_ID: input.agentId,
    AI_SUBAGENT_DEPTH: String(input.parentDepth + 1),
    AI_SUBAGENT_NESTED_DELEGATION: '0',
    AI_SUBAGENT_PARENT_SESSION_ID: input.parentSessionId,
    ...(input.codexHome !== undefined ? { CODEX_HOME: input.codexHome } : {}),
    ...(input.parentAgentId !== undefined ? { AI_SUBAGENT_PARENT_AGENT_ID: input.parentAgentId } : {}),
  };
  const provider = codexProviderForModel(input.modelId);
  const providerApiKey = provider === undefined ? undefined : input.baseEnv[provider.envKey];
  delete env.ANTHROPIC_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.XAI_API_KEY;
  if (provider !== undefined && providerApiKey !== undefined) {
    env[provider.envKey] = providerApiKey;
  }
  return env;
}

function buildSessionContext(instructions: string, selectedSkills: SelectedSuperpowersSkills): ContextSection[] {
  return [
    {
      body: renderSuperpowersBootstrap(selectedSkills),
      heading: 'Required Superpowers Bootstrap',
    },
    {
      body: instructions,
      heading: 'AI Subagent Preset',
    },
  ];
}

function captureBackendSessionId(agent: ManagedSubagent): void {
  const backendSessionId = agent.session.getSessionId();
  if (backendSessionId !== undefined) {
    agent.record.backendSessionId = backendSessionId;
  }
}

function classifyTerminalError(error: unknown): TerminalMetadata {
  const code = stableErrorProperty(error, 'code');
  const providerTerminalStatus = stableErrorProperty(error, 'terminalStatus');
  if (code === undefined) {
    return {
      ...(providerTerminalStatus !== undefined ? { providerTerminalStatus } : {}),
      terminalCause: 'provider_error',
      terminalOwner: 'provider',
    };
  }

  const terminalOwner = TERMINAL_ERROR_OWNERS.get(code);
  if (terminalOwner === undefined) {
    return {
      ...(providerTerminalStatus !== undefined ? { providerTerminalStatus } : {}),
      terminalCause: 'provider_error',
      terminalOwner: 'provider',
    };
  }
  return {
    ...(providerTerminalStatus !== undefined ? { providerTerminalStatus } : {}),
    terminalCause: code,
    terminalOwner,
  };
}

function cleanupProjectRoot(input: {
  dependencies: SubagentServiceDependencies;
  persistedProjectRoot: string;
}): string {
  try {
    return input.dependencies.validateProjectRoot(input.persistedProjectRoot);
  } catch {
    return input.dependencies.validateProjectRoot(process.cwd());
  }
}

function clearTerminalMetadata(record: PersistedSubagentRecord): void {
  delete record.cleanupOutcome;
  delete record.processOutcome;
  delete record.providerTerminalStatus;
  delete record.terminalCause;
  delete record.terminalOwner;
}

function codexProviderForModel(modelId: string) {
  return getModelPolicyEntry(modelId)?.launch?.codexProvider;
}

function countBudgetActiveAgents(agents: Map<string, ManagedSubagent>): number {
  let count = 0;
  for (const agent of agents.values()) {
    if (isActiveBudgetStatus(agent.record.status)) {
      count += 1;
    }
  }
  return count;
}

async function createRuntimeIsolation(input: {
  dependencies: SubagentServiceDependencies;
  preset: { model: AgentModelName; modelId: string; requiresOpenRouter: boolean };
}): Promise<SubagentRuntimeIsolation> {
  if (input.preset.model === AGENT_MODEL_GPT) {
    const provider = codexProviderForModel(input.preset.modelId);
    if (provider === undefined) {
      return {
        cleanup: () => Promise.resolve(),
        runtimeMode: 'host-native',
      };
    }
    const codexHome = await input.dependencies.writeRestrictedCodexHome({
      mcpConfigPaths: [],
      ...(provider.catalogAlias !== undefined ? { modelCatalogAliases: [provider.catalogAlias] } : {}),
      modelProvider: {
        baseUrl: input.dependencies.env[provider.baseUrlEnvKey] ?? provider.baseUrl,
        envKey: provider.envKey,
        envKeyInstructions: provider.envKeyInstructions,
        id: provider.id,
        name: provider.name,
        wireApi: provider.wireApi,
      },
    });
    return {
      cleanup: () => codexHome.cleanup(),
      codexHome,
      runtimeMode: 'host-native',
    };
  }

  if (input.preset.model === AGENT_MODEL_CLAUDE) {
    return {
      cleanup: () => Promise.resolve(),
      runtimeMode: 'host-native',
    };
  }

  if (input.preset.model === AGENT_MODEL_XAI) {
    return {
      cleanup: () => Promise.resolve(),
      runtimeMode: 'host-native',
    };
  }

  return {
    cleanup: () => Promise.resolve(),
  };
}

function createSubagentOutput(input: {
  agent: ManagedSubagent;
  dependencies: SubagentServiceDependencies;
  maxOutputBytes: number;
  text: string;
}): SubagentOutput {
  const bytes = Buffer.byteLength(input.text, 'utf8');
  const truncated = bytes > input.maxOutputBytes;
  const text = truncated ? truncateUtf8(input.text, input.maxOutputBytes) : input.text;
  const structured = parseStructuredSummary({
    maxBlockBytes: Math.min(input.maxOutputBytes, MAX_STRUCTURED_SUMMARY_BLOCK_BYTES),
    text: input.text,
  });
  if (truncated) {
    input.dependencies.audit('output_truncated', {
      agentType: input.agent.record.agentType,
      bytes,
      id: input.agent.record.id,
      limit: input.maxOutputBytes,
      model: input.agent.record.model,
      modelId: input.agent.record.modelId,
      outputRef: input.agent.transcriptPath,
    });
  }
  return {
    bytes,
    consumed: false,
    ref: input.agent.transcriptPath,
    ...(structured !== undefined ? { structured } : {}),
    summarySource: structured === undefined ? 'none' : 'structured',
    text,
    truncated,
  };
}

function createWaitTimeout(ms: number): { cancel: () => void; promise: Promise<boolean> } {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<boolean>(resolveTimeout => {
    handle = setTimeout(() => {
      handle = undefined;
      resolveTimeout(false);
    }, ms);
  });
  return {
    cancel: () => {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
    promise,
  };
}

function currentSubagentAgentId(env: NodeJS.ProcessEnv): string | undefined {
  return asNonEmptyString(env.AI_SUBAGENT_AGENT_ID);
}

function currentSubagentDepth(env: NodeJS.ProcessEnv): number {
  return parseCurrentDepth(env.AI_SUBAGENT_DEPTH);
}

function defaultRegistryPath(): string {
  return join(homedir(), '.local', 'share', 'ai-subagent', 'subagent-sessions.json');
}

async function disposeManagedSubagent(agent: ManagedSubagent): Promise<void> {
  try {
    await agent.session.dispose();
  } finally {
    await agent.runtimeIsolation.cleanup();
  }
}

function emitPreflightTelemetry(input: {
  dependencies: SubagentServiceDependencies;
  preflight: Awaited<ReturnType<typeof runModelLaunchPreflight>>;
  record: PersistedSubagentRecord;
}): void {
  emitSubagentTelemetryEvent({
    agent: input.record,
    dependencies: input.dependencies,
    eventType: 'preflight',
    operation: 'provider_preflight',
    status: 'ok',
    values: {
      ...(input.preflight.capabilityInventory !== undefined
        ? {
            capabilityInspectionStatus: input.preflight.capabilityInventory.inspectionStatus,
            capabilityMcpServers: input.preflight.capabilityInventory.mcpServers.map(
              capability => `${capability.name}@${capability.origin}`,
            ),
            capabilityMissing: input.preflight.capabilityInventory.missing,
            capabilityPlugins: input.preflight.capabilityInventory.plugins.map(
              capability => `${capability.name}@${capability.origin}`,
            ),
            capabilitySkills: input.preflight.capabilityInventory.skills.map(
              capability => `${capability.name}@${capability.origin}`,
            ),
          }
        : {}),
      preflightAuthMode: input.preflight.authMode,
      preflightTransport: input.preflight.transport,
      preflightVersion: input.preflight.version,
    },
  });
}

function emitRegistryPersistFailure(input: {
  agent: ManagedSubagent;
  dependencies: SubagentServiceDependencies;
  operation: 'close_agent' | 'dispose';
  terminalOutcome:
    | 'cleanup_persist_failed'
    | 'closed_persist_failed'
    | 'closing_persist_failed'
    | 'suspended_persist_failed';
}): void {
  emitSubagentTelemetryEvent({
    agent: input.agent.record,
    dependencies: input.dependencies,
    errorMessage: 'agent_registry_persist_failed',
    eventType: input.operation === 'close_agent' ? 'close' : 'dispose',
    operation: input.operation,
    status: 'error',
    values: { terminalOutcome: input.terminalOutcome },
  });
}

function emitSpawnTelemetry(input: {
  dependencies: SubagentServiceDependencies;
  operation: string;
  preset: { agentType: SubagentType; model: AgentModelName; modelId: string; requiresOpenRouter: boolean };
  record: PersistedSubagentRecord;
  resumed: boolean;
}): void {
  emitSubagentTelemetryEvent({
    agent: input.record,
    dependencies: input.dependencies,
    eventType: 'spawn',
    operation: input.operation,
    status: 'ok',
    values: {
      attributionSource: input.record.attributionSource ?? 'exact-launch-contract',
      capabilitiesUsed: [input.resumed ? 'resume' : 'spawn'],
      childDepth: currentSubagentDepth(input.dependencies.env) + 1,
      noNestedDelegation: true,
      provider: providerForModel(input.preset.modelId),
      requiresOpenRouter: input.preset.requiresOpenRouter,
      resumed: input.resumed,
    },
  });
}

function emitSubagentTelemetryEvent(input: {
  agent?: PersistedSubagentRecord;
  dependencies: SubagentServiceDependencies;
  errorMessage?: string;
  eventType: SubagentTelemetryEvent['eventType'];
  operation?: string;
  status: SubagentTelemetryEvent['status'];
  values?: Partial<SubagentTelemetryEvent>;
}): void {
  const identity = input.dependencies.telemetryIdentity;
  const agentFields = input.agent === undefined ? {} : telemetryFieldsForRecord(input.agent);
  input.dependencies.telemetry.recordEvent({
    depth: currentSubagentDepth(input.dependencies.env),
    eventType: input.eventType,
    parentSessionId: identity.parentSessionId,
    parentSessionIdSource: identity.parentSessionIdSource,
    schemaVersion: 2,
    serverRunId: identity.serverRunId,
    status: input.status,
    ...(identity.parentAgentId !== undefined ? { parentAgentId: identity.parentAgentId } : {}),
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    ...agentFields,
    ...(input.values ?? {}),
  });
}

function ensureReadableTranscriptPath(input: { projectRoot: string; transcriptPath: string }): string {
  if (!existsSync(input.projectRoot)) {
    return input.transcriptPath;
  }

  const directory = prepareContainedTranscriptDirectory({
    directoryPath: dirname(input.transcriptPath),
    rootPath: input.projectRoot,
  });
  const transcriptPath = resolve(directory, basename(input.transcriptPath));
  assertPathWithinRoot(directory, transcriptPath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      transcriptPath,
      constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    const transcriptStat = fstatSync(descriptor);
    if (!transcriptStat.isFile() || transcriptStat.nlink !== 1) {
      throw new UnsafeTranscriptPathError();
    }
    if (typeof process.getuid === 'function' && transcriptStat.uid !== process.getuid()) {
      throw new UnsafeTranscriptPathError();
    }
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') {
      throw new UnsafeTranscriptPathError();
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  if (realpathSync(transcriptPath) !== transcriptPath) {
    throw new UnsafeTranscriptPathError();
  }
  return transcriptPath;
}

function extractFencedJsonBlocks(input: { maxBlockBytes: number; text: string }): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;

  while (searchFrom < input.text.length) {
    const fenceStart = input.text.indexOf('```', searchFrom);
    if (fenceStart < 0) {
      break;
    }

    const infoStart = fenceStart + 3;
    const firstLineEnd = input.text.indexOf('\n', infoStart);
    if (firstLineEnd < 0) {
      break;
    }

    const fenceEnd = input.text.indexOf('```', firstLineEnd + 1);
    if (fenceEnd < 0) {
      break;
    }

    const info = input.text.slice(infoStart, firstLineEnd).trim().toLowerCase();
    const block = input.text.slice(firstLineEnd + 1, fenceEnd).trim();
    if (info === 'json' && Buffer.byteLength(block, 'utf8') <= input.maxBlockBytes) {
      blocks.push(block);
    }

    searchFrom = fenceEnd + 3;
  }

  return blocks;
}

function formatBudgetExceeded(input: {
  current: number;
  envKey: string;
  limit: number;
  limitName: string;
  operation: string;
}): string {
  return [
    `budget_exceeded: ${input.limitName}`,
    `operation=${input.operation}`,
    `current=${String(input.current)}`,
    `limit=${String(input.limit)}`,
    `env=${input.envKey}.`,
    `Close existing agents or raise ${input.envKey} for this parent session.`,
  ].join(' ');
}

function isActiveBudgetStatus(status: SubagentStatus): boolean {
  return status === 'idle' || status === 'in_progress';
}

function isExternallyFinalizedStatus(status: SubagentStatus): status is 'closed' {
  return status === 'closed';
}

function isLockHeldError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return (error as { code?: unknown }).code === 'ELOCKED';
}

function isReadOnlyPathError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isWaitTerminalStatus(status: SubagentStatus): boolean {
  return status === 'closed' || status === 'completed' || status === 'error';
}

function logSubagentAuditEvent(event: string, fields: Record<string, boolean | number | string | undefined>): void {
  const payload: Record<string, boolean | number | string> = {
    event,
    plugin: 'ai-subagent',
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  process.stderr.write(`[ai-subagent] ${JSON.stringify(payload)}\n`);
}

function markSubagentClosed(input: { agent: ManagedSubagent; dependencies: SubagentServiceDependencies }): void {
  input.agent.queuedTurns.length = 0;
  delete input.agent.record.error;
  delete input.agent.record.backendSessionId;
  delete input.agent.record.providerTerminalStatus;
  input.agent.record.cleanupOutcome = 'succeeded';
  input.agent.record.status = 'closed';
  input.agent.record.terminalCause = 'closed';
  input.agent.record.terminalOwner = 'parent';
  input.agent.record.lastActivityAt = input.dependencies.now();
  input.dependencies.registry.upsert(input.agent.record);
}

function markSubagentClosing(input: {
  agent: ManagedSubagent;
  dependencies: SubagentServiceDependencies;
  operation: 'close_agent' | 'dispose';
}): void {
  input.agent.queuedTurns.length = 0;
  if (input.operation === 'dispose') {
    input.agent.suspended = true;
  }
  if (input.agent.activeTurn !== undefined) {
    input.agent.activeTurn.terminalOverride =
      input.operation === 'dispose'
        ? { terminalCause: 'host_shutdown', terminalOwner: 'runtime' }
        : { terminalCause: 'closed', terminalOwner: 'parent' };
  }
  delete input.agent.record.cleanupOutcome;
  delete input.agent.record.error;
  delete input.agent.record.providerTerminalStatus;
  input.agent.record.status = 'closed';
  input.agent.record.terminalCause = input.operation === 'dispose' ? 'host_shutdown' : 'closed';
  input.agent.record.terminalOwner = input.operation === 'dispose' ? 'runtime' : 'parent';
  input.agent.record.lastActivityAt = input.dependencies.now();
  try {
    input.dependencies.registry.upsert(input.agent.record);
  } catch {
    emitRegistryPersistFailure({
      agent: input.agent,
      dependencies: input.dependencies,
      operation: input.operation,
      terminalOutcome: 'closing_persist_failed',
    });
  }
}

function markSubagentSuspended(input: { agent: ManagedSubagent; dependencies: SubagentServiceDependencies }): void {
  input.agent.queuedTurns.length = 0;
  input.agent.suspended = true;
  captureBackendSessionId(input.agent);
  delete input.agent.record.error;
  delete input.agent.record.providerTerminalStatus;
  input.agent.record.cleanupOutcome = 'succeeded';
  input.agent.record.status = 'idle';
  input.agent.record.terminalCause = 'host_shutdown';
  input.agent.record.terminalOwner = 'runtime';
  input.agent.record.lastActivityAt = input.dependencies.now();
  input.dependencies.registry.upsert(input.agent.record);
}

function normalizeEvidence(value: unknown): SubagentStructuredSummary['evidence'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const green = readStringArray(record.green);
  const red = readStringArray(record.red);
  const evidence = {
    ...(green !== undefined ? { green } : {}),
    ...(red !== undefined ? { red } : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function normalizeStructuredSummary(value: unknown): SubagentStructuredSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const terminalStatus = readBoundedString(record.terminalStatus ?? record.terminal_status);
  if (terminalStatus === undefined) {
    return undefined;
  }
  const changedFiles = readStringArray(record.changedFiles ?? record.changed_files);
  const commands = readStringArray(record.commands);
  const concerns = readStringArray(record.concerns);
  const evidence = normalizeEvidence(record.evidence);
  const summary: SubagentStructuredSummary = {
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(concerns !== undefined ? { concerns } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    terminalStatus,
  };
  return summary;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return 60_000;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('invalid_timeout_ms: timeout_ms must be a non-negative finite number.');
  }
  return Math.trunc(timeoutMs);
}

function parseCurrentDepth(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function parseEnvCountBudget(input: {
  defaultValue: number;
  env: NodeJS.ProcessEnv;
  key:
    | 'AI_SUBAGENT_MAX_ACTIVE_AGENTS'
    | 'AI_SUBAGENT_MAX_DEPTH'
    | 'AI_SUBAGENT_MAX_LIFECYCLE_CALLS'
    | 'AI_SUBAGENT_MAX_OUTPUT_BYTES'
    | 'AI_SUBAGENT_MAX_QUEUED_TURNS_PER_AGENT'
    | 'AI_SUBAGENT_MAX_SPAWNED_AGENTS';
  maxValue: number;
}): number {
  const raw = input.env[input.key];
  if (raw === undefined || raw.trim().length === 0) {
    return input.defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > input.maxValue) {
    return input.defaultValue;
  }
  return parsed;
}

function parseStructuredSummary(input: { maxBlockBytes: number; text: string }): SubagentStructuredSummary | undefined {
  const blocks = extractFencedJsonBlocks(input);
  const candidates = [...blocks].reverse();
  for (const candidate of candidates) {
    if (candidate.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const summary = normalizeStructuredSummary(parsed);
      if (summary !== undefined) {
        return summary;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function prepareContainedTranscriptDirectory(input: { directoryPath: string; rootPath: string }): string {
  const normalizedRoot = resolve(input.rootPath);
  const normalizedDirectory = resolve(input.directoryPath);
  const relativeDirectory = relative(normalizedRoot, normalizedDirectory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory === '..' ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new UnsafeTranscriptPathError();
  }

  const canonicalRoot = realpathSync(normalizedRoot);
  let currentDirectory = canonicalRoot;
  const components = relativeDirectory.split(sep);
  for (const [index, component] of components.entries()) {
    const candidate = resolve(currentDirectory, component);
    if (existsSync(candidate)) {
      const candidateStat = lstatSync(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new UnsafeTranscriptPathError();
      }
    } else {
      mkdirSync(candidate, { mode: 0o700 });
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY);
      const directoryStat = fstatSync(descriptor);
      if (
        !directoryStat.isDirectory() ||
        (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())
      ) {
        throw new UnsafeTranscriptPathError();
      }
      if (index === components.length - 1) {
        fchmodSync(descriptor, 0o700);
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new UnsafeTranscriptPathError();
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
    }
    currentDirectory = realpathSync(candidate);
    assertPathWithinRoot(canonicalRoot, currentDirectory);
  }
  return currentDirectory;
}

function prepareSubagentTranscriptPath(input: {
  env: Record<string, string>;
  id: string;
  projectRoot: string;
}): string {
  const projectPath = subagentTranscriptPath(input);
  try {
    return ensureReadableTranscriptPath({ projectRoot: input.projectRoot, transcriptPath: projectPath });
  } catch (error) {
    if (!isReadOnlyPathError(error) && !(error instanceof UnsafeTranscriptPathError)) {
      throw error;
    }
  }

  const home = asNonEmptyString(input.env.HOME) ?? homedir();
  const localPath = resolve(home, '.local', 'share', 'ai-subagent', 'transcripts', `ai-subagent-${input.id}.log`);
  return ensureReadableTranscriptPath({ projectRoot: home, transcriptPath: localPath });
}

function processOutcomeTelemetry(outcome: SubagentProcessOutcome | undefined): Partial<SubagentTelemetryEvent> {
  if (outcome === undefined) {
    return {};
  }
  return {
    processCompletionMs: outcome.completionMs,
    processExitCode: outcome.exitCode,
    ...(outcome.firstActivityMs !== undefined ? { processFirstActivityMs: outcome.firstActivityMs } : {}),
    ...(outcome.lastActivityMs !== undefined ? { processLastActivityMs: outcome.lastActivityMs } : {}),
    processReceivedBytes: outcome.receivedBytes,
    processSignal: outcome.signal,
    processStderrBytes: outcome.stderrBytes,
    processStdoutBytes: outcome.stdoutBytes,
    ...(outcome.structuredOutput !== undefined ? { structuredOutput: outcome.structuredOutput } : {}),
  };
}

function projectIdentifier(projectRoot: string): string {
  const name = basename(projectRoot);
  return name.length > 0 ? name : projectRoot;
}

function providerForModel(modelId: string): string {
  const policy = getModelPolicyEntry(modelId);
  return policy?.launch?.provider.id ?? policy?.family ?? 'unknown';
}

function purposeForRole(role: SubagentType): string {
  if (role === 'builder') {
    return 'Scoped code implementation';
  }
  if (role === 'reviewer') {
    return 'Read-only code or design review';
  }
  if (role === 'ask') {
    return 'Read-only design question';
  }
  return 'Bounded delegated task';
}

function readBoundedString(value: unknown): string | undefined {
  const string = asNonEmptyString(value);
  if (string === undefined) {
    return undefined;
  }
  return truncateUtf8(string, MAX_STRUCTURED_SUMMARY_STRING_BYTES);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings: string[] = [];
  for (const item of value) {
    const string = readBoundedString(item);
    if (string !== undefined) {
      strings.push(string);
    }
    if (strings.length >= MAX_STRUCTURED_SUMMARY_ARRAY_ITEMS) {
      break;
    }
  }
  return strings.length > 0 ? strings : undefined;
}

function recordActiveTurnActivity(input: { activity: AgentSessionActivity; agent: ManagedSubagent }): void {
  const activeTurn = input.agent.activeTurn;
  if (activeTurn === undefined || input.agent.record.status !== 'in_progress') {
    return;
  }
  activeTurn.activityCount += 1;
  const activityAtMs = input.agent.clock();
  activeTurn.firstActivityAtMs ??= activityAtMs;
  activeTurn.lastActivityAtMs = activityAtMs;
  activeTurn.receivedBytes += input.activity.bytes;
}

function recordActiveTurnProcessOutcome(input: { agent: ManagedSubagent; outcome: AgentSessionProcessOutcome }): void {
  const activeTurn = input.agent.activeTurn;
  if (activeTurn === undefined || input.agent.record.status !== 'in_progress') {
    return;
  }
  const outcome: SubagentProcessOutcome = { ...input.outcome };
  activeTurn.processOutcome = outcome;
  input.agent.record.processOutcome = outcome;
}

function recordActiveTurnTokenUsage(input: { agent: ManagedSubagent; usage: TokenUsage }): void {
  const activeTurn = input.agent.activeTurn;
  if (activeTurn === undefined || input.agent.record.status !== 'in_progress') {
    return;
  }
  activeTurn.tokenUsage = input.usage;
  recordTokenUsage(input.agent.record, input.usage);
}

function recordBudgetRejected(input: {
  agent?: PersistedSubagentRecord;
  current: number;
  dependencies: SubagentServiceDependencies;
  envKey: string;
  errorMessage: string;
  limit: number;
  limitName: string;
  operation: string;
}): void {
  input.dependencies.audit('budget_rejected', {
    current: input.current,
    envKey: input.envKey,
    limit: input.limit,
    limitName: input.limitName,
    operation: input.operation,
  });
  emitSubagentTelemetryEvent({
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    dependencies: input.dependencies,
    errorMessage: input.errorMessage,
    eventType: 'budget_rejected',
    operation: input.operation,
    status: 'error',
    values: {
      current: input.current,
      envKey: input.envKey,
      limit: input.limit,
      limitName: input.limitName,
    },
  });
}

function recordLifecycleCall(input: {
  agent?: PersistedSubagentRecord;
  dependencies: SubagentServiceDependencies;
  ledger: SubagentBudgetLedger;
  limit: number;
  operation: string;
}): void {
  if (input.ledger.lifecycleCalls >= input.limit) {
    throwBudgetExceeded({
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      current: input.ledger.lifecycleCalls,
      dependencies: input.dependencies,
      envKey: 'AI_SUBAGENT_MAX_LIFECYCLE_CALLS',
      limit: input.limit,
      limitName: 'max_lifecycle_calls',
      operation: input.operation,
    });
  }
  input.ledger.lifecycleCalls += 1;
}

function recordTokenUsage(record: PersistedSubagentRecord, usage: TokenUsage): void {
  if (usage.attributionSource === 'provider-event') {
    record.attributionSource = 'provider-event';
    if (usage.effectiveModelId !== undefined) {
      record.hostEffectiveModelId = usage.effectiveModelId;
    }
    if (usage.providerId !== undefined) {
      record.effectiveProvider = usage.providerId;
    }
    if (usage.reasoningEffort !== undefined) {
      record.hostEffectiveReasoningEffort = usage.reasoningEffort;
    }
  }
  if (usage.provider === undefined) {
    return;
  }
  if (usage.provider.inputTokens !== undefined) {
    record.totalInputTokens = (record.totalInputTokens ?? 0) + usage.provider.inputTokens;
  }
  if (usage.provider.outputTokens !== undefined) {
    record.totalOutputTokens = (record.totalOutputTokens ?? 0) + usage.provider.outputTokens;
  }
  if (usage.provider.totalTokens !== undefined) {
    record.totalTokens = (record.totalTokens ?? 0) + usage.provider.totalTokens;
  }
  const cachedInputTokens =
    (usage.provider.cachedInputTokens ?? 0) +
    (usage.provider.cacheCreationInputTokens ?? 0) +
    (usage.provider.cacheReadInputTokens ?? 0);
  if (cachedInputTokens > 0) {
    record.totalCachedInputTokens = (record.totalCachedInputTokens ?? 0) + cachedInputTokens;
  }
  if (usage.provider.reasoningOutputTokens !== undefined) {
    record.totalReasoningOutputTokens = (record.totalReasoningOutputTokens ?? 0) + usage.provider.reasoningOutputTokens;
  }
}

function renderItem(item: unknown): string {
  if (typeof item === 'string') {
    return item;
  }
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (typeof record.content === 'string') {
      return record.content;
    }
  }
  return JSON.stringify(item);
}

function renderMessageInput(input: { items?: unknown[]; message?: string }): string {
  const rendered = renderOptionalMessageInput(input);
  if (rendered === undefined) {
    throw new Error('message_required: provide message or items.');
  }
  return rendered;
}

function renderOptionalMessageInput(input: { items?: unknown[]; message?: string }): string | undefined {
  const message = input.message?.trim();
  if (message !== undefined && message.length > 0) {
    return message;
  }
  if (input.items === undefined || input.items.length === 0) {
    return undefined;
  }
  return input.items.map(renderItem).join('\n\n').trim();
}

function requireOpenAgent(input: {
  agents: Map<string, ManagedSubagent>;
  id: string;
  registry?: SubagentRegistry;
}): ManagedSubagent {
  const { agents, id, registry } = input;
  const agent = agents.get(id);
  if (agent === undefined) {
    const record = registry?.get(id);
    if (record?.status === 'closed') {
      throw typedError('agent_closed', id);
    }
    throw typedError('agent_not_found', id);
  }
  if (agent.record.status === 'closed') {
    throw typedError('agent_closed', id);
  }
  return agent;
}

function resolveBudgetLimits(env: NodeJS.ProcessEnv): SubagentBudgetLimits {
  return {
    maxActiveAgents: parseEnvCountBudget({
      defaultValue: DEFAULT_SUBAGENT_MAX_ACTIVE_AGENTS,
      env,
      key: 'AI_SUBAGENT_MAX_ACTIVE_AGENTS',
      maxValue: MAX_SUBAGENT_BUDGET_COUNT,
    }),
    maxDepth: parseEnvCountBudget({
      defaultValue: DEFAULT_SUBAGENT_MAX_DEPTH,
      env,
      key: 'AI_SUBAGENT_MAX_DEPTH',
      maxValue: MAX_SUBAGENT_BUDGET_COUNT,
    }),
    maxLifecycleCalls: parseEnvCountBudget({
      defaultValue: DEFAULT_SUBAGENT_MAX_LIFECYCLE_CALLS,
      env,
      key: 'AI_SUBAGENT_MAX_LIFECYCLE_CALLS',
      maxValue: MAX_SUBAGENT_BUDGET_COUNT,
    }),
    maxOutputBytes: parseEnvCountBudget({
      defaultValue: DEFAULT_SUBAGENT_MAX_OUTPUT_BYTES,
      env,
      key: 'AI_SUBAGENT_MAX_OUTPUT_BYTES',
      maxValue: MAX_SUBAGENT_OUTPUT_BYTES,
    }),
    maxQueuedTurnsPerAgent: parseEnvCountBudget({
      defaultValue: DEFAULT_SUBAGENT_MAX_QUEUED_TURNS_PER_AGENT,
      env,
      key: 'AI_SUBAGENT_MAX_QUEUED_TURNS_PER_AGENT',
      maxValue: MAX_SUBAGENT_BUDGET_COUNT,
    }),
    maxSpawnedAgents: parseEnvCountBudget({
      defaultValue: DEFAULT_SUBAGENT_MAX_SPAWNED_AGENTS,
      env,
      key: 'AI_SUBAGENT_MAX_SPAWNED_AGENTS',
      maxValue: MAX_SUBAGENT_BUDGET_COUNT,
    }),
  };
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function stableErrorProperty(error: unknown, key: 'code' | 'terminalStatus'): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 80 || !/^[\w.:-]+$/u.test(value)) {
    return undefined;
  }
  return value;
}

function startNextQueuedTurn(input: { agent: ManagedSubagent; dependencies: SubagentServiceDependencies }): void {
  if (
    input.agent.activeTurn !== undefined ||
    input.agent.suspended === true ||
    isExternallyFinalizedStatus(input.agent.record.status)
  ) {
    return;
  }
  const next = input.agent.queuedTurns.shift();
  if (next !== undefined) {
    startTurn({ agent: input.agent, dependencies: input.dependencies, ...next });
  }
}

function startTurn(input: {
  agent: ManagedSubagent;
  capabilitiesUsed?: string[];
  dependencies: SubagentServiceDependencies;
  maxOutputBytes: number;
  message: string;
  operation: string;
}): void {
  const { agent, dependencies, message } = input;
  if (agent.activeTurn !== undefined && agent.record.status === 'in_progress') {
    throw typedError('agent_busy', agent.record.id);
  }

  agent.record.status = 'in_progress';
  delete agent.record.error;
  clearTerminalMetadata(agent.record);
  delete agent.lastOutput;
  agent.record.lastActivityAt = dependencies.now();
  const startedAt = agent.record.lastActivityAt;
  dependencies.registry.upsert(agent.record);

  const activeTurn: ActiveTurn = {
    activityCount: 0,
    lastActivityAtMs: startedAt,
    polls: 0,
    promise: Promise.resolve({ status: 'closed' }),
    receivedBytes: 0,
    startedAtMs: startedAt,
  };
  agent.activeTurn = activeTurn;
  activeTurn.promise = agent.session
    .send(message)
    .then(output => {
      if (agent.suspended === true || isExternallyFinalizedStatus(agent.record.status)) {
        return {
          error: agent.suspended === true ? 'host_shutdown' : agent.record.status,
          status: 'closed' as const,
        };
      }
      agent.lastOutput = createSubagentOutput({
        agent,
        dependencies,
        maxOutputBytes: input.maxOutputBytes,
        text: output,
      });
      agent.record.status = 'completed';
      agent.record.cleanupOutcome = 'not_required';
      agent.record.terminalCause = 'completed';
      agent.record.terminalOwner = 'provider';
      delete agent.record.error;
      const completedAt = dependencies.now();
      agent.record.lastActivityAt = completedAt;
      captureBackendSessionId(agent);
      dependencies.registry.upsert(agent.record);
      emitSubagentTelemetryEvent({
        agent: agent.record,
        dependencies,
        eventType: 'turn_completed',
        operation: input.operation,
        status: 'ok',
        values: {
          attributionSource: agent.record.attributionSource ?? 'exact-launch-contract',
          ...(input.capabilitiesUsed !== undefined ? { capabilitiesUsed: input.capabilitiesUsed } : {}),
          elapsedMs: Math.max(0, completedAt - activeTurn.startedAtMs),
          outputBytes: agent.lastOutput.bytes,
          outputTruncated: agent.lastOutput.truncated,
          pollCount: activeTurn.polls,
          resultBytes: agent.lastOutput.bytes,
          resultTruncated: agent.lastOutput.truncated,
          ...processOutcomeTelemetry(activeTurn.processOutcome),
          terminalOutcome: 'completed',
          ...(agent.lastOutput.structured?.terminalStatus !== undefined
            ? { terminalStatus: agent.lastOutput.structured.terminalStatus }
            : {}),
          transcriptRef: agent.lastOutput.ref,
          ...turnUsageTelemetry(activeTurn.tokenUsage),
          ...verificationTelemetry(agent.lastOutput.structured),
          waitMs: Math.max(0, completedAt - activeTurn.startedAtMs),
        },
      });
      return { output, status: 'completed' as const };
    })
    .catch((error: unknown) => {
      const terminal = activeTurn.terminalOverride ?? classifyTerminalError(error);
      const messageText = error instanceof Error ? error.message : String(error);
      const status = 'error' as const;
      if (agent.suspended === true || isExternallyFinalizedStatus(agent.record.status)) {
        return {
          error: agent.suspended === true ? 'host_shutdown' : agent.record.status,
          status: 'closed' as const,
        };
      }
      agent.record.error = messageText;
      agent.record.cleanupOutcome = terminal.terminalCause.endsWith('_cleanup_failed') ? 'failed' : 'not_required';
      agent.record.terminalCause = terminal.terminalCause;
      agent.record.terminalOwner = terminal.terminalOwner;
      if (terminal.providerTerminalStatus === undefined) {
        delete agent.record.providerTerminalStatus;
      } else {
        agent.record.providerTerminalStatus = terminal.providerTerminalStatus;
      }
      agent.record.status = status;
      // The provider body stays opaque, but retain the safe local log ref.
      agent.lastOutput = createSubagentOutput({
        agent,
        dependencies,
        maxOutputBytes: input.maxOutputBytes,
        text: '',
      });
      const completedAt = dependencies.now();
      agent.record.lastActivityAt = completedAt;
      captureBackendSessionId(agent);
      dependencies.registry.upsert(agent.record);
      emitSubagentTelemetryEvent({
        agent: agent.record,
        dependencies,
        errorMessage: messageText,
        eventType: 'turn_failed',
        operation: input.operation,
        status: 'error',
        values: {
          attributionSource: agent.record.attributionSource ?? 'exact-launch-contract',
          ...(input.capabilitiesUsed !== undefined ? { capabilitiesUsed: input.capabilitiesUsed } : {}),
          elapsedMs: Math.max(0, completedAt - activeTurn.startedAtMs),
          pollCount: activeTurn.polls,
          ...(terminal.providerTerminalStatus !== undefined
            ? { providerTerminalStatus: terminal.providerTerminalStatus }
            : {}),
          ...processOutcomeTelemetry(activeTurn.processOutcome),
          terminalOutcome: status,
          transcriptRef: agent.lastOutput.ref,
          ...turnUsageTelemetry(activeTurn.tokenUsage),
          waitMs: Math.max(0, completedAt - activeTurn.startedAtMs),
        },
      });
      return { error: messageText, status };
    })
    .finally(() => {
      if (agent.activeTurn === activeTurn) {
        delete agent.activeTurn;
        startNextQueuedTurn({ agent, dependencies });
      }
    });
}

function subagentTranscriptPath(input: { id: string; projectRoot: string }): string {
  return resolve(input.projectRoot, '.ai', 'logs', `ai-subagent-${input.id}.log`);
}

function summarize(agent: ManagedSubagent, options: { includeOutput?: boolean } = {}): SubagentSummary {
  const output = summarizeOutput({ agent, includeOutput: options.includeOutput === true });
  const progress = summarizeProgress(agent);
  return {
    agentType: agent.record.agentType,
    ...summarizeAttribution(agent.record),
    ...(agent.record.error !== undefined ? { error: agent.record.error } : {}),
    ...(agent.record.cleanupOutcome !== undefined ? { cleanupOutcome: agent.record.cleanupOutcome } : {}),
    id: agent.record.id,
    model: agent.record.model,
    modelId: agent.record.modelId,
    ...output,
    ...(agent.record.processOutcome !== undefined ? { processOutcome: agent.record.processOutcome } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(agent.record.providerTerminalStatus !== undefined
      ? { providerTerminalStatus: agent.record.providerTerminalStatus }
      : {}),
    ...(agent.record.reasoningEffort !== undefined ? { reasoningEffort: agent.record.reasoningEffort } : {}),
    ...(agent.record.requestedModelId !== undefined ? { requestedModelId: agent.record.requestedModelId } : {}),
    ...(agent.record.requestedReasoningEffort !== undefined
      ? { requestedReasoningEffort: agent.record.requestedReasoningEffort }
      : {}),
    status: agent.record.status,
    ...(agent.record.terminalCause !== undefined ? { terminalCause: agent.record.terminalCause } : {}),
    ...(agent.record.terminalOwner !== undefined ? { terminalOwner: agent.record.terminalOwner } : {}),
  };
}

function summarizeAttribution(
  record: PersistedSubagentRecord,
): Pick<SubagentSummary, 'attributionSource' | 'effectiveModelId' | 'effectiveProvider' | 'effectiveReasoningEffort'> {
  const attributionSource = record.attributionSource ?? 'exact-launch-contract';
  const launchContract = attributionSource === 'exact-launch-contract';
  const effectiveModelId = record.hostEffectiveModelId ?? (launchContract ? record.modelId : undefined);
  const effectiveProvider = record.effectiveProvider ?? (launchContract ? providerForModel(record.modelId) : undefined);
  const effectiveReasoningEffort =
    record.hostEffectiveReasoningEffort ??
    (launchContract && record.reasoningEffort !== undefined ? record.reasoningEffort : undefined);
  return {
    attributionSource,
    ...(effectiveModelId !== undefined ? { effectiveModelId } : {}),
    ...(effectiveProvider !== undefined ? { effectiveProvider } : {}),
    ...(effectiveReasoningEffort !== undefined ? { effectiveReasoningEffort } : {}),
  };
}

function summarizeOutput(input: { agent: ManagedSubagent; includeOutput: boolean }): Partial<SubagentSummary> {
  const output = input.agent.lastOutput;
  if (output === undefined) {
    return {};
  }
  let outputConsumed = output.consumed;
  const result: Partial<SubagentSummary> = {
    outputBytes: output.bytes,
    outputConsumed,
    outputRef: output.ref,
    outputTruncated: output.truncated,
    ...(output.structured !== undefined ? { structured: output.structured } : {}),
    summarySource: output.summarySource,
  };
  if (input.includeOutput && !output.consumed) {
    output.consumed = true;
    outputConsumed = true;
    result.output = output.text;
    result.outputConsumed = outputConsumed;
  }
  return result;
}

function summarizeProgress(agent: ManagedSubagent): SubagentProgress | undefined {
  const activeTurn = agent.activeTurn;
  if (activeTurn === undefined || agent.record.status !== 'in_progress') {
    return undefined;
  }
  const observedAtMs = agent.clock();
  return {
    activityCount: activeTurn.activityCount,
    elapsedMs: Math.max(0, observedAtMs - activeTurn.startedAtMs),
    ...(activeTurn.firstActivityAtMs !== undefined ? { firstActivityAtMs: activeTurn.firstActivityAtMs } : {}),
    idleMs: Math.max(0, observedAtMs - activeTurn.lastActivityAtMs),
    lastActivityAtMs: activeTurn.lastActivityAtMs,
    receivedBytes: activeTurn.receivedBytes,
    startedAtMs: activeTurn.startedAtMs,
  };
}

function summarizeRecord(record: PersistedSubagentRecord): SubagentSummary {
  return {
    agentType: record.agentType,
    ...summarizeAttribution(record),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.cleanupOutcome !== undefined ? { cleanupOutcome: record.cleanupOutcome } : {}),
    id: record.id,
    model: record.model,
    modelId: record.modelId,
    ...(record.processOutcome !== undefined ? { processOutcome: record.processOutcome } : {}),
    ...(record.providerTerminalStatus !== undefined ? { providerTerminalStatus: record.providerTerminalStatus } : {}),
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(record.requestedModelId !== undefined ? { requestedModelId: record.requestedModelId } : {}),
    ...(record.requestedReasoningEffort !== undefined
      ? { requestedReasoningEffort: record.requestedReasoningEffort }
      : {}),
    status: record.status,
    ...(record.terminalCause !== undefined ? { terminalCause: record.terminalCause } : {}),
    ...(record.terminalOwner !== undefined ? { terminalOwner: record.terminalOwner } : {}),
  };
}

async function suspendManagedSubagent(agent: ManagedSubagent): Promise<void> {
  try {
    await agent.session.suspend();
  } finally {
    await agent.runtimeIsolation.cleanup();
  }
}

function telemetryFieldsForRecord(record: PersistedSubagentRecord): Partial<SubagentTelemetryEvent> {
  const resolvedProvider = providerForModel(record.modelId);
  return {
    agentId: record.id,
    agentType: record.agentType,
    ...(record.backendSessionId !== undefined ? { backendSessionId: record.backendSessionId } : {}),
    ...(record.cleanupOutcome !== undefined ? { cleanupOutcome: record.cleanupOutcome } : {}),
    attributionSource: record.attributionSource ?? 'exact-launch-contract',
    ...(record.hostEffectiveModelId !== undefined ? { effectiveModelId: record.hostEffectiveModelId } : {}),
    ...(record.effectiveProvider !== undefined ? { effectiveProvider: record.effectiveProvider } : {}),
    ...(record.hostEffectiveModelId !== undefined ? { hostEffectiveModelId: record.hostEffectiveModelId } : {}),
    model: record.model,
    modelId: record.modelId,
    ...processOutcomeTelemetry(record.processOutcome),
    ...(record.providerTerminalStatus !== undefined ? { providerTerminalStatus: record.providerTerminalStatus } : {}),
    ...(record.hostEffectiveReasoningEffort !== undefined
      ? { effectiveReasoningEffort: record.hostEffectiveReasoningEffort }
      : {}),
    project: projectIdentifier(record.projectRoot),
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(record.requestedModelId !== undefined ? { requestedModelId: record.requestedModelId } : {}),
    requestedProvider: resolvedProvider,
    ...(record.requestedReasoningEffort !== undefined
      ? { requestedReasoningEffort: record.requestedReasoningEffort }
      : {}),
    resolvedModelId: record.modelId,
    resolvedProvider,
    ...(record.reasoningEffort !== undefined ? { resolvedReasoningEffort: record.reasoningEffort } : {}),
    ...(record.selectedSkillDigests !== undefined ? { selectedSkillDigests: record.selectedSkillDigests } : {}),
    ...(record.selectedSkills !== undefined ? { selectedSkills: record.selectedSkills } : {}),
    ...(record.totalCachedInputTokens !== undefined ? { totalCachedInputTokens: record.totalCachedInputTokens } : {}),
    ...(record.totalInputTokens !== undefined ? { totalInputTokens: record.totalInputTokens } : {}),
    ...(record.totalOutputTokens !== undefined ? { totalOutputTokens: record.totalOutputTokens } : {}),
    ...(record.totalReasoningOutputTokens !== undefined
      ? { totalReasoningOutputTokens: record.totalReasoningOutputTokens }
      : {}),
    ...(record.totalTokens !== undefined ? { totalTokens: record.totalTokens } : {}),
    ...(record.terminalCause !== undefined ? { terminalCause: record.terminalCause } : {}),
    ...(record.terminalOwner !== undefined ? { terminalOwner: record.terminalOwner } : {}),
  };
}

function throwBudgetExceeded(input: {
  agent?: PersistedSubagentRecord;
  current: number;
  dependencies: SubagentServiceDependencies;
  envKey: string;
  limit: number;
  limitName: string;
  operation: string;
}): never {
  const message = formatBudgetExceeded(input);
  recordBudgetRejected({
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    current: input.current,
    dependencies: input.dependencies,
    envKey: input.envKey,
    errorMessage: message,
    limit: input.limit,
    limitName: input.limitName,
    operation: input.operation,
  });
  throw new Error(message);
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

function turnUsageTelemetry(usage: TokenUsage | undefined): Partial<SubagentTelemetryEvent> {
  if (usage?.provider === undefined) {
    return { turnUsageReported: false };
  }
  const provider = usage.provider;
  const hasCachedInputTokens =
    provider.cachedInputTokens !== undefined ||
    provider.cacheCreationInputTokens !== undefined ||
    provider.cacheReadInputTokens !== undefined;
  const cachedInputTokens =
    (provider.cachedInputTokens ?? 0) + (provider.cacheCreationInputTokens ?? 0) + (provider.cacheReadInputTokens ?? 0);
  return {
    ...(hasCachedInputTokens ? { turnCachedInputTokens: cachedInputTokens } : {}),
    ...(provider.inputTokens !== undefined ? { turnInputTokens: provider.inputTokens } : {}),
    ...(provider.outputTokens !== undefined ? { turnOutputTokens: provider.outputTokens } : {}),
    ...(provider.reasoningOutputTokens !== undefined
      ? { turnReasoningOutputTokens: provider.reasoningOutputTokens }
      : {}),
    ...(provider.totalTokens !== undefined ? { turnTokens: provider.totalTokens } : {}),
    turnUsageReported: true,
  };
}

function typedError(code: string, id: string): Error {
  return new Error(`${code}: ${id}`);
}

function verificationTelemetry(
  structured: SubagentStructuredSummary | undefined,
): Pick<SubagentTelemetryEvent, 'verificationGreenCount' | 'verificationRedCount' | 'verificationStatus'> {
  const verificationGreenCount = structured?.evidence?.green?.length ?? 0;
  const verificationRedCount = structured?.evidence?.red?.length ?? 0;
  let verificationStatus: 'failed' | 'not_reported' | 'passed' = 'not_reported';
  if (verificationRedCount > 0) {
    verificationStatus = 'failed';
  } else if (verificationGreenCount > 0) {
    verificationStatus = 'passed';
  }
  return {
    verificationGreenCount,
    verificationRedCount,
    verificationStatus,
  };
}
