/**
 * Shared model-policy facts used across AI workflow packages.
 *
 * MODEL_REGISTRY is the source of truth for model identity and capability
 * metadata in this experimental package. Role defaults derive from it.
 */

import type { AgentModelName, IdentityFamily } from './agentConstants.js';

import type { AGENT_BACKEND_GPT_OSS } from './agentConstants.js';

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

export const MODEL_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

export const MODEL_NAMED_DEFAULT_NAMES = [
  'ai-subagent.ask',
  'ai-subagent.builder',
  'ai-subagent.default',
  'ai-subagent.explorer',
  'ai-subagent.reviewer',
] as const;
export type ModelAuthSpec =
  | {
      readonly envKey: string;
      readonly mode: 'provider-api-key';
      readonly providerId: string;
    }
  | {
      readonly mode: 'host-subscription';
      readonly preflightArgv: readonly string[];
    };

export interface ModelCodexProviderSpec {
  readonly baseUrl: string;
  readonly baseUrlEnvKey: string;
  readonly catalogAlias?: {
    readonly overrides: {
      readonly context_window: number;
      readonly description: string;
      readonly display_name: string;
      readonly max_context_window: number;
      readonly slug: string;
    };
    readonly sourceModelSlug: string;
  };
  readonly envKey: string;
  readonly envKeyInstructions: string;
  readonly id: string;
  readonly name: string;
  readonly wireApi: 'responses';
}

export interface ModelLaunchSpec {
  readonly auth: ModelAuthSpec;
  readonly backend: AgentModelName | typeof AGENT_BACKEND_GPT_OSS;
  readonly claudeCodeContext?: '1m';
  readonly codexOss?: true;
  readonly codexProvider?: ModelCodexProviderSpec;
  readonly command: 'claude' | 'codex' | 'grok';
  /** Compatibility transport value, not a newly verified capability claim. */
  readonly contextWindow?: number;
  readonly description: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Native provider identity, kept separate from the host CLI transport. */
  readonly provider: ModelNativeProviderSpec;
  /** Provider-emitted telemetry identities. These are evidence labels, never selectable model aliases. */
  readonly providerReportedIds?: readonly string[];
  readonly rank: number;
  /** Provider/host model selector. */
  readonly selector?: string;
  readonly transport: ModelTransportId;
}

export type ModelNamedDefaultName = (typeof MODEL_NAMED_DEFAULT_NAMES)[number];

export interface ModelNativeProviderSpec {
  readonly id: string;
  readonly name: string;
}

export interface ModelPolicySpec {
  readonly aliases: readonly string[];
  readonly family: AgentModelName;
  readonly flagship: boolean;
  readonly identityFamily: IdentityFamily;
  readonly launch: ModelLaunchSpec | null;
  readonly namedDefaultEligibility: readonly ModelNamedDefaultName[];
  /** Null means capability/default is explicitly unknown and must not be inferred. */
  readonly reasoning: ModelReasoningSpec | null;
  readonly status: 'active' | 'retired';
}

export interface ModelReasoningSpec {
  /** Highest effort verified and approved for routine repository work. */
  readonly highestStableEffort: ModelReasoningEffort;
  /** Null means the provider default was not verified and must not be inferred. */
  readonly providerDefault: ModelReasoningEffort | null;
  readonly supportedEfforts: readonly ModelReasoningEffort[];
  readonly verification: 'local-claude-cli' | 'local-codex-catalog' | 'native-grok-cli';
}

export const MODEL_TRANSPORT_IDS = ['claude-code', 'codex-cli', 'grok-build'] as const;
export type ModelTransportId = (typeof MODEL_TRANSPORT_IDS)[number];

export interface ModelTransportSpec {
  readonly cancellation: true;
  readonly command: ModelLaunchSpec['command'];
  readonly fork: boolean;
  readonly interrupt: boolean;
  readonly nativeSkills: boolean;
  readonly queue: boolean;
  readonly resume: boolean;
  readonly structuredTerminal: true;
  readonly toolEvents: boolean;
  readonly usageEvents: boolean;
  readonly versionArgv: readonly string[];
}

export const MODEL_TRANSPORTS = {
  'claude-code': {
    cancellation: true,
    command: 'claude',
    fork: true,
    interrupt: true,
    nativeSkills: true,
    queue: true,
    resume: true,
    structuredTerminal: true,
    toolEvents: true,
    usageEvents: true,
    versionArgv: ['claude', '--version'],
  },
  'codex-cli': {
    cancellation: true,
    command: 'codex',
    fork: true,
    interrupt: true,
    nativeSkills: true,
    queue: true,
    resume: true,
    structuredTerminal: true,
    toolEvents: true,
    usageEvents: true,
    versionArgv: ['codex', '--version'],
  },
  'grok-build': {
    cancellation: true,
    command: 'grok',
    fork: false,
    interrupt: true,
    nativeSkills: false,
    queue: true,
    resume: true,
    structuredTerminal: true,
    toolEvents: true,
    usageEvents: true,
    versionArgv: ['grok', '--version'],
  },
} as const satisfies Record<ModelTransportId, ModelTransportSpec>;

/**
 * THE registry. Key order is NOT meaningful — the formatter sorts keys
 * alphabetically, so every ordered derivation sorts explicitly (rank fields
 * for the routing lists, id order for the set-like lists). Capability
 * metadata is intentionally conservative until observed run outcomes can
 * validate each provider path.
 */
export const MODEL_REGISTRY = {
  'claude-fable-5[1m]': {
    aliases: ['claude-fable-5', 'fable-5'],
    family: 'claude',
    flagship: true,
    identityFamily: 'claude',
    launch: claudeLaunch({
      claudeCodeContext: '1m',
      contextWindow: 1_000_000,
      description: 'Claude Fable 5 (1M context)',
      rank: 150,
      selector: 'claude-fable-5',
    }),
    namedDefaultEligibility: [],
    reasoning: {
      highestStableEffort: 'xhigh',
      providerDefault: null,
      supportedEfforts: ['xhigh'],
      verification: 'local-claude-cli',
    },
    status: 'active',
  },
  'claude-opus-4-8[1m]': {
    aliases: ['claude-opus-4-8', 'opus-4.8'],
    family: 'claude',
    flagship: false,
    identityFamily: 'claude',
    launch: claudeLaunch({
      claudeCodeContext: '1m',
      contextWindow: 1_000_000,
      description: 'Claude Opus 4.8 (1M context)',
      rank: 140,
      selector: 'claude-opus-4-8',
    }),
    namedDefaultEligibility: [],
    reasoning: {
      highestStableEffort: 'xhigh',
      providerDefault: null,
      supportedEfforts: ['xhigh'],
      verification: 'local-claude-cli',
    },
    status: 'active',
  },
  'claude-sonnet-5': {
    aliases: ['sonnet-5'],
    family: 'claude',
    flagship: false,
    identityFamily: 'claude',
    launch: claudeLaunch({
      description: 'Claude Sonnet 5',
      rank: 160,
      selector: 'claude-sonnet-5',
    }),
    namedDefaultEligibility: [],
    reasoning: {
      highestStableEffort: 'xhigh',
      providerDefault: null,
      supportedEfforts: ['xhigh'],
      verification: 'local-claude-cli',
    },
    status: 'active',
  },
  'glm-5.2': {
    aliases: ['z-ai/glm-5.2'],
    family: 'gpt',
    flagship: false,
    identityFamily: 'gpt',
    launch: codexLaunch({
      auth: { envKey: 'OPENROUTER_API_KEY', mode: 'provider-api-key', providerId: 'openrouter' },
      codexProvider: {
        baseUrl: 'https://openrouter.ai/api/v1',
        baseUrlEnvKey: 'OPENROUTER_BASE_URL',
        catalogAlias: {
          overrides: {
            context_window: 1_048_576,
            description: 'GLM 5.2 via OpenRouter',
            display_name: 'GLM-5.2',
            max_context_window: 1_048_576,
            slug: 'z-ai/glm-5.2',
          },
          sourceModelSlug: 'gpt-5.6-terra',
        },
        envKey: 'OPENROUTER_API_KEY',
        envKeyInstructions: 'Set OPENROUTER_API_KEY before launching GLM/OpenRouter-backed ai-subagent workers.',
        id: 'openrouter',
        name: 'OpenRouter',
        wireApi: 'responses',
      },
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      description: 'GLM 5.2 via OpenRouter (Codex CLI custom provider)',
      env: {
        CODEX_MODEL_PROVIDER: 'openrouter',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      },
      provider: { id: 'z-ai', name: 'Z.ai via OpenRouter' },
      rank: 100,
      selector: 'z-ai/glm-5.2',
    }),
    namedDefaultEligibility: [],
    reasoning: null,
    status: 'active',
  },
  'gpt-5.6-luna': {
    aliases: [],
    family: 'gpt',
    flagship: false,
    identityFamily: 'gpt',
    launch: codexLaunch({
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      description: 'GPT-5.6 Luna (Codex CLI)',
      rank: 90,
      selector: 'gpt-5.6-luna',
    }),
    namedDefaultEligibility: ['ai-subagent.explorer'],
    reasoning: {
      highestStableEffort: 'xhigh',
      providerDefault: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      verification: 'local-codex-catalog',
    },
    status: 'active',
  },
  'gpt-5.6-terra': {
    aliases: [],
    family: 'gpt',
    flagship: false,
    identityFamily: 'gpt',
    launch: codexLaunch({
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      description: 'GPT-5.6 Terra (Codex CLI)',
      rank: 80,
      selector: 'gpt-5.6-terra',
    }),
    namedDefaultEligibility: ['ai-subagent.default'],
    reasoning: {
      highestStableEffort: 'xhigh',
      providerDefault: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      verification: 'local-codex-catalog',
    },
    status: 'active',
  },
  'gpt-6-astra': {
    aliases: [],
    family: 'gpt',
    flagship: true,
    identityFamily: 'gpt',
    launch: codexLaunch({
      contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
      description: 'GPT-6 Astra (Codex CLI)',
      rank: 70,
      selector: 'gpt-6-astra',
    }),
    namedDefaultEligibility: [],
    reasoning: {
      highestStableEffort: 'xhigh',
      providerDefault: 'medium',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      verification: 'local-codex-catalog',
    },
    status: 'active',
  },
  'grok-4.5': {
    aliases: [],
    family: 'xai',
    flagship: true,
    identityFamily: 'xai',
    launch: grokLaunch({
      description: 'Grok 4.5 via the native Grok CLI',
      provider: { id: 'xai', name: 'xAI subscription OAuth' },
      providerReportedIds: ['grok-4.5-build'],
      rank: 110,
      selector: 'grok-4.5',
    }),
    namedDefaultEligibility: ['ai-subagent.ask', 'ai-subagent.builder', 'ai-subagent.reviewer'],
    reasoning: {
      highestStableEffort: 'high',
      providerDefault: 'high',
      supportedEfforts: ['high'],
      verification: 'native-grok-cli',
    },
    status: 'active',
  },
} as const satisfies Record<string, ModelPolicySpec>;

/**
 * The single active flagship of a family, computed from the registry markers.
 * Resolves to one literal id; flipping `flagship` in the registry moves every
 * annotation that uses this type with no second edit.
 */
export type FamilyFlagshipModelId<F extends AgentModelName> = {
  [K in RegisteredModelId]: ModelRegistry[K]['family'] extends F
    ? ModelRegistry[K]['flagship'] extends true
      ? ModelRegistry[K]['status'] extends 'active'
        ? K
        : never
      : never
    : never;
}[RegisteredModelId];

export interface ModelNamedDefault {
  readonly modelId: RegisteredModelId;
  /** Null delegates to the selected model's verified provider default, or the host default when unknown. */
  readonly reasoningEffort: ModelReasoningEffort | null;
}

export interface ModelRegistryEntryLike {
  readonly family: AgentModelName;
  readonly flagship: boolean;
  readonly status: 'active' | 'retired';
}

export type ModelRegistryLike = Record<string, ModelRegistryEntryLike>;
export type RegisteredModelId = keyof ModelRegistry;

type ModelRegistry = typeof MODEL_REGISTRY;

function claudeLaunch(
  input: Omit<ModelLaunchSpec, 'auth' | 'backend' | 'command' | 'provider' | 'transport'> & {
    readonly provider?: ModelNativeProviderSpec;
    readonly selector: string;
  },
): ModelLaunchSpec {
  return {
    ...input,
    auth: { mode: 'host-subscription', preflightArgv: ['claude', 'auth', 'status'] },
    backend: 'claude',
    command: 'claude',
    provider: input.provider ?? { id: 'anthropic', name: 'Anthropic subscription' },
    transport: 'claude-code',
  };
}

function codexLaunch(
  input: Omit<ModelLaunchSpec, 'auth' | 'backend' | 'command' | 'provider' | 'transport'> & {
    readonly auth?: ModelAuthSpec;
    readonly backend?: 'gpt' | typeof AGENT_BACKEND_GPT_OSS;
    readonly provider?: ModelNativeProviderSpec;
    readonly selector: string;
  },
): ModelLaunchSpec {
  const {
    auth = { mode: 'host-subscription', preflightArgv: ['codex', 'login', 'status'] },
    backend = 'gpt',
    provider = { id: 'openai', name: 'OpenAI subscription' },
    ...launch
  } = input;
  return { ...launch, auth, backend, command: 'codex', provider, transport: 'codex-cli' };
}

function grokLaunch(
  input: Omit<ModelLaunchSpec, 'auth' | 'backend' | 'command' | 'transport'> & { readonly selector: string },
): ModelLaunchSpec {
  return {
    ...input,
    auth: { mode: 'host-subscription', preflightArgv: ['grok', 'models'] },
    backend: 'xai',
    command: 'grok',
    transport: 'grok-build',
  };
}

export const MODEL_NAMED_DEFAULTS = {
  'ai-subagent.ask': { modelId: 'grok-4.5', reasoningEffort: 'high' },
  'ai-subagent.builder': { modelId: 'grok-4.5', reasoningEffort: 'high' },
  'ai-subagent.default': { modelId: 'gpt-5.6-terra', reasoningEffort: 'xhigh' },
  'ai-subagent.explorer': { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
  'ai-subagent.reviewer': { modelId: 'grok-4.5', reasoningEffort: 'high' },
} as const satisfies Record<ModelNamedDefaultName, ModelNamedDefault>;

const MODEL_REASONING_EFFORT_SET = new Set<string>(MODEL_REASONING_EFFORTS);
const MODEL_ID_BY_IDENTIFIER = buildModelIdentifierIndex(MODEL_REGISTRY);

validateCanonicalModelRegistry(MODEL_REGISTRY, MODEL_NAMED_DEFAULTS);

/**
 * Family flagships with the "exactly one active flagship per family" invariant
 * enforced: throws on a duplicate active flagship, and throws when any
 * `requiredFamilies` entry has none. Both failures surface at import time of
 * this module, not as an `undefined` at a distant call site.
 */
export function deriveLatestModelByFamily(
  registry: ModelRegistryLike,
  requiredFamilies: readonly string[] = [],
): Record<string, string> {
  const byFamily: Record<string, string> = {};
  for (const [id, spec] of registryEntries(registry)) {
    if (!spec.flagship || spec.status !== 'active') {
      continue;
    }
    const existing = byFamily[spec.family];
    if (existing !== undefined) {
      throw new Error(
        `model registry declares duplicate active flagships for family '${spec.family}': '${existing}' and '${id}'`,
      );
    }
    byFamily[spec.family] = id;
  }
  for (const family of requiredFamilies) {
    if (byFamily[family] === undefined) {
      throw new Error(`model registry declares no active flagship for family '${family}'`);
    }
  }
  return byFamily;
}

export function getModelPolicyEntry(modelIdOrAlias: string): ModelPolicySpec | undefined {
  const modelId = resolveRegisteredModelId(modelIdOrAlias);
  return modelId === null ? undefined : MODEL_REGISTRY[modelId];
}

export function resolveHighestStableModelReasoningEffort(modelIdOrAlias: string): ModelReasoningEffort | undefined {
  const modelId = resolveRegisteredModelId(modelIdOrAlias);
  if (modelId === null) {
    throw new Error(`Unknown model: ${modelIdOrAlias.trim()}.`);
  }
  return MODEL_REGISTRY[modelId].reasoning?.highestStableEffort;
}

/**
 * Resolve an explicit effort or the verified provider default for a model.
 * Unknown capability metadata is tolerated only when no explicit effort was
 * requested, in which case the host decides by receiving no override.
 */
export function resolveModelReasoningEffort(
  modelIdOrAlias: string,
  requestedEffort?: string,
): ModelReasoningEffort | undefined {
  const modelId = resolveRegisteredModelId(modelIdOrAlias);
  if (modelId === null) {
    throw new Error(`Unknown model: ${modelIdOrAlias.trim()}.`);
  }
  const reasoning: ModelReasoningSpec | null = MODEL_REGISTRY[modelId].reasoning;
  if (requestedEffort === undefined) {
    return reasoning?.providerDefault ?? undefined;
  }

  const normalizedEffort = requestedEffort.trim().toLowerCase();
  if (!MODEL_REASONING_EFFORT_SET.has(normalizedEffort)) {
    throw new Error(`unknown reasoning effort "${requestedEffort}" for model "${modelId}"`);
  }
  const effort = normalizedEffort as ModelReasoningEffort;
  if (reasoning === null) {
    throw new Error(
      `model "${modelId}" reasoning capabilities are unknown; omit reasoning_effort to use the host default`,
    );
  }
  if (!reasoning.supportedEfforts.includes(effort)) {
    throw new Error(`model "${modelId}" does not support reasoning effort "${effort}"`);
  }
  return effort;
}

export function resolveRegisteredModelId(modelIdOrAlias: string): null | RegisteredModelId {
  return MODEL_ID_BY_IDENTIFIER.get(normalizeModelIdentifierKey(modelIdOrAlias)) ?? null;
}

function buildModelIdentifierIndex(registry: Record<string, ModelPolicySpec>): Map<string, RegisteredModelId> {
  const byIdentifier = new Map<string, RegisteredModelId>();
  for (const [rawModelId, spec] of Object.entries(registry)) {
    const modelId = rawModelId as RegisteredModelId;
    for (const identifier of [modelId, ...spec.aliases]) {
      const key = normalizeModelIdentifierKey(identifier);
      if (key.length === 0) {
        throw new Error(`model registry entry "${modelId}" declares an empty id or alias`);
      }
      const prior = byIdentifier.get(key);
      if (prior !== undefined) {
        throw new Error(`model registry identifier "${identifier}" collides between "${prior}" and "${modelId}"`);
      }
      byIdentifier.set(key, modelId);
    }
  }
  return byIdentifier;
}

function normalizeModelIdentifierKey(value: string): string {
  return value.trim().toLowerCase();
}

function registryEntries(registry: ModelRegistryLike): [string, ModelRegistryEntryLike][] {
  return Object.entries(registry);
}

function validateCanonicalModelRegistry(
  registry: Record<string, ModelPolicySpec>,
  namedDefaults: Record<ModelNamedDefaultName, ModelNamedDefault>,
): void {
  for (const [modelId, spec] of Object.entries(registry)) {
    if (
      spec.reasoning?.providerDefault !== null &&
      spec.reasoning !== null &&
      !spec.reasoning.supportedEfforts.includes(spec.reasoning.providerDefault)
    ) {
      throw new Error(`model "${modelId}" provider reasoning default is not supported`);
    }
    if (spec.reasoning !== null && !spec.reasoning.supportedEfforts.includes(spec.reasoning.highestStableEffort)) {
      throw new Error(`model "${modelId}" highest stable reasoning effort is not supported`);
    }
    if (spec.launch !== null && MODEL_TRANSPORTS[spec.launch.transport].command !== spec.launch.command) {
      throw new Error(`model "${modelId}" transport command does not match its launch command`);
    }
  }

  for (const [name, namedDefault] of Object.entries(namedDefaults) as [ModelNamedDefaultName, ModelNamedDefault][]) {
    const spec = registry[namedDefault.modelId];
    if (spec === undefined || spec.status !== 'active' || spec.launch === null) {
      throw new Error(`named default "${name}" must reference an active launchable model`);
    }
    if (!spec.namedDefaultEligibility.includes(name)) {
      throw new Error(`model "${namedDefault.modelId}" is not eligible for named default "${name}"`);
    }
    if (namedDefault.reasoningEffort !== null) {
      const reasoning = spec.reasoning;
      if (reasoning === null || !reasoning.supportedEfforts.includes(namedDefault.reasoningEffort)) {
        throw new Error(
          `named default "${name}" requests unsupported reasoning effort "${namedDefault.reasoningEffort}"`,
        );
      }
    }
  }
}

/**
 * Family flagships, derived from the registry `flagship` markers with the
 * one-active-flagship-per-family invariant enforced at import time.
 *
 * NOTE: keyed by the three families in AGENT_MODEL_NAMES. `qwen` is a caller
 * family but has no first-party flagship.
 */
export const LATEST_MODEL_BY_FAMILY: Partial<Record<AgentModelName, string>> = deriveLatestModelByFamily(
  MODEL_REGISTRY,
  ['claude', 'gpt', 'xai'],
);

/** Stable accessor for the current flagship of a family. Callers depend on this name, not the backing map, so the source can later become a registry derivation without changing call sites. */
export function latestModelForFamily(family: AgentModelName): string {
  const modelId = LATEST_MODEL_BY_FAMILY[family];
  if (modelId === undefined) {
    throw new Error(`model registry declares no active flagship for family '${family}'`);
  }
  return modelId;
}
