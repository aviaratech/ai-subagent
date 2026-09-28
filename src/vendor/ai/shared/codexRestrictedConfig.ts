/**
 * Strict MCP isolation for GPT/Codex launches.
 *
 * Claude honors `--mcp-config` / `--strict-mcp-config` natively (see
 * {@link ../api/launch.ts}). Codex has no per-run MCP flag; its per-session
 * configuration convention is an isolated `CODEX_HOME` containing a generated
 * `config.toml`. This module translates a set of `.mcp.json` files (the same
 * files Claude would load) into a temporary `CODEX_HOME/config.toml` that
 * declares ONLY those servers, so a strict-MCP GPT/Codex launch cannot inherit
 * the user's global `~/.codex/config.toml` servers.
 *
 * Replacing `CODEX_HOME` also moves Codex off its auth/startup state, which
 * lives in the original home (`auth.json`, `version.json`). To keep a nested
 * child authenticated, those files are linked into the temp home from the
 * source `CODEX_HOME` (or `~/.codex`) before the child launches. Linking (not
 * copying) means no secret bytes are duplicated onto disk; the throwaway home
 * only overrides `config.toml` while inheriting the existing auth/version.
 *
 * It deliberately edits a throwaway temp home, never the user's global config.
 * The TOML is composed in the narrow `[mcp_servers.<name>]` shape,
 * avoiding a new dependency.
 */

import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RestrictedCodexHome {
  /** Remove the temporary CODEX_HOME directory. Safe to call more than once. */
  cleanup: () => Promise<void>;
  /** Absolute path to the generated CODEX_HOME (contains config.toml). */
  codexHome: string;
}

export interface RestrictedCodexModelCatalogAlias {
  overrides: RestrictedCodexModelCatalogOverrides;
  sourceModelSlug: string;
}

export type RestrictedCodexModelCatalogObject = Record<string, unknown>;

export interface RestrictedCodexModelCatalogOverrides extends RestrictedCodexModelCatalogObject {
  slug: string;
}

export interface RestrictedCodexModelProvider {
  baseUrl: string;
  envKey: string;
  envKeyInstructions?: string;
  id: string;
  name: string;
  wireApi?: 'responses';
}

/**
 * Codex auth/startup files preserved into the restricted home so the child
 * launches authenticated. `config.toml` is intentionally excluded — the
 * restricted home owns it. Order is preserved for deterministic test output.
 */
const LINKED_CODEX_HOME_FILES = ['auth.json', 'version.json'] as const;
const COPIED_CODEX_HOME_FILES = ['models_cache.json'] as const;
const RESTRICTED_CODEX_HOME_RM_OPTIONS = {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
} as const;

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
}

interface McpServerEntry {
  args?: unknown;
  command?: unknown;
  env?: unknown;
}

interface RestrictedConfigTomlOptions {
  modelCatalogPath?: string;
  modelProvider?: RestrictedCodexModelProvider;
  nodeExecPath?: string;
}

/**
 * Compose the `config.toml` body from the requested `.mcp.json` files. Exported
 * for unit testing the translation independent of the filesystem temp-home.
 */
export function buildRestrictedConfigToml(mcpConfigPaths: string[], options: RestrictedConfigTomlOptions = {}): string {
  const blocks: string[] = [];
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  if (options.modelCatalogPath !== undefined && options.modelCatalogPath.trim().length > 0) {
    blocks.push(`model_catalog_json = ${tomlString(options.modelCatalogPath)}`);
  }
  if (options.modelProvider !== undefined) {
    blocks.push(renderModelProviderBlock(options.modelProvider));
  }
  for (const configPath of mcpConfigPaths) {
    if (!existsSync(configPath)) {
      continue;
    }
    const pluginRoot = dirname(configPath);
    const servers = readMcpServers(configPath);
    for (const [name, entry] of Object.entries(servers)) {
      blocks.push(renderServerBlock({ entry, name, nodeExecPath, pluginRoot }));
    }
  }
  return `${blocks.join('\n')}\n`;
}

/**
 * Build a temporary `CODEX_HOME` whose `config.toml` declares only the
 * `mcp_servers` found in the given `.mcp.json` paths. Missing paths are skipped.
 *
 * Codex auth/startup files are preserved from `sourceCodexHome` (defaulting to
 * `$CODEX_HOME` or `~/.codex`) so the isolated launch stays authenticated; only
 * `config.toml` is overridden.
 *
 * Returns a Promise so the call site can `await` it alongside other async launch
 * setup; the work itself is synchronous filesystem composition.
 */
export function writeRestrictedCodexHome(options: {
  mcpConfigPaths: string[];
  modelCatalogAliases?: readonly RestrictedCodexModelCatalogAlias[];
  modelProvider?: RestrictedCodexModelProvider;
  nodeExecPath?: string;
  sourceCodexHome?: string;
}): Promise<RestrictedCodexHome> {
  const codexHome = mkdtempSync(join(tmpdir(), 'ai-subagent-codex-home-'));
  try {
    const sourceCodexHome = resolveSourceCodexHome(options.sourceCodexHome);
    const modelCatalog = buildModelCatalogFromAliases(sourceCodexHome, options.modelCatalogAliases ?? []);
    const modelCatalogPath = modelCatalog !== undefined ? join(codexHome, 'model-catalog.json') : undefined;
    const toml = buildRestrictedConfigToml(options.mcpConfigPaths, {
      ...(modelCatalogPath !== undefined ? { modelCatalogPath } : {}),
      ...(options.modelProvider !== undefined ? { modelProvider: options.modelProvider } : {}),
      ...(options.nodeExecPath !== undefined ? { nodeExecPath: options.nodeExecPath } : {}),
    });
    if (modelCatalog !== undefined && modelCatalogPath !== undefined) {
      writeFileSync(modelCatalogPath, `${JSON.stringify(modelCatalog, null, 2)}\n`, 'utf8');
    }
    writeFileSync(join(codexHome, 'config.toml'), toml, 'utf8');
    preserveCodexState({
      sourceCodexHome,
      targetCodexHome: codexHome,
    });
  } catch (error) {
    removeRestrictedCodexHome(codexHome);
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  return Promise.resolve({
    cleanup: (): Promise<void> => {
      removeRestrictedCodexHome(codexHome);
      return Promise.resolve();
    },
    codexHome,
  });
}

function buildModelCatalogFromAliases(
  sourceCodexHome: string,
  aliases: readonly RestrictedCodexModelCatalogAlias[],
): undefined | { models: RestrictedCodexModelCatalogObject[] } {
  if (aliases.length === 0) {
    return undefined;
  }
  const sourceModels = readCachedModelCatalogModels(sourceCodexHome);
  const models = aliases.flatMap(alias => {
    const sourceModel = sourceModels.find(model => model.slug === alias.sourceModelSlug);
    if (sourceModel === undefined) {
      return [];
    }
    return [{ ...sourceModel, ...alias.overrides }];
  });
  return models.length > 0 ? { models } : undefined;
}

function isCrossDeviceLinkError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EXDEV';
}

function isJsonObject(value: unknown): value is RestrictedCodexModelCatalogObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
  );
}

/**
 * Preserve Codex auth/startup files from the source home into the restricted home.
 *
 * Secret-bearing auth files are linked so no secret bytes are duplicated. The
 * model metadata cache is non-secret and copied so a child refresh cannot mutate
 * the user's source cache through a hard link. Missing files are skipped — a host
 * without Codex auth or cache simply gets no preserved file, exactly as before.
 */
function preserveCodexState(input: { sourceCodexHome: string; targetCodexHome: string }): void {
  const { sourceCodexHome, targetCodexHome } = input;
  for (const fileName of LINKED_CODEX_HOME_FILES) {
    const source = join(sourceCodexHome, fileName);
    if (!existsSync(source)) {
      continue;
    }
    const target = join(targetCodexHome, fileName);
    try {
      linkSync(source, target);
    } catch (error) {
      if (isCrossDeviceLinkError(error)) {
        symlinkSync(source, target);
        continue;
      }
      throw error;
    }
  }
  for (const fileName of COPIED_CODEX_HOME_FILES) {
    const source = join(sourceCodexHome, fileName);
    if (!existsSync(source)) {
      continue;
    }
    copyFileSync(source, join(targetCodexHome, fileName));
  }
}

function readCachedModelCatalogModels(sourceCodexHome: string): RestrictedCodexModelCatalogObject[] {
  const cachePath = join(sourceCodexHome, 'models_cache.json');
  if (!existsSync(cachePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
    if (!isJsonObject(parsed) || !Array.isArray(parsed.models)) {
      return [];
    }
    return parsed.models.filter(isJsonObject);
  } catch {
    return [];
  }
}

function readMcpServers(configPath: string): Record<string, McpServerEntry> {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as McpConfigFile;
  return parsed.mcpServers ?? {};
}

function removeRestrictedCodexHome(codexHome: string): void {
  rmSync(codexHome, RESTRICTED_CODEX_HOME_RM_OPTIONS);
}

function renderModelProviderBlock(provider: RestrictedCodexModelProvider): string {
  const lines = [
    `model_provider = ${tomlString(provider.id)}`,
    '',
    `[model_providers.${provider.id}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
    `env_key = ${tomlString(provider.envKey)}`,
  ];

  if (provider.envKeyInstructions !== undefined && provider.envKeyInstructions.trim().length > 0) {
    lines.push(`env_key_instructions = ${tomlString(provider.envKeyInstructions)}`);
  }
  if (provider.wireApi !== undefined) {
    lines.push(`wire_api = ${tomlString(provider.wireApi)}`);
  }

  return lines.join('\n');
}

function renderServerBlock(input: {
  entry: McpServerEntry;
  name: string;
  nodeExecPath: string;
  pluginRoot: string;
}): string {
  const { entry, name, nodeExecPath, pluginRoot } = input;
  const lines = [`[mcp_servers.${name}]`];

  if (typeof entry.command === 'string') {
    lines.push(`command = ${tomlString(resolveMcpCommand(entry.command, { nodeExecPath, pluginRoot }))}`);
  }

  const args = Array.isArray(entry.args)
    ? entry.args.filter((value): value is string => typeof value === 'string')
    : [];
  const renderedArgs = args.map(arg => tomlString(resolvePluginRoot(arg, pluginRoot)));
  lines.push(`args = [${renderedArgs.join(', ')}]`);

  const env = isStringRecord(entry.env) ? entry.env : undefined;
  if (env !== undefined && Object.keys(env).length > 0) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  return lines.join('\n');
}

function resolveMcpCommand(command: string, input: { nodeExecPath: string; pluginRoot: string }): string {
  if (command === 'node') {
    return input.nodeExecPath;
  }
  return resolvePluginRoot(command, input.pluginRoot);
}

/**
 * `.mcp.json` files use `${CLAUDE_PLUGIN_ROOT}` to reference the plugin's own
 * directory. Codex has no such variable, so resolve it to the `.mcp.json`'s
 * directory (the plugin root) at translation time.
 */
function resolvePluginRoot(value: string, pluginRoot: string): string {
  return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
}

function resolveSourceCodexHome(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit;
  }
  const fromEnv = process.env.CODEX_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return join(homedir(), '.codex');
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
