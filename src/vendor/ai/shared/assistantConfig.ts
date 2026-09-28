import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { AiConfig, AssistantCredentialConfig } from '../config/aiAgentsConfig.js';
import type { AgentDocsConfig } from './types.js';

import { loadAiConfigSync } from '../config/aiAgentsConfig.js';
import { AGENT_MODEL_XAI, type AgentModelName } from './agentConstants.js';

type AssistantName = AgentModelName;

/**
 * Resolve agent documentation config from ai.config.json.
 * Returns the docs configuration for agent document discovery.
 */
export function getAgentDocsConfig(projectRoot: string): AgentDocsConfig {
  const config = loadOptionalAiConfig(projectRoot);
  const docs = config?.docs;
  if (!docs) {
    return {};
  }

  const normalized: AgentDocsConfig = {};
  if (docs.agentsExclude !== undefined) {
    normalized.agentsExclude = docs.agentsExclude;
  }
  if (docs.agentsInclude !== undefined) {
    normalized.agentsInclude = docs.agentsInclude;
  }
  if (docs.agentsLimit !== undefined) {
    normalized.agentsLimit = docs.agentsLimit;
  }

  return normalized;
}

/**
 * Load an assistant API key from ai.config.json, supporting inline values and file references.
 */
export function loadAssistantApiKey(projectRoot: string, assistant: AssistantName): null | string {
  const config = resolveAssistantConfig(assistant, projectRoot);
  if (!config) {
    return null;
  }

  const inline = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (inline.length > 0) {
    return inline;
  }

  const pathValue = typeof config.apiKeyPath === 'string' ? config.apiKeyPath.trim() : '';
  if (pathValue.length === 0) {
    return null;
  }

  const resolvedPath = resolveKeyPath(projectRoot, pathValue);
  if (resolvedPath.length === 0) {
    console.warn(`⚠️  Assistant key file path is empty`);
    return null;
  }
  if (!existsSync(resolvedPath)) {
    console.warn(`⚠️  Assistant key file not found: ${resolvedPath}`);
    return null;
  }

  try {
    const content = readFileSync(resolvedPath, 'utf8').trim();
    if (content.length === 0) {
      console.warn(`⚠️  Assistant key file ${resolvedPath} is empty.`);
      return null;
    }
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Unable to read assistant key file ${resolvedPath}: ${message}`);
    return null;
  }
}

function loadOptionalAiConfig(projectRoot: string): AiConfig | null {
  try {
    return loadAiConfigSync({ projectRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ai.config.json not found')) {
      return null;
    }
    console.warn(`⚠️  Unable to load ai.config.json: ${message}`);
    return null;
  }
}

/**
 * Resolve assistant config from ai.config.json.
 * Reads the configuration file and returns the assistant-specific API key config.
 */
function resolveAssistantConfig(assistant: AssistantName, projectRoot: string): AssistantCredentialConfig | null {
  if (assistant === AGENT_MODEL_XAI) {
    return null;
  }
  const config = loadOptionalAiConfig(projectRoot);
  if (!config) {
    return null;
  }
  const assistantConfig = config.assistants?.[assistant];
  if (!assistantConfig) {
    return null;
  }

  return assistantConfig;
}

function resolveKeyPath(projectRoot: string, pathValue: string): string {
  if (pathValue.startsWith('~')) {
    // Strip tilde and any leading path separator (/ or \)
    const withoutTilde = pathValue.slice(1);
    const relativePath =
      withoutTilde.startsWith('/') || withoutTilde.startsWith('\\') ? withoutTilde.slice(1) : withoutTilde;
    return join(homedir(), relativePath);
  }
  if (isAbsolute(pathValue)) {
    return pathValue;
  }
  return resolve(projectRoot, pathValue);
}
