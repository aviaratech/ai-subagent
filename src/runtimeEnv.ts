import { resolvePluginCredential } from './vendor/ai/index.js';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

const DEBUG_ENV_FLAG = 'AI_SUBAGENT_DEBUG_ENV';
const CODEX_DESKTOP_BINARY = '/Applications/Codex.app/Contents/Resources/codex';

export function buildSubagentRuntimeEnv(input: { env?: NodeJS.ProcessEnv } = {}) {
  const env = input.env ?? process.env;
  const runtimeEnv: NodeJS.ProcessEnv = { ...env };
  const forwardEnv = copyDefinedEnv(env);
  const logger =
    env[DEBUG_ENV_FLAG] === '1'
      ? (message: string) => {
          console.error(message);
        }
      : undefined;

  const openRouter = resolvePluginCredential({
    canonicalKey: 'OPENROUTER_API_KEY',
    claudeOptionKey: 'CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY',
    env,
    ...(logger ? { logger } : {}),
    pluginName: 'ai-subagent',
  });
  if (openRouter.value !== undefined) {
    runtimeEnv.OPENROUTER_API_KEY = openRouter.value;
    forwardEnv.OPENROUTER_API_KEY = openRouter.value;
  }

  const hostNativePath = resolveSubagentHostNativePath({ env });
  if (hostNativePath !== undefined) {
    runtimeEnv.PATH = hostNativePath;
    forwardEnv.PATH = hostNativePath;
  }

  return { forwardEnv, runtimeEnv };
}

export function resolveSubagentHostNativePath(input: {
  codexDesktopBinary?: string;
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string | undefined {
  const pathValue = input.env.PATH;
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    return undefined;
  }

  const exists = input.exists ?? existsSync;
  const overrideBinary = input.env.AI_SUBAGENT_CODEX_BINARY;
  const candidateBinaries = [
    ...(typeof overrideBinary === 'string' && overrideBinary.trim().length > 0 ? [overrideBinary.trim()] : []),
    input.codexDesktopBinary ?? CODEX_DESKTOP_BINARY,
  ];

  const codexBinary = candidateBinaries.find(candidate => exists(candidate));
  if (codexBinary === undefined) {
    return pathValue;
  }

  const codexDir = dirname(codexBinary);
  const pathParts = pathValue.split(delimiter).filter(part => part.length > 0 && part !== codexDir);
  return [codexDir, ...pathParts].join(delimiter);
}

function copyDefinedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
