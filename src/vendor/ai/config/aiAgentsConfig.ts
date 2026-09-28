/**
 * Configuration schema and loader for AI agents.
 * Supports dynamic agent registration with GitHub App credentials.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Schema for GitHub App credentials configuration
 */
const GitHubAppConfigSchema = z.object({
  credentialsPath: z.string().min(1).describe('Path to credentials file (supports ~ expansion)'),
  envPrefix: z.string().min(1).describe('Environment variable prefix for this GitHub App (e.g., GH_APP_CODEX_)'),
});

/**
 * Schema for model provider configuration
 */
const ProviderModelSchema = z.object({
  contextWindow: z.number().int().positive().optional().describe('Optional context window size'),
  id: z.string().min(1).describe('Provider model identifier'),
  label: z.string().optional().describe('Optional display label'),
  maxOutputTokens: z.number().int().positive().optional().describe('Optional maximum output tokens'),
});

const ProviderConfigSchema = z.object({
  apiKey: z.string().optional().describe('Inline API key'),
  apiKeyEnv: z.string().optional().describe('Environment variable containing the API key'),
  apiKeyPath: z.string().optional().describe('Path to a file containing the API key'),
  baseUrl: z.string().optional().describe('Optional base URL override'),
  defaultModel: z.string().optional().describe('Default model to use for this provider'),
  models: z
    .array(z.union([z.string(), ProviderModelSchema]))
    .optional()
    .describe('Optional list of available models'),
});

/**
 * Schema for individual agent configuration
 */
const AgentConfigSchema = z.object({
  githubApp: GitHubAppConfigSchema.optional().describe('GitHub App credentials for this agent'),
  model: z.string().optional().describe('Optional model string. If omitted, uses CLI flag or runtime default.'),
  provider: z.string().optional().describe('Optional model provider to use for this agent'),
});

/**
 * Schema for fallback token configuration
 */
const FallbackConfigSchema = z.object({
  tokenEnvVars: z
    .array(z.string())
    .default(['GH_TOKEN', 'GITHUB_TOKEN'])
    .describe('Environment variables to check for fallback token'),
  useUserToken: z.boolean().default(true).describe('Whether to fall back to user token if agent config not found'),
});

const AssistantCredentialConfigSchema = z.object({
  apiKey: z.string().optional().describe('Inline API key for assistant auth'),
  apiKeyPath: z.string().optional().describe('Path to a file containing the assistant API key'),
});

const AssistantsConfigSchema = z.object({
  claude: AssistantCredentialConfigSchema.optional().describe('Claude assistant configuration'),
  gemini: AssistantCredentialConfigSchema.optional().describe('Gemini assistant configuration'),
  gpt: AssistantCredentialConfigSchema.optional().describe('GPT assistant configuration'),
});

const DocsConfigSchema = z.object({
  agentsExclude: z.array(z.string()).optional().describe('Optional glob patterns to exclude from docs discovery'),
  agentsInclude: z.array(z.string()).optional().describe('Optional glob patterns to include for docs discovery'),
  agentsLimit: z.number().int().nonnegative().optional().describe('Optional cap for AGENTS docs loading'),
});

/**
 * Root schema for ai.config.json
 */
const AiConfigSchema = z.object({
  agents: z
    .record(z.string(), AgentConfigSchema)
    .default({})
    .describe('Map of agent identities to their configurations'),
  assistants: AssistantsConfigSchema.optional().describe('Assistant credential configuration for CLI auth checks'),
  docs: DocsConfigSchema.optional().describe('Documentation discovery config overrides'),
  fallback: FallbackConfigSchema.optional().describe('Fallback configuration when agent not found'),
  providers: z.record(z.string(), ProviderConfigSchema).optional().describe('Model provider configuration'),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;
export type AssistantCredentialConfig = z.infer<typeof AssistantCredentialConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * In-memory cache for loaded config
 */
const configCache = new Map<string, AiConfig>();

/**
 * Clears the config cache (useful for testing)
 */
export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * Loads and validates ai.config.json.
 * Async callers delegate to the shared synchronous loader to avoid duplicate logic.
 */
export async function loadAiConfig(options: { forceReload?: boolean; projectRoot?: string } = {}): Promise<AiConfig> {
  return await Promise.resolve(loadAiConfigSync(options));
}

/**
 * Loads and validates ai.config.json synchronously.
 */
export function loadAiConfigSync(options: { forceReload?: boolean; projectRoot?: string } = {}): AiConfig {
  const { forceReload = false, projectRoot = process.cwd() } = options;
  const configPath = resolveConfigPath(projectRoot);
  if (configPath === null) {
    throw new Error(
      'ai.config.json not found. Create one at your project root or set AI_CONFIG_PATH environment variable.',
    );
  }

  if (!forceReload) {
    const cachedConfig = configCache.get(configPath);
    if (cachedConfig !== undefined) {
      return cachedConfig;
    }
  }

  const validated = readAndValidateConfig(configPath);

  configCache.set(configPath, validated);
  return validated;
}

/**
 * Normalizes model string to handle different formats
 * Supports canonical IDs such as "claude-sonnet-5" and provider-prefixed values such as
 * "anthropic/claude-sonnet-5".
 */
export function normalizeModel(input: string): string {
  const trimmed = input.trim();

  // Provider prefix format: "anthropic/claude-sonnet-5" -> "claude-sonnet-5"
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    const lastPart = parts[parts.length - 1];
    return lastPart ?? trimmed;
  }

  // Short name or full ID: keep as-is
  return trimmed;
}

/**
 * Pure validation helper for ai.config.json payloads.
 */
export function validateAiConfig(raw: unknown): AiConfig {
  return AiConfigSchema.parse(raw);
}

/**
 * Expands ~ to home directory in file paths
 */
function expandHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Finds the ai.config.json file by walking up the directory tree
 */
function findConfigFile(startDir: string): null | string {
  let currentDir = resolve(startDir);
  const root = resolve('/');

  while (currentDir !== root) {
    const configPath = join(currentDir, 'ai.config.json');
    if (existsSync(configPath)) {
      return configPath;
    }
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
}

function readAndValidateConfig(configPath: string): AiConfig {
  try {
    const content = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return validateAiConfig(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
      throw new Error(`Invalid ai.config.json at ${configPath}:\n${issues}`);
    }
    throw new Error(
      `Failed to load ai.config.json from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveConfigPath(projectRoot: string): null | string {
  // Check for AI_CONFIG_PATH environment variable override.
  const envConfigPath = process.env.AI_CONFIG_PATH;
  const trimmedConfigPath = typeof envConfigPath === 'string' ? envConfigPath.trim() : '';
  if (trimmedConfigPath.length > 0) {
    const expandedPath = expandHome(trimmedConfigPath);
    const candidatePath = isAbsolute(expandedPath) ? expandedPath : resolve(projectRoot, expandedPath);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
    console.warn(`AI_CONFIG_PATH points to non-existent file: ${candidatePath}`);
  }

  // If not found via env var, search from project root.
  return findConfigFile(projectRoot);
}
