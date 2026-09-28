export interface PluginCredentialResolution {
  source?: 'alias' | 'canonical' | 'claude_option';
  sourceKey?: string;
  value?: string;
}

export interface ResolvePluginCredentialOptions {
  aliases?: string[];
  canonicalKey: string;
  claudeOptionKey?: string;
  env?: NodeJS.ProcessEnv;
  logger?: (message: string) => void;
  pluginName?: string;
}

export function resolvePluginCredential(options: ResolvePluginCredentialOptions): PluginCredentialResolution {
  const env = options.env ?? process.env;
  const candidates: {
    key: string;
    source: 'alias' | 'canonical' | 'claude_option';
  }[] = [{ key: options.canonicalKey, source: 'canonical' }];

  if (options.claudeOptionKey) {
    candidates.push({ key: options.claudeOptionKey, source: 'claude_option' });
  }

  for (const alias of options.aliases ?? []) {
    candidates.push({ key: alias, source: 'alias' });
  }

  for (const candidate of candidates) {
    const value = readUsableCredentialValue(env[candidate.key]);
    if (value === undefined) {
      continue;
    }

    if (options.logger) {
      const prefix = options.pluginName ? `[${options.pluginName}] ` : '';
      options.logger(`${prefix}resolved ${options.canonicalKey} from ${candidate.key}`);
    }

    return {
      source: candidate.source,
      sourceKey: candidate.key,
      value,
    };
  }

  return {};
}

function readUsableCredentialValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^\$\{[^}]+\}$/.test(trimmed)) {
    return undefined;
  }

  return value;
}
