export const AGENT_MODEL_GPT = 'gpt' as const;
export const AGENT_MODEL_CLAUDE = 'claude' as const;
export const AGENT_MODEL_GEMINI = 'gemini' as const;
export const AGENT_MODEL_XAI = 'xai' as const;
export const AGENT_MODEL_QWEN = 'qwen' as const;
export const AGENT_BACKEND_GPT_OSS = 'gpt-oss' as const;
export const GPT_CLI_COMMAND = 'codex' as const;
export const GROK_CLI_COMMAND = 'grok' as const;

export const AGENT_MODEL_NAMES = [AGENT_MODEL_GPT, AGENT_MODEL_CLAUDE, AGENT_MODEL_GEMINI, AGENT_MODEL_XAI] as const;

export type AgentModelName = (typeof AGENT_MODEL_NAMES)[number];

export const IDENTITY_FAMILIES = [...AGENT_MODEL_NAMES, AGENT_MODEL_QWEN] as const;

export type IdentityFamily = (typeof IDENTITY_FAMILIES)[number];

export function normalizeAgentModelName(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized;
}

export function normalizeIdentityPrefix(identity: string): string {
  return identity.trim().toLowerCase();
}
