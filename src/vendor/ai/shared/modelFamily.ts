import type { AgentModelName } from './agentConstants.js';

import { resolveModel } from '../targets/registry.js';
import { AGENT_MODEL_CLAUDE, AGENT_MODEL_GEMINI, AGENT_MODEL_GPT, AGENT_MODEL_XAI } from './agentConstants.js';
import { getModelPolicyEntry } from './modelPolicy.js';

export function inferModelFamily(modelIdOrAlias: string): AgentModelName | undefined {
  const trimmed = modelIdOrAlias.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const resolved = resolveModel(trimmed);
    return getModelPolicyEntry(resolved.resolvedId)?.family;
  } catch {
    // Fall through to host-name inference for raw pass-through model ids.
  }

  const normalized = trimmed.toLowerCase();
  if (isClaudeModelText(normalized)) {
    return AGENT_MODEL_CLAUDE;
  }
  if (isGptModelText(normalized)) {
    return AGENT_MODEL_GPT;
  }
  if (hasVersionMarker(normalized) && normalized.includes('gemini')) {
    return AGENT_MODEL_GEMINI;
  }
  if (hasVersionMarker(normalized) && (normalized.includes('grok') || normalized.includes('xai'))) {
    return AGENT_MODEL_XAI;
  }

  return undefined;
}

export function resolveModelFamily(modelIdOrAlias: string): AgentModelName {
  const family = inferModelFamily(modelIdOrAlias);
  if (family !== undefined) {
    return family;
  }

  const trimmed = modelIdOrAlias.trim();
  throw new Error(
    `Cannot infer model host family for "${trimmed}". ` +
      'Use a model id containing claude, fable, opus, sonnet, haiku, gpt, codex, openai, o3/o4/o5, gemini, grok, or xai.',
  );
}

function hasVersionMarker(normalized: string): boolean {
  return /\d/.test(normalized);
}

function isClaudeModelText(normalized: string): boolean {
  if (!hasVersionMarker(normalized)) {
    return false;
  }
  return (
    normalized.includes('anthropic') ||
    normalized.includes('claude') ||
    normalized.includes('fable') ||
    normalized.includes('haiku') ||
    normalized.includes('opus') ||
    normalized.includes('sonnet')
  );
}

function isGptModelText(normalized: string): boolean {
  if (/^o[3-9](?:$|[-.])/.test(normalized)) {
    return true;
  }
  if (!hasVersionMarker(normalized)) {
    return false;
  }
  return (
    normalized.includes('chatgpt') ||
    normalized.includes('codex') ||
    normalized.includes('gpt') ||
    normalized.includes('openai')
  );
}
