import type { ModelLaunchSpec, ModelPolicySpec } from '../shared/modelPolicy.js';
import type { LaunchModel, ResolvedModel } from './types.js';

import { DEFAULT_MODEL_CONTEXT_WINDOW, MODEL_REGISTRY } from '../shared/modelPolicy.js';

export const DEFAULT_REGISTERED_CONTEXT_WINDOW = DEFAULT_MODEL_CONTEXT_WINDOW;

const MODEL_POLICY: Readonly<Record<string, ModelPolicySpec>> = MODEL_REGISTRY;

const MODELS = Object.entries(MODEL_POLICY)
  .filter(([, spec]) => spec.launch !== null)
  .sort(([, a], [, b]) => (a.launch?.rank ?? 0) - (b.launch?.rank ?? 0))
  .map(([id, spec]) => toLaunchModel(id, requireLaunchSpec(id, spec.launch)));

const MODEL_BY_KEY = new Map<string, LaunchModel>();
const MODEL_ALIAS_BY_KEY = new Map<string, string>();

for (const model of MODELS) {
  MODEL_BY_KEY.set(normalizeKey(model.id), model);
  const spec = MODEL_POLICY[model.id];
  if (spec === undefined) {
    throw new Error(`Launch model "${model.id}" is missing from canonical model policy.`);
  }
  for (const alias of spec.aliases) {
    MODEL_ALIAS_BY_KEY.set(normalizeKey(alias), model.id);
  }
}

export function getModelById(id: string): LaunchModel | undefined {
  return MODEL_BY_KEY.get(normalizeKey(id));
}

export function getRegisteredModelContextWindow(modelId: string): number | undefined {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const direct = MODEL_BY_KEY.get(normalizeKey(trimmed));
  if (typeof direct?.contextWindow === 'number' && Number.isFinite(direct.contextWindow)) {
    return direct.contextWindow;
  }
  return undefined;
}

export function listModels(): LaunchModel[] {
  return [...MODELS];
}

export function resolveModel(requested: string): ResolvedModel {
  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    throw new Error('Missing model name.');
  }

  const normalized = normalizeKey(trimmed);
  const direct = MODEL_BY_KEY.get(normalized);
  if (direct !== undefined) {
    return { model: direct, requested: trimmed, resolvedId: direct.id };
  }

  const aliasTarget = MODEL_ALIAS_BY_KEY.get(normalized);
  if (aliasTarget !== undefined) {
    const model = MODEL_BY_KEY.get(normalizeKey(aliasTarget));
    if (model !== undefined) {
      return { model, requested: trimmed, resolvedId: model.id };
    }
  }

  throw new Error(`Unknown model: ${trimmed}. Use \`pnpm exec ai models\` to list valid models.`);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function renderClaudeCodeModelSelector(input: { claudeCodeContext?: '1m'; providerModel: string }): string {
  const { claudeCodeContext, providerModel } = input;
  if (providerModel.trim().length === 0) {
    throw new Error('Claude provider model must not be empty.');
  }
  if (/[[\]]/.test(providerModel)) {
    throw new Error('Claude provider model must not include Claude Code context selectors.');
  }
  return claudeCodeContext === '1m' ? `${providerModel}[1m]` : providerModel;
}

function requireLaunchSpec(modelId: string, launch: ModelLaunchSpec | null): ModelLaunchSpec {
  if (launch === null) {
    throw new Error(`Active launch model "${modelId}" is missing launch metadata.`);
  }
  return launch;
}

function requireSelector(modelId: string, launch: ModelLaunchSpec): string {
  const selector = launch.selector?.trim();
  if (selector === undefined || selector.length === 0) {
    throw new Error(`Model "${modelId}" requires a non-empty provider selector.`);
  }
  return selector;
}

function toLaunchModel(id: string, launch: ModelLaunchSpec): LaunchModel {
  const common = {
    auth: launch.auth,
    backend: launch.backend,
    command: launch.command,
    ...(launch.contextWindow !== undefined ? { contextWindow: launch.contextWindow } : {}),
    description: launch.description,
    ...(launch.env !== undefined ? { env: { ...launch.env } } : {}),
    id,
    provider: launch.provider,
    transport: launch.transport,
  };

  if (launch.command === 'claude') {
    const providerModel = requireSelector(id, launch);
    const selectorInput =
      launch.claudeCodeContext === undefined
        ? { providerModel }
        : { claudeCodeContext: launch.claudeCodeContext, providerModel };
    return {
      ...common,
      args: ['--model', renderClaudeCodeModelSelector(selectorInput)],
      ...(launch.claudeCodeContext !== undefined ? { claudeCodeContext: launch.claudeCodeContext } : {}),
      providerModel,
    };
  }

  if (launch.command === 'codex') {
    const selector = requireSelector(id, launch);
    return {
      ...common,
      args: launch.codexOss === true ? ['--oss', '-m', selector] : ['-m', selector],
    };
  }

  const selector = requireSelector(id, launch);
  return { ...common, args: ['--model', selector] };
}
