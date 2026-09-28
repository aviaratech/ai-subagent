/**
 * Shared JSON event types and parsing utilities for CLI agent output.
 *
 * GPT (Codex CLI) and Claude each emit newline-delimited JSON events
 * from their exec/stream-json modes. This module provides the canonical
 * type definitions and pure-function extractors so callers don't
 * duplicate parsing logic.
 */

// ---------------------------------------------------------------------------
// GPT / Codex CLI events
// ---------------------------------------------------------------------------

export interface ClaudeContentBlock {
  input?: Record<string, unknown>;
  name?: string;
  text?: string;
  type?: string;
}

/** JSON event emitted by Claude CLI in stream-json mode. */
export interface ClaudeJsonEvent {
  content?: ClaudeContentBlock[];
  message?: { content?: ClaudeContentBlock[]; model?: string; usage?: ClaudeUsage };
  modelUsage?: Record<string, unknown>;
  plugins?: { name: string }[];
  result?: string;
  session_id?: string;
  subtype?: string;
  type: string;
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** JSON event emitted by the Codex CLI in exec --json mode. */
export interface GptJsonEvent {
  item?: GptJsonEventItem;
  text?: string;
  thread_id?: string;
  type: string;
  /** Token usage info from response.completed events. */
  usage?: GptTokenUsage;
}

export interface GptJsonEventItem {
  arguments?: Record<string, unknown> | string;
  name?: string;
  text?: string;
  type?: string;
}

export interface GptTokenUsage {
  /**
   * Top-level cached input tokens emitted by Codex CLI `turn.completed` events.
   * Mutually consistent with `input_tokens_details.cached_tokens` /
   * `prompt_tokens_details.cached_tokens` from the OpenAI Responses API shape;
   * when both are present the top-level value is preferred.
   */
  cached_input_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens?: number;
  /**
   * Output tokens spent on hidden chain-of-thought reasoning. Captured
   * separately so output-trust checks compare visible text against
   * `output_tokens - reasoning_output_tokens` rather than the gross total.
   * Mirrors `output_tokens_details.reasoning_tokens` (Responses API).
   */
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  prompt_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  /**
   * Top-level reasoning output tokens emitted by Codex CLI `turn.completed`
   * events. When both this and `output_tokens_details.reasoning_tokens` are
   * present the top-level value is preferred.
   */
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** Normalized token usage with input, output, and total. */
export interface NormalizedTokenUsage {
  input: number;
  output: number;
  provider?: ProviderTokenUsage;
  total: number;
}

/** Partial token usage where either field may be undefined (GPT events). */
export interface PartialTokenUsage {
  input?: number | undefined;
  output?: number | undefined;
  provider?: ProviderTokenUsage;
}

export interface ProviderTokenUsage {
  cacheCreationInputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Output tokens spent on hidden chain-of-thought reasoning, when the
   * provider reports them separately from visible output (Codex CLI
   * `turn.completed.usage.reasoning_output_tokens` or Responses API
   * `output_tokens_details.reasoning_tokens`).
   */
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ReconnaissanceFileRead {
  path: string;
}

// ---------------------------------------------------------------------------
// Claude events
// ---------------------------------------------------------------------------

export interface ReconnaissanceSearch {
  pattern: string;
  tool: 'Glob' | 'Grep';
}

export interface ReconnaissanceSummary {
  bashCommands: string[];
  filesRead: ReconnaissanceFileRead[];
  searches: ReconnaissanceSearch[];
  totalToolCalls: number;
}

/**
 * Coarse token usage source provenance.
 *
 * Semantics:
 * - `'provider'`: Both input and output tokens are provider-reported.
 * - `'provider+estimated'`: One token field is provider-reported, the other is estimated.
 * - `'estimated'`: Both input and output tokens are locally estimated (no provider data).
 *
 * Serialized launch/transcript token usage may also carry additive field-level
 * provenance and trust metadata so downstream consumers do not need to infer
 * which side was estimated from this coarse enum alone.
 */
export type TokenSource = 'estimated' | 'provider' | 'provider+estimated';

export interface ToolUsageSummary {
  calls: number;
  outputs: number;
  tools?: string[];
}

/**
 * Determine token source provenance from provider data availability.
 */
export function determineTokenSource(params: { hasProviderInput: boolean; hasProviderOutput: boolean }): TokenSource {
  const { hasProviderInput, hasProviderOutput } = params;
  if (hasProviderInput && hasProviderOutput) {
    return 'provider';
  }
  if (hasProviderInput || hasProviderOutput) {
    return 'provider+estimated';
  }
  return 'estimated';
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Extract agent dispatch info from Claude events containing Agent tool_use blocks.
 */
export function extractClaudeAgentDispatches(
  events: readonly ClaudeJsonEvent[],
): { agentType?: string; description?: string }[] {
  const dispatches: { agentType?: string; description?: string }[] = [];
  for (const event of events) {
    const blocks = event.message?.content ?? event.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.input !== undefined) {
        const entry: { agentType?: string; description?: string } = {};
        if (typeof block.input.subagent_type === 'string') {
          entry.agentType = block.input.subagent_type;
        }
        if (typeof block.input.description === 'string') {
          entry.description = block.input.description;
        }
        dispatches.push(entry);
      }
    }
  }
  return dispatches;
}

// ---------------------------------------------------------------------------
// Reconnaissance extraction (provider-neutral)
// ---------------------------------------------------------------------------

/**
 * Extract plugin names from Claude system init events.
 */
export function extractClaudeLoadedPlugins(events: readonly ClaudeJsonEvent[]): string[] {
  const plugins: string[] = [];
  for (const event of events) {
    if (event.type === 'system' && event.subtype === 'init' && event.plugins !== undefined) {
      for (const plugin of event.plugins) {
        plugins.push(plugin.name);
      }
    }
  }
  return plugins;
}

/** Exact provider model identifiers reported by Claude Code result events. */
export function extractClaudeModelIds(events: readonly ClaudeJsonEvent[]): string[] {
  const modelIds = new Set<string>();
  for (const event of events) {
    if (event.modelUsage === undefined) {
      continue;
    }
    for (const modelId of Object.keys(event.modelUsage)) {
      if (modelId.trim().length > 0) {
        modelIds.add(modelId);
      }
    }
  }
  return [...modelIds];
}

/** Primary provider model identifiers reported by Claude Code assistant events. */
export function extractClaudePrimaryModelIds(events: readonly ClaudeJsonEvent[]): string[] {
  const modelIds = new Set<string>();
  for (const event of events) {
    const modelId = event.message?.model?.trim();
    if (modelId !== undefined && modelId.length > 0) {
      modelIds.add(modelId);
    }
  }
  return [...modelIds];
}

/**
 * Extract session ID from Claude stream-json events.
 * Returns the last session_id found (later events overwrite earlier ones),
 * preserving the semantics of the original inline implementation.
 */
export function extractClaudeSessionId(events: readonly ClaudeJsonEvent[]): string | undefined {
  let sessionId: string | undefined;
  for (const event of events) {
    if (event.session_id !== undefined) {
      sessionId = event.session_id;
    }
  }
  return sessionId;
}

/**
 * Extract skill invocation info from Claude events containing Skill tool_use blocks.
 */
export function extractClaudeSkillInvocations(events: readonly ClaudeJsonEvent[]): { skill: string }[] {
  const invocations: { skill: string }[] = [];
  for (const event of events) {
    const blocks = event.message?.content ?? event.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
        invocations.push({ skill: block.input.skill });
      }
    }
  }
  return invocations;
}

/** Extract text parts from Claude assistant/result events. */
export function extractClaudeTextParts(events: readonly ClaudeJsonEvent[]): string[] {
  const parts: string[] = [];
  for (const event of events) {
    // Assistant content blocks
    const assistantContent = event.message?.content ?? event.content;
    if (event.type === 'assistant' && assistantContent !== undefined) {
      for (const block of assistantContent) {
        if (block.type === 'text' && block.text !== undefined) {
          parts.push(block.text);
        }
      }
    }
    // Result message content
    if (event.type === 'result' && event.message?.content !== undefined) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text !== undefined) {
          parts.push(block.text);
        }
      }
    }
    // Plain result string
    if (event.type === 'result' && typeof event.result === 'string') {
      parts.push(event.result);
    }
  }
  return parts;
}

/**
 * Extract and normalize token usage from Claude events.
 *
 * Claude Code emits per-turn usage in assistant message events. Each turn
 * reports that API call's own token counts:
 * - `output_tokens`: unique per turn (actual model output for that call)
 * - `input_tokens` + `cache_read/creation`: the context window for that call,
 *   which grows each turn as conversation history accumulates
 *
 * Strategy:
 * - **Output tokens: SUM** — each turn produces unique output (text + tool calls)
 * - **Input tokens: MAX** — represents the peak context window. Summing would
 *   over-count because the same base context is re-read each turn via caching.
 */
export function extractClaudeTokenUsage(events: readonly ClaudeJsonEvent[]): NormalizedTokenUsage | undefined {
  let maxInput = 0;
  let maxInputProvider: ProviderTokenUsage | undefined;
  let totalOutput = 0;
  let foundAny = false;
  let foundOutput = false;

  for (const event of events) {
    const candidate = event.message?.usage ?? event.usage;
    if (candidate === undefined) {
      continue;
    }
    const input = normalizeTokenValue(candidate.input_tokens);
    const output = normalizeTokenValue(candidate.output_tokens);
    const cacheCreation = normalizeTokenValue(candidate.cache_creation_input_tokens);
    const cacheRead = normalizeTokenValue(candidate.cache_read_input_tokens);

    if (input !== null || output !== null || cacheCreation !== null || cacheRead !== null) {
      foundAny = true;
      const effectiveInput = (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
      if (effectiveInput >= maxInput) {
        maxInput = effectiveInput;
        maxInputProvider = buildProviderTokenUsage({
          cacheCreationInputTokens: cacheCreation,
          cacheReadInputTokens: cacheRead,
          inputTokens: input,
        });
      }
      if (output !== null) {
        foundOutput = true;
        totalOutput += output;
      }
    }
  }

  if (!foundAny) {
    return undefined;
  }

  const provider = buildProviderTokenUsage({
    ...(maxInputProvider ?? {}),
    outputTokens: foundOutput ? totalOutput : null,
    totalTokens: maxInput + totalOutput,
  });
  return {
    input: maxInput,
    output: totalOutput,
    ...(provider !== undefined ? { provider } : {}),
    total: maxInput + totalOutput,
  };
}

/**
 * Extract tool call name+args pairs from Claude JSON events.
 * Used as input to extractReconnaissanceSummary.
 */
export function extractClaudeToolCalls(
  events: readonly ClaudeJsonEvent[],
): { args?: Record<string, unknown>; name: string }[] {
  const calls: { args?: Record<string, unknown>; name: string }[] = [];
  for (const event of events) {
    const blocks = event.message?.content ?? event.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        calls.push(block.input !== undefined ? { args: block.input, name: block.name } : { name: block.name });
      }
    }
  }
  return calls;
}

export function extractClaudeToolUsage(events: readonly ClaudeJsonEvent[]): ToolUsageSummary | undefined {
  let calls = 0;
  let outputs = 0;
  const tools = new Set<string>();

  for (const event of events) {
    const blocks = event.message?.content ?? event.content;
    if (!Array.isArray(blocks)) {
      continue;
    }
    for (const block of blocks) {
      const blockType = block.type?.trim().toLowerCase();
      if (blockType === undefined) {
        continue;
      }
      if (blockType === 'tool_use') {
        calls += 1;
        const name = normalizeToolName(block.name);
        if (name !== undefined) {
          tools.add(name);
        }
        continue;
      }
      if (blockType === 'tool_result') {
        outputs += 1;
      }
    }
  }

  return summarizeToolUsage({ calls, outputs, tools });
}

/** Extract agent message texts from GPT JSON events. */
export function extractGptAgentMessages(events: readonly GptJsonEvent[]): string[] {
  const messages: string[] = [];
  for (const event of events) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (event.item.text !== undefined) {
        messages.push(event.item.text);
      }
    }
  }
  return messages;
}

/** Extract the session/thread ID from a sequence of GPT JSON events. */
export function extractGptSessionId(events: readonly GptJsonEvent[]): string | undefined {
  const threadStarted = events.find(e => e.type === 'thread.started');
  return threadStarted?.thread_id;
}

/**
 * Extract normalized token usage from GPT JSON events.
 * Returns the last event's usage (later events overwrite earlier ones).
 * Allows partial results (input or output may be undefined) to preserve
 * the semantics of the original inline implementation where each field
 * was independently tracked with its own fallback.
 */
export function extractGptTokenUsage(events: readonly GptJsonEvent[]): PartialTokenUsage | undefined {
  let input: number | undefined;
  let output: number | undefined;
  let provider: ProviderTokenUsage | undefined;

  for (const event of events) {
    if (event.usage !== undefined) {
      const usageInput = normalizeTokenValue(event.usage.input_tokens ?? event.usage.prompt_tokens);
      const usageOutput = normalizeTokenValue(event.usage.output_tokens ?? event.usage.completion_tokens);
      const cachedInput = normalizeTokenValue(
        event.usage.cached_input_tokens ??
          event.usage.input_tokens_details?.cached_tokens ??
          event.usage.prompt_tokens_details?.cached_tokens,
      );
      const reasoningOutput = normalizeTokenValue(
        event.usage.reasoning_output_tokens ?? event.usage.output_tokens_details?.reasoning_tokens,
      );
      const explicitTotal = normalizeTokenValue(event.usage.total_tokens);
      input = usageInput ?? undefined;
      output = usageOutput ?? undefined;
      provider = buildProviderTokenUsage({
        cachedInputTokens: cachedInput,
        inputTokens: usageInput,
        outputTokens: usageOutput,
        reasoningOutputTokens: reasoningOutput,
        totalTokens: explicitTotal ?? (usageInput ?? 0) + (usageOutput ?? 0),
      });
    }
  }

  if (input === undefined && output === undefined) {
    return undefined;
  }
  return { input, output, ...(provider !== undefined ? { provider } : {}) };
}

/**
 * Extract tool call name+args pairs from GPT/Codex JSON events.
 * Used as input to extractReconnaissanceSummary.
 */
export function extractGptToolCalls(
  events: readonly GptJsonEvent[],
): { args?: Record<string, unknown>; name: string }[] {
  const calls: { args?: Record<string, unknown>; name: string }[] = [];
  for (const event of events) {
    if (event.type !== 'item.completed') continue;
    const item = event.item;
    if (item === undefined) continue;
    const itemType = item.type?.trim().toLowerCase();
    if (itemType === 'tool_call' || itemType === 'function_call') {
      if (typeof item.name === 'string') {
        let parsedArgs: Record<string, unknown> | undefined;
        if (typeof item.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            // Invalid JSON args — skip
          }
        } else if (typeof item.arguments === 'object') {
          parsedArgs = item.arguments;
        }
        calls.push(parsedArgs !== undefined ? { args: parsedArgs, name: item.name } : { name: item.name });
      }
    }
  }
  return calls;
}

export function extractGptToolUsage(events: readonly GptJsonEvent[]): ToolUsageSummary | undefined {
  let calls = 0;
  let outputs = 0;
  const tools = new Set<string>();

  for (const event of events) {
    if (event.type !== 'item.completed') {
      continue;
    }
    const itemType = event.item?.type?.trim().toLowerCase();
    if (itemType === undefined) {
      continue;
    }
    if (itemType === 'tool_call' || itemType === 'function_call') {
      calls += 1;
      const name = normalizeToolName(event.item?.name);
      if (name !== undefined) {
        tools.add(name);
      }
      continue;
    }
    if (itemType === 'tool_output' || itemType === 'tool_result' || itemType === 'function_result') {
      outputs += 1;
    }
  }

  return summarizeToolUsage({ calls, outputs, tools });
}

/**
 * Extract a reconnaissance summary from tool_use events.
 * Provider-neutral: works with both Claude content blocks and GPT event items.
 * Captures what files the agent read, what patterns it searched, and what commands it ran.
 */
export function extractReconnaissanceSummary(
  toolCalls: readonly { args?: Record<string, unknown>; name: string }[],
): ReconnaissanceSummary {
  const filesRead: ReconnaissanceFileRead[] = [];
  const searches: ReconnaissanceSearch[] = [];
  const bashCommands: string[] = [];
  const seenPaths = new Set<string>();
  const seenPatterns = new Set<string>();

  for (const call of toolCalls) {
    const name = call.name;
    const args = call.args;
    if (args === undefined) continue;

    if (name === 'Read') {
      const path = typeof args.file_path === 'string' ? args.file_path : undefined;
      if (path !== undefined && !seenPaths.has(path)) {
        seenPaths.add(path);
        filesRead.push({ path });
      }
    } else if (name === 'Grep' || name === 'Glob') {
      const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;
      if (pattern !== undefined && !seenPatterns.has(`${name}:${pattern}`)) {
        seenPatterns.add(`${name}:${pattern}`);
        searches.push({ pattern, tool: name });
      }
    } else if (name === 'Bash') {
      const command = typeof args.command === 'string' ? args.command : undefined;
      if (command !== undefined) {
        bashCommands.push(command.length > 120 ? `${command.slice(0, 117)}...` : command);
      }
    }
  }

  return {
    bashCommands,
    filesRead,
    searches,
    totalToolCalls: toolCalls.length,
  };
}

/**
 * Format a reconnaissance summary into a compact string for reviewer context.
 * Caps output to avoid prompt bloat.
 */
export function formatReconnaissanceSummary(summary: ReconnaissanceSummary): string {
  const lines: string[] = [];
  lines.push(`Total tool calls: ${String(summary.totalToolCalls)}`);

  if (summary.filesRead.length > 0) {
    const fileList = summary.filesRead.slice(0, 15).map(f => f.path.replace(/^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\//u, ''));
    const filesOverflow = summary.filesRead.length > 15 ? ` (+${String(summary.filesRead.length - 15)} more)` : '';
    lines.push(`Files read (${String(summary.filesRead.length)}): ${fileList.join(', ')}${filesOverflow}`);
  } else {
    lines.push('Files read: none');
  }

  if (summary.searches.length > 0) {
    const searchList = summary.searches.slice(0, 10).map(s => `${s.tool}(${s.pattern})`);
    const searchOverflow = summary.searches.length > 10 ? ` (+${String(summary.searches.length - 10)} more)` : '';
    lines.push(`Searches (${String(summary.searches.length)}): ${searchList.join(', ')}${searchOverflow}`);
  }

  if (summary.bashCommands.length > 0) {
    const bashOverflow = summary.bashCommands.length > 5 ? ` (+${String(summary.bashCommands.length - 5)} more)` : '';
    lines.push(
      `Bash commands (${String(summary.bashCommands.length)}): ${summary.bashCommands.slice(0, 5).join('; ')}${bashOverflow}`,
    );
  }

  return lines.join('\n');
}

/**
 * Parse a raw stdout line (from stream-json or exec --json) and return a
 * short human-readable summary suitable for a progress display.
 *
 * Returns `null` when the line is not a recognised event or produces no
 * useful summary (e.g., system/init events).
 */
export function formatStreamEventSummary(line: string): null | string {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) {
    return null;
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const eventType = typeof event.type === 'string' ? event.type : '';

  // Claude stream-json events
  if (eventType === 'assistant') {
    const blocks = (event.content ?? (event.message as Record<string, unknown> | undefined)?.content) as
      | ClaudeContentBlock[]
      | undefined;
    if (!Array.isArray(blocks)) {
      return null;
    }
    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        return `Tool: ${block.name}`;
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        const preview = block.text.trim().split('\n')[0] ?? '';
        return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
      }
    }
    return null;
  }

  if (eventType === 'result') {
    return 'Complete';
  }

  // GPT / Codex exec --json events
  if (eventType === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined;
    if (item === undefined) {
      return null;
    }
    const itemType = typeof item.type === 'string' ? item.type : '';
    if (itemType === 'tool_call' || itemType === 'function_call') {
      const name = typeof item.name === 'string' ? item.name : 'unknown';
      return `Tool: ${name}`;
    }
    if (itemType === 'agent_message' && typeof item.text === 'string') {
      const preview = item.text.trim().split('\n')[0] ?? '';
      return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
    }
    return null;
  }

  return null;
}

/** Normalize Claude usage to the shared format. Returns undefined if values are invalid. */
export function normalizeClaudeUsage(usage: ClaudeUsage | undefined): NormalizedTokenUsage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const baseInput = normalizeTokenValue(usage.input_tokens);
  const cacheCreation = normalizeTokenValue(usage.cache_creation_input_tokens);
  const cacheRead = normalizeTokenValue(usage.cache_read_input_tokens);
  const output = normalizeTokenValue(usage.output_tokens);

  if (baseInput === null || output === null) {
    return undefined;
  }

  // Effective input includes base input tokens plus cache components when present
  const effectiveInput = baseInput + (cacheCreation ?? 0) + (cacheRead ?? 0);
  const provider = buildProviderTokenUsage({
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    inputTokens: baseInput,
    outputTokens: output,
    totalTokens: effectiveInput + output,
  });

  return {
    input: effectiveInput,
    output,
    ...(provider !== undefined ? { provider } : {}),
    total: effectiveInput + output,
  };
}

/**
 * Parse newline-delimited JSON output into typed events.
 * Non-JSON lines are silently skipped.
 */
export function parseJsonLines<T>(rawOutput: string): T[] {
  const events: T[] = [];
  const lines = rawOutput.split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as T);
    } catch {
      // Not JSON, skip
    }
  }
  return events;
}

function buildProviderTokenUsage(params: {
  cacheCreationInputTokens?: null | number;
  cachedInputTokens?: null | number;
  cacheReadInputTokens?: null | number;
  inputTokens?: null | number;
  outputTokens?: null | number;
  reasoningOutputTokens?: null | number;
  totalTokens?: null | number;
}): ProviderTokenUsage | undefined {
  const provider: ProviderTokenUsage = {};
  if (params.cachedInputTokens !== undefined && params.cachedInputTokens !== null) {
    provider.cachedInputTokens = params.cachedInputTokens;
  }
  if (params.cacheCreationInputTokens !== undefined && params.cacheCreationInputTokens !== null) {
    provider.cacheCreationInputTokens = params.cacheCreationInputTokens;
  }
  if (params.cacheReadInputTokens !== undefined && params.cacheReadInputTokens !== null) {
    provider.cacheReadInputTokens = params.cacheReadInputTokens;
  }
  if (params.inputTokens !== undefined && params.inputTokens !== null) {
    provider.inputTokens = params.inputTokens;
  }
  if (params.outputTokens !== undefined && params.outputTokens !== null) {
    provider.outputTokens = params.outputTokens;
  }
  if (params.reasoningOutputTokens !== undefined && params.reasoningOutputTokens !== null) {
    provider.reasoningOutputTokens = params.reasoningOutputTokens;
  }
  if (params.totalTokens !== undefined && params.totalTokens !== null) {
    provider.totalTokens = params.totalTokens;
  }
  return Object.keys(provider).length > 0 ? provider : undefined;
}

function normalizeTokenValue(value: number | undefined): null | number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeToolName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function summarizeToolUsage(params: {
  calls: number;
  outputs: number;
  tools: Set<string>;
}): ToolUsageSummary | undefined {
  if (params.calls === 0 && params.outputs === 0) {
    return undefined;
  }
  return {
    calls: params.calls,
    outputs: params.outputs,
    ...(params.tools.size > 0 ? { tools: Array.from(params.tools).sort((a, b) => a.localeCompare(b)) } : {}),
  };
}

/**
 * Ratio thresholds for implausible provider input token detection.
 * Provider input below LOW_RATIO * estimate or above HIGH_RATIO * estimate
 * is treated as implausible and triggers a fallback to estimation.
 */
const IMPLAUSIBLE_INPUT_LOW_RATIO = 0.1;
const IMPLAUSIBLE_INPUT_HIGH_RATIO = 10;
/**
 * Minimum estimated input tokens required before implausible checks apply.
 * Very short prompts are exempt since small absolute differences are expected.
 */
const IMPLAUSIBLE_INPUT_MIN_ESTIMATE = 50;

/**
 * Validate provider-reported input tokens against an estimate derived from prompt text.
 * Returns a reason string when the value is implausible; undefined when plausible.
 */
export function detectImplausibleInputTokens(params: {
  estimatedInput: number;
  providerInput: number;
}): string | undefined {
  const { estimatedInput, providerInput } = params;
  if (estimatedInput < IMPLAUSIBLE_INPUT_MIN_ESTIMATE) {
    return undefined;
  }
  const ratio = providerInput / estimatedInput;
  if (ratio < IMPLAUSIBLE_INPUT_LOW_RATIO) {
    return `implausibly low (provider: ${String(providerInput)}, estimate: ${String(estimatedInput)}, ratio: ${ratio.toFixed(2)})`;
  }
  if (ratio > IMPLAUSIBLE_INPUT_HIGH_RATIO) {
    return `implausibly high (provider: ${String(providerInput)}, estimate: ${String(estimatedInput)}, ratio: ${ratio.toFixed(2)})`;
  }
  return undefined;
}
