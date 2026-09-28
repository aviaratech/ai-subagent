/**
 * API types for the ai package.
 *
 * These types define the programmatic interface for launching AI agents.
 * Callers contribute context arrays that get concatenated at this layer.
 *
 * @module api/types
 */

import type { ChildProcess } from 'node:child_process';

import type { AgentModelName as CanonicalAgentModel } from '../shared/agentConstants.js';
import type { ContextSection } from '../shared/context.js';

/**
 * CLI behavior options for agent launch.
 *
 * **Note:** Agents always run in automation mode. By default, automation runs
 * in autonomous mode (bypass permissions/sandbox where supported). Set
 * `AI_AUTONOMY_MODE=0` to disable default autonomy. Passing `sandbox:
 * 'workspace-write'` or `sandbox: 'read-only'` requests a non-bypass launch.
 * Additional behavior options will be wired to CLI flags in a future release.
 *
 * @experimental These options may change in future versions.
 */
export interface AgentLaunchBehaviorOptions {
  /**
   * Sandbox mode for file system access.
   * - 'read-only': No writes
   * - 'workspace-write': Allow writes only to workspace
   * - 'off': No sandbox restrictions
   *
   * @experimental Launchers use this as an autonomy hint. `'off'` prefers
   * bypass flags; `'workspace-write'` and `'read-only'` suppress default
   * bypass behavior.
   */
  sandbox?: 'off' | 'read-only' | 'workspace-write';
}

/**
 * Cancellation metadata attached to a launch result when the spawned CLI
 * was actively terminated by the launcher (rather than exiting on its own).
 *
 * - `idle_timeout`: spawn produced no stdout AND no stderr output for
 *   {@link AgentLaunchOptions.idleTimeoutMs}. SIGTERM + 5s grace SIGKILL.
 * - `max_duration`: spawn exceeded {@link AgentLaunchOptions.maxDurationMs}.
 *   SIGTERM + 5s grace SIGKILL.
 * - `aborted`: external {@link AgentLaunchOptions.signal} fired.
 *   SIGTERM + 5s grace SIGKILL.
 *
 * `exitCode` is set to 124 for any of these conditions, so consumers should
 * read `cancellation.reason` rather than the numeric code to distinguish.
 */
export interface AgentLaunchCancellation {
  reason: 'aborted' | 'idle_timeout' | 'max_duration';
}

/**
 * Options for launching an AI agent.
 *
 * Context arrays from callers are passed here.
 * The ai package prepends its own base context (AGENTS.md, role preambles) and
 * concatenates everything into the final prompt sent to the agent CLI.
 */
export interface AgentLaunchOptions {
  /**
   * Pre-serialized JSON for custom agent definitions.
   * Claude: maps to --agents flag.
   * Other providers: ignored in v1.
   */
  agentsJson?: string;

  /**
   * Tool allowlist for the agent session.
   * Claude: maps to --allowedTools flag (comma-joined).
   * Other providers: ignored in v1.
   */
  allowedTools?: string[];

  /**
   * Existing restricted Codex home to use for GPT strict-MCP launches.
   * Callers that need multiple Codex invocations to share thread rollout state
   * within one logical turn create this once, pass the path on each launch, and
   * own cleanup after the turn completes.
   *
   * Ignored for non-GPT launches and when strict MCP config is not requested.
   */
  codexRestrictedHome?: string;

  /**
   * Context array from calling layers.
   * Each section is rendered as a markdown heading plus body.
   * The ai package prepends its own base content (AGENTS.md, role preambles).
   */
  context?: ContextSection[];

  /**
   * Environment variables to pass to the agent process.
   */
  env?: Record<string, string>;

  /**
   * Idle timeout in milliseconds. When the spawned CLI produces no stdout
   * AND no stderr output for this duration, the process is terminated with
   * SIGTERM (and SIGKILL after a 5s grace period). Resets on every output
   * chunk. Useful for actively aborting builder turns whose underlying tool
   * call has hung waiting on a sentinel that will never arrive.
   *
   * Independent of {@link maxDurationMs}: both timers coexist. Defaults to
   * unset (no idle cancellation).
   */
  idleTimeoutMs?: number;

  /**
   * Optional lens name. The ai package loads the lens prompt from the catalog.
   */
  lens?: string;

  /**
   * Maximum duration in milliseconds for the agent to complete.
   * If exceeded, the agent process is terminated with a timeout error.
   * Useful for preventing reviewer loops from running too long.
   */
  maxDurationMs?: number;

  /**
   * Paths to MCP config JSON files to load for this session.
   * Claude: each entry maps to a --mcp-config flag.
   * Other providers: ignored in v1.
   * Ignored when runtimeMode is 'host-native'.
   */
  mcpConfig?: string[];

  /**
   * Model/agent to launch (determines which CLI to use).
   */
  model: AgentModel;

  /**
   * Exact registered model ID to pass to the CLI
   * (e.g., 'claude-fable-5[1m]', 'gpt-6-astra', 'grok-4.5').
   */
  modelId?: string;

  /**
   * Callback invoked for each line of agent stdout/stderr output.
   * When provided, output is routed through this callback instead of
   * being written directly to process.stdout/stderr.
   * Useful for Ink-based UIs where direct process.stdout.write bypasses
   * the rendering pipeline.
   */
  onOutputLine?: (line: string) => void;

  /**
   * Callback invoked for each raw stdout line before any filtering or
   * formatting. Unlike `onOutputLine`, this receives every line including
   * structured JSON events that would otherwise be suppressed.
   * Useful for telemetry capture and real-time progress summaries.
   */
  onRawOutputLine?: (line: string) => void;

  /**
   * CLI behavior options.
   */
  options?: AgentLaunchBehaviorOptions;

  /**
   * Prefix applied to streamed stdout/stderr lines when streamOutput is true.
   * Useful for distinguishing concurrent agent output in logs.
   */
  outputPrefix?: string;

  /**
   * Directories containing plugin bundles to load.
   * Claude: each entry maps to a --plugin-dir flag.
   * Other providers: ignored in v1.
   */
  pluginDirs?: string[];

  /**
   * Working directory for the agent.
   */
  projectRoot: string;

  /**
   * Agent role for context filtering (builder, reviewer).
   * When provided, the context is filtered to include only relevant sections.
   */
  role?: AgentRole;

  /**
   * Launch runtime mode.
   * When omitted, the launcher uses the default managed runtime behavior.
   */
  runtimeMode?: AgentRuntimeMode;

  /**
   * Session ID for resuming a previous session.
   * When provided, the agent continues from the previous session context.
   * Supported for Claude (--resume) and GPT (Codex exec resume).
   */
  sessionId?: string | undefined;

  /**
   * Optional AbortSignal for external cancellation of the spawn. When the
   * signal aborts, the underlying CLI process receives SIGTERM (and SIGKILL
   * after a 5s grace period). Useful for orchestrator-driven cancellation.
   */
  signal?: AbortSignal;

  /**
   * When false, suppress streaming of agent stdout/stderr to the console.
   * Defaults to true.
   */
  streamOutput?: boolean;

  /**
   * When true, restricts MCP servers to only those listed in mcpConfig.
   * Claude: maps to --strict-mcp-config flag.
   * Other providers: ignored in v1.
   * Ignored when runtimeMode is 'host-native'.
   */
  strictMcpConfig?: boolean;
}

/**
 * Result from a completed agent launch.
 */
export interface AgentLaunchResult {
  /**
   * Populated when the launcher actively cancelled the spawn. See
   * {@link AgentLaunchCancellation}.
   */
  cancellation?: AgentLaunchCancellation;

  /**
   * Exit code from the agent process.
   * 0 indicates success, non-zero indicates failure.
   */
  exitCode: number;

  /**
   * Combined output from the agent (stdout + stderr).
   * Only populated in automation mode.
   */
  output: string;

  /**
   * True when `output` is raw stdout fallback rather than parsed agent text.
   * This happens when the CLI produces no structured JSON events with agent
   * content — typically an initialization message like "Session loaded" instead
   * of actual work. Callers should treat outputFallback=true as a launch failure.
   */
  outputFallback?: boolean;

  /**
   * Full prompt sent to the agent (useful for telemetry).
   */
  prompt?: string;

  /**
   * Full unfiltered stdout output (NDJSON stream events) before text
   * extraction. Populated for CLI-based agents (Claude, GPT) when the
   * output format produces structured events. Useful for post-hoc retro
   * analysis and telemetry persistence.
   */
  rawOutput?: string;

  /**
   * Session ID for continuing the conversation in subsequent calls.
   * Captured from the agent's JSON output (e.g., Codex thread_id).
   * Pass this back as `sessionId` in the next call to resume the session.
   */
  sessionId?: string | undefined;

  /**
   * Optional token usage summary for this turn.
   * When available, total should equal input + output.
   *
   * Coarse source provenance:
   * - `'provider'`: Both input and output tokens are provider-reported.
   * - `'provider+estimated'`: One token field is provider-reported, the other is estimated.
   * - `'estimated'`: Both token fields are locally estimated (no provider data).
   *
   * Additional fidelity metadata:
   * - `provenance`: field-level source for input/output, with `'mixed'` reserved for
   *   aggregated transcripts that combine retries with different provenance.
   * - `trust.output`: additive signal for mixed-source provider-reported output counts.
   */
  tokens?: AgentLaunchTokenUsage;

  /**
   * Optional tool-call telemetry extracted from provider JSON events.
   * Helps distinguish pure reasoning turns from tool-heavy execution turns.
   */
  toolUsage?: {
    calls: number;
    outputs: number;
    tools?: string[];
  };
}

export interface AgentLaunchTokenUsage {
  input: number;
  output: number;
  provenance?: TokenUsageProvenance;
  provider?: ProviderTokenUsage;
  source: TokenUsageSource;
  total: number;
  trust?: {
    output?: TokenUsageOutputTrust;
  };
}

/**
 * Supported AI agent models.
 */
export type AgentModel = CanonicalAgentModel;

/**
 * Agent role type.
 */
export type AgentRole = 'builder' | 'reviewer';

/**
 * Runtime mode for nested launches.
 *
 * - 'managed': default launcher behavior with repo-managed wrapper / explicit Claude MCP flags
 * - 'host-native': use the host CLI the way a normal terminal launch would,
 *   bypassing the repo-managed Codex wrapper and ignoring explicit Claude
 *   MCP config flags in favor of the host's installed configuration
 */
export type AgentRuntimeMode = 'host-native' | 'managed';

/**
 * Active agent session for bidirectional communication.
 */
export interface AgentSession {
  /**
   * Clean up the session and terminate the agent process.
   */
  dispose(): Promise<void>;

  /** Provider-native lifecycle operations available to the session manager. */
  getCapabilities(): AgentSessionCapabilities;

  /**
   * Get the session ID for persistence.
   * Returns undefined if the session has not yet established an ID.
   */
  getSessionId(): string | undefined;

  /** Interrupt only the active turn while keeping the session reusable. */
  interrupt(): Promise<void>;

  /**
   * Check if the session is still active.
   */
  isAlive(): boolean;

  /**
   * Register a listener for session exit events.
   */
  onExit(listener: (code: null | number, signal: NodeJS.Signals | null) => void): void;

  /**
   * The underlying child process (if available).
   */
  process?: ChildProcess;

  /**
   * Send a message to the agent and wait for a response.
   * @param input The message to send
   * @returns The agent's response
   */
  send(input: string): Promise<string>;

  /**
   * Stop local execution and remove local artifacts without deleting a
   * provider-native session that can be rehydrated by a later host process.
   */
  suspend(): Promise<void>;
}

/**
 * Sanitized child-process stream activity for parent lifecycle monitoring.
 */
export interface AgentSessionActivity {
  bytes: number;
  source: 'stderr' | 'stdout';
}

export interface AgentSessionCapabilities {
  fork: boolean;
  interrupt: boolean;
  queue: boolean;
  resume: boolean;
}

export type AgentSessionEnvMode = 'inherit' | 'replace';

/**
 * Options for creating an agent session.
 *
 * Sessions provide bidirectional communication with an agent process,
 * allowing multiple message exchanges within a single context.
 */
export interface AgentSessionOptions {
  /**
   * CLI behavior options for session-backed agent turns.
   */
  behavior?: AgentLaunchBehaviorOptions;

  /**
   * Context array from calling layers.
   */
  context?: ContextSection[];

  /**
   * Environment variables to pass to the agent process.
   * Merged over `process.env` by default.
   */
  env?: Record<string, string>;

  /**
   * Controls whether `env` augments or replaces `process.env` for session child
   * processes. Defaults to `inherit` for backward compatibility.
   */
  envMode?: AgentSessionEnvMode;

  /**
   * Idle timeout in milliseconds for each `send()`. When the spawned agent
   * produces no stdout/stderr for this window, the session kills the child and
   * rejects with a SessionIdleTimeoutError. Independent of any outer max-duration
   * cap the caller applies. Disabled when undefined.
   */
  idleTimeoutMs?: number;

  /**
   * Optional lens name. The ai package loads the lens prompt from the catalog.
   */
  lens?: string;

  /**
   * Logger instance for debug output.
   */
  logger?: SessionLogger;

  /**
   * Absolute wall-clock budget in milliseconds for each `send()` turn. When the
   * spawned agent exceeds this duration, the session terminates the child and
   * rejects with a SessionMaxTurnTimeoutError even if output is still arriving.
   * Disabled when undefined.
   */
  maxTurnMs?: number;

  /**
   * Paths to MCP config files to pass via --mcp-config flags.
   * Ignored when runtimeMode is 'host-native'.
   */
  mcpConfig?: string[];

  /**
   * Model/agent to use for the session.
   */
  model: AgentModel;

  /**
   * Exact registered model ID to use for the session
   * (e.g., 'gpt-6-astra', 'claude-fable-5[1m]').
   */
  modelId?: string;

  /**
   * Callback invoked with byte-count-only child-process activity. Raw stream
   * chunks are never exposed through this callback.
   */
  onActivity?: (activity: AgentSessionActivity) => void;

  /**
   * Callback invoked after the child process has closed and its stdio streams
   * have drained. The outcome contains only sanitized lifecycle metadata.
   */
  onProcessOutcome?: (outcome: AgentSessionProcessOutcome) => void;

  /**
   * Callback invoked when token usage information is available.
   */
  onTokenUsage?: (usage: TokenUsage) => void;

  /**
   * Prefix for output logging.
   */
  outputPrefix?: string;

  /**
   * Working directory for the agent.
   */
  projectRoot: string;

  /**
   * Reasoning effort level for models that support it.
   * For GPT (Codex CLI): 'low', 'medium', 'high', 'xhigh'
   */
  reasoning?: string;

  /**
   * Sentinel string that signals response completion.
   * Required for detecting when the agent has finished responding.
   */
  responseSentinel: string;

  /**
   * Agent role for context filtering.
   */
  role?: AgentRole;

  /**
   * Launch runtime mode.
   * When omitted, the session uses the default managed runtime behavior.
   */
  runtimeMode?: AgentRuntimeMode;

  /**
   * Session ID for resuming a previous session.
   * When provided, the session resumes from the previous context.
   */
  sessionId?: string;

  /**
   * When true, passes --strict-mcp-config to the agent CLI.
   * Ignored when runtimeMode is 'host-native'.
   */
  strictMcpConfig?: boolean;

  /**
   * Exact installed Superpowers skill files selected by a trusted parent.
   * Native Grok sessions validate these as bounded regular `SKILL.md` files;
   * they do not translate them into a second sandbox or permission layer.
   */
  superpowersSkillReferences?: string[];

  /**
   * Label for transcript logs.
   */
  transcriptLabel?: string;

  /**
   * Explicit absolute transcript path prepared by the parent lifecycle.
   * When present, this takes precedence over transcriptLabel.
   */
  transcriptPath?: string;
}

/**
 * Sanitized terminal evidence for one CLI-backed session turn. The parent can
 * use it to distinguish a provider exit from an active child without exposing
 * process output or provider diagnostics.
 */
export interface AgentSessionProcessOutcome {
  completionMs: number;
  exitCode: null | number;
  firstActivityMs?: number;
  lastActivityMs?: number;
  receivedBytes: number;
  signal: NodeJS.Signals | null;
  stderrBytes: number;
  stdoutBytes: number;
  structuredOutput?: AgentSessionStructuredOutputSummary;
}

export interface AgentSessionStructuredOutputSummary {
  lastEventKind?: 'end' | 'other' | 'text' | 'tool_use';
  state: 'complete' | 'incomplete' | 'malformed' | 'none';
  terminalEventSeen: boolean;
  turnUsageReported: boolean;
  validEventCount: number;
}

export interface ProviderTokenUsage {
  cacheCreationInputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Hidden chain-of-thought reasoning tokens reported separately by the
   * provider (Codex `turn.completed.usage.reasoning_output_tokens` or
   * Responses API `output_tokens_details.reasoning_tokens`). Visible-output
   * trust checks subtract this from `outputTokens` so reasoning is not
   * conflated with the rendered assistant message.
   */
  reasoningOutputTokens?: number;
  totalTokens?: number;
}
export type { ContextSection };

/**
 * Logger interface for session output.
 */
export interface SessionLogger {
  debug(message: string): void;
  error(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

/**
 * Token usage information from an agent interaction.
 */
export interface TokenUsage {
  /** How effective-model attribution was established. */
  attributionSource?: 'exact-launch-contract' | 'provider-event';
  /** Exact model reported by the provider for this completed turn. */
  effectiveModelId?: string;
  inputTokens: number;
  model: string;
  outputTokens: number;
  provider?: ProviderTokenUsage;
  /** Provider identity reported by the completed turn. */
  providerId?: string;
  /** Effective reasoning effort for the completed turn. */
  reasoningEffort?: string;
  /** Caller-supplied model identifier before alias resolution. */
  requestedModelId?: string;
  /** Canonical registered model identifier selected for launch. */
  resolvedModelId?: string;
}

export type TokenUsageFieldSource = 'estimated' | 'mixed' | 'provider';

export interface TokenUsageOutputTrust {
  reason?: 'implausible_mixed_source_output_tokens';
  status: 'suspicious' | 'trusted';
}

export interface TokenUsageProvenance {
  input: TokenUsageFieldSource;
  output: TokenUsageFieldSource;
}

export type TokenUsageSource = 'estimated' | 'provider' | 'provider+estimated';
