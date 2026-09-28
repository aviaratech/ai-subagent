import type { AGENT_BACKEND_GPT_OSS, AgentModelName } from '../shared/agentConstants.js';
import type { ModelAuthSpec, ModelNativeProviderSpec, ModelTransportId } from '../shared/modelPolicy.js';

export interface LaunchModel {
  args: string[];
  auth: ModelAuthSpec;
  backend: ModelBackend;
  claudeCodeContext?: '1m';
  command: 'claude' | 'codex' | 'gemini' | 'grok';
  contextWindow?: number;
  description: string;
  env?: Record<string, string>;
  id: string;
  provider: ModelNativeProviderSpec;
  providerModel?: string;
  transport: ModelTransportId;
}

export type ModelBackend = AgentModelName | typeof AGENT_BACKEND_GPT_OSS;

export interface ResolvedModel {
  model: LaunchModel;
  requested: string;
  resolvedId: string;
  warning?: string;
}
