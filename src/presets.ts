import type { AgentLaunchBehaviorOptions, AgentModelName, AgentRole, ModelReasoningEffort } from './vendor/ai/index.js';

import {
  inferModelFamily,
  MODEL_NAMED_DEFAULTS,
  resolveHighestStableModelReasoningEffort,
  resolveModel,
} from './vendor/ai/index.js';

export type RequestedSubagentType = 'ask' | 'builder' | 'default' | 'explorer' | 'reviewer' | 'worker';
export interface ResolvedSubagentPreset {
  agentType: SubagentType;
  behavior: AgentLaunchBehaviorOptions;
  defaultReasoningEffort?: ModelReasoningEffort;
  instructions: string;
  model: AgentModelName;
  modelId: string;
  requiresOpenRouter: boolean;
  role?: AgentRole;
}

export interface ResolveSubagentPresetInput {
  agentType?: string;
  model?: string;
}

export type SubagentType = Exclude<RequestedSubagentType, 'worker'>;

const PRESET_INSTRUCTIONS: Record<SubagentType, string> = {
  ask:
    'You are a bounded second opinion subagent. Answer the specific question directly, identify uncertainty, ' +
    'and do not perform a full code review unless explicitly asked.',
  builder:
    'You are a builder subagent. Work from the assigned project_root and follow the task and repository scope. Finish with exactly one ' +
    'terminal status line: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED, followed by changed files and checks. ' +
    'Use your harness native file-edit/patch tool (`apply_patch` on Codex); never write files via shell heredocs, ' +
    '`echo`/`cat` redirection, or `sed -i`. End with a fenced JSON summary containing terminal_status, changed_files, ' +
    'commands, concerns, and evidence.red/evidence.green.',
  default:
    'You are a provider-backed subagent. Complete the delegated task, report concise results, and ask for context ' +
    'only when blocked.',
  explorer:
    'You are an explorer subagent. Investigate and report findings. Treat the assignment as non-mutating unless the ' +
    'parent explicitly grants a write scope.',
  reviewer:
    'You are a reviewer subagent. Review the requested code or plan, lead with findings, and finish with exactly one ' +
    'terminal line: VERDICT: approve | request-changes.',
};

export function resolveSubagentPreset(input: ResolveSubagentPresetInput): ResolvedSubagentPreset {
  const agentType = resolveSubagentType(input.agentType);
  const namedDefault = MODEL_NAMED_DEFAULTS[`ai-subagent.${agentType}`];
  const modelId = input.model ?? namedDefault.modelId;
  const resolved = resolveModel(modelId);
  const model = inferModelFamily(resolved.model.id);
  if (model === undefined) {
    throw new Error(`Unable to infer host family for ai-subagent model "${modelId}".`);
  }

  const role = roleForAgentType(agentType);
  const ownsNamedDefault = resolved.resolvedId === namedDefault.modelId;
  const defaultReasoningEffort = ownsNamedDefault
    ? namedDefault.reasoningEffort
    : resolveHighestStableModelReasoningEffort(resolved.resolvedId);
  return {
    agentType,
    behavior: { sandbox: 'off' },
    ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
    instructions: PRESET_INSTRUCTIONS[agentType],
    model,
    modelId: resolved.resolvedId,
    requiresOpenRouter: resolved.model.env?.CODEX_MODEL_PROVIDER === 'openrouter',
    ...(role !== undefined ? { role } : {}),
  };
}

export function resolveSubagentType(rawAgentType: string | undefined): SubagentType {
  const normalizedInput = rawAgentType?.trim().toLowerCase();
  const normalized = normalizedInput === undefined || normalizedInput.length === 0 ? 'default' : normalizedInput;
  if (normalized === 'worker') {
    return 'builder';
  }
  if (
    normalized === 'ask' ||
    normalized === 'builder' ||
    normalized === 'default' ||
    normalized === 'explorer' ||
    normalized === 'reviewer'
  ) {
    return normalized;
  }
  throw new Error(`Unsupported ai-subagent agent_type "${normalized}".`);
}

function roleForAgentType(agentType: SubagentType): AgentRole | undefined {
  if (agentType === 'builder') {
    return 'builder';
  }
  if (agentType === 'reviewer') {
    return 'reviewer';
  }
  return undefined;
}
