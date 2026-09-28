import { execFile } from 'node:child_process';

import { getModelPolicyEntry, MODEL_TRANSPORTS } from '../shared/modelPolicy.js';

const PREFLIGHT_TIMEOUT_MS = 15_000;
const PREFLIGHT_MAX_BUFFER_BYTES = 64 * 1024;
const GROK_INSPECT_MAX_BUFFER_BYTES = 1024 * 1024;
const REQUIRED_GROK_PLUGINS = ['superpowers'] as const;
const REQUIRED_GROK_MCP_SERVERS = [] as const;
const REQUIRED_GROK_SKILLS = ['using-superpowers'] as const;

export interface ModelLaunchCapabilityEvidence {
  name: string;
  origin: string;
}

export interface ModelLaunchCapabilityInventory {
  inspectionStatus: 'ok' | 'unavailable';
  mcpServers: ModelLaunchMcpCapabilityEvidence[];
  missing: string[];
  plugins: ModelLaunchCapabilityEvidence[];
  skills: ModelLaunchCapabilityEvidence[];
}

export interface ModelLaunchMcpCapabilityEvidence extends ModelLaunchCapabilityEvidence {
  transport: string;
}

export interface ModelLaunchPreflightResult {
  authMode: 'host-subscription' | 'provider-api-key';
  capabilityInventory?: ModelLaunchCapabilityInventory;
  modelId: string;
  providerId: string;
  transport: string;
  version: string;
}

export async function runModelLaunchPreflight(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  modelId: string;
}): Promise<ModelLaunchPreflightResult> {
  const policy = getModelPolicyEntry(input.modelId);
  if (policy?.launch === null || policy?.launch === undefined) {
    throw new Error(`model_preflight_unavailable: ${input.modelId} has no active launch contract.`);
  }
  const transport = MODEL_TRANSPORTS[policy.launch.transport];
  const versionOutput = await runBoundedArgv({ argv: transport.versionArgv, cwd: input.cwd, env: input.env });
  const version = sanitizeVersion(versionOutput);
  if (policy.launch.auth.mode === 'host-subscription') {
    const authOutput = await runBoundedArgv({ argv: policy.launch.auth.preflightArgv, cwd: input.cwd, env: input.env });
    if (policy.launch.transport === 'grok-build' && !containsExactModel(authOutput, input.modelId)) {
      throw new Error(`model_preflight_model_unavailable: ${input.modelId} is not available to the Grok subscription.`);
    }
  } else if ((input.env[policy.launch.auth.envKey]?.trim().length ?? 0) > 0) {
    // API-key contents are never read or returned; only presence is validated.
  } else {
    throw new Error(`model_preflight_authentication_failed: ${policy.launch.auth.envKey} is required.`);
  }
  const capabilityInventory =
    policy.launch.transport === 'grok-build'
      ? await inspectRequiredGrokCapabilities({ cwd: input.cwd, env: input.env })
      : undefined;
  return {
    authMode: policy.launch.auth.mode,
    ...(capabilityInventory !== undefined ? { capabilityInventory } : {}),
    modelId: input.modelId,
    providerId: policy.launch.provider.id,
    transport: policy.launch.transport,
    version,
  };
}

function containsExactModel(output: string, modelId: string): boolean {
  return output.split(/\s+/u).includes(modelId);
}

async function inspectRequiredGrokCapabilities(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ModelLaunchCapabilityInventory> {
  let output: string;
  try {
    output = await runBoundedArgv({
      argv: ['grok', 'inspect', '--json'],
      cwd: input.cwd,
      env: input.env,
      maxBuffer: GROK_INSPECT_MAX_BUFFER_BYTES,
    });
  } catch {
    return unavailableGrokCapabilityInventory();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return unavailableGrokCapabilityInventory();
  }
  if (!isRecord(parsed)) {
    return unavailableGrokCapabilityInventory();
  }

  const plugins = parseGrokPlugins(parsed.plugins).filter(plugin =>
    requiredIncludes(REQUIRED_GROK_PLUGINS, plugin.name),
  );
  const mcpServers = parseGrokMcpServers(parsed.mcpServers).filter(server =>
    requiredIncludes(REQUIRED_GROK_MCP_SERVERS, server.name),
  );
  const skills = parseGrokSkills(parsed.skills).filter(skill => requiredIncludes(REQUIRED_GROK_SKILLS, skill.name));

  return {
    inspectionStatus: 'ok',
    mcpServers: sortCapabilityEvidence(mcpServers),
    missing: [
      ...missingCapabilityNames({ actual: mcpServers, kind: 'mcp', required: REQUIRED_GROK_MCP_SERVERS }),
      ...missingCapabilityNames({ actual: plugins, kind: 'plugin', required: REQUIRED_GROK_PLUGINS }),
      ...missingCapabilityNames({ actual: skills, kind: 'skill', required: REQUIRED_GROK_SKILLS }),
    ],
    plugins: sortCapabilityEvidence(plugins),
    skills: sortCapabilityEvidence(skills),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingCapabilityNames(input: {
  actual: readonly ModelLaunchCapabilityEvidence[];
  kind: 'mcp' | 'plugin' | 'skill';
  required: readonly string[];
}): string[] {
  const names = new Set(input.actual.map(capability => capability.name));
  return input.required.filter(name => !names.has(name)).map(name => `${input.kind}:${name}`);
}

function parseGrokMcpServers(value: unknown): ModelLaunchMcpCapabilityEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(entry => {
    if (!isRecord(entry)) {
      return [];
    }
    const name = sanitizedIdentifier(entry.name);
    if (name === undefined) {
      return [];
    }
    return [
      {
        name,
        origin: sanitizedGrokSource(entry.source),
        transport: sanitizedIdentifier(entry.transport) ?? 'unknown',
      },
    ];
  });
}

function parseGrokPlugins(value: unknown): ModelLaunchCapabilityEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(entry => {
    if (!isRecord(entry) || entry.enabled !== true) {
      return [];
    }
    const name = sanitizedIdentifier(entry.name);
    if (name === undefined) {
      return [];
    }
    return [{ name, origin: sanitizedIdentifier(entry.scope) ?? 'unknown' }];
  });
}

function parseGrokSkills(value: unknown): ModelLaunchCapabilityEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(entry => {
    if (!isRecord(entry)) {
      return [];
    }
    const name = sanitizedIdentifier(entry.name);
    if (name === undefined) {
      return [];
    }
    return [{ name, origin: sanitizedGrokSource(entry.source) }];
  });
}

function requiredIncludes(required: readonly string[], value: string): boolean {
  return required.some(requiredValue => requiredValue === value);
}

function runBoundedArgv(input: {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer?: number;
}): Promise<string> {
  const [command, ...args] = input.argv;
  if (command === undefined) {
    return Promise.reject(new Error('model_preflight_invalid_argv: canonical preflight argv is empty.'));
  }
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: input.cwd,
        encoding: 'utf8',
        env: input.env,
        maxBuffer: input.maxBuffer ?? PREFLIGHT_MAX_BUFFER_BYTES,
        shell: false,
        timeout: PREFLIGHT_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`model_preflight_failed: ${command} authentication or availability check failed.`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function sanitizedGrokSource(value: unknown): string {
  if (!isRecord(value)) {
    return 'unknown';
  }
  const type = sanitizedIdentifier(value.type) ?? 'unknown';
  const pluginName = sanitizedIdentifier(value.plugin_name);
  return pluginName === undefined ? type : `${type}:${pluginName}`;
}

function sanitizedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(trimmed) ? trimmed : undefined;
}

function sanitizeVersion(output: string): string {
  const firstLine = output.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0 || firstLine.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9 ._+()[\]/-]*$/u.test(firstLine)) {
    return 'available';
  }
  return firstLine;
}

function sortCapabilityEvidence<T extends ModelLaunchCapabilityEvidence>(values: T[]): T[] {
  return [...values].sort((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.origin.localeCompare(right.origin) : nameOrder;
  });
}

function unavailableGrokCapabilityInventory(): ModelLaunchCapabilityInventory {
  return {
    inspectionStatus: 'unavailable',
    mcpServers: [],
    missing: [
      ...REQUIRED_GROK_MCP_SERVERS.map(name => `mcp:${name}`),
      ...REQUIRED_GROK_PLUGINS.map(name => `plugin:${name}`),
      ...REQUIRED_GROK_SKILLS.map(name => `skill:${name}`),
    ],
    plugins: [],
    skills: [],
  };
}
