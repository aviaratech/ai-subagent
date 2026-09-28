import type { AgentLaunchBehaviorOptions } from '../api/types.js';

const AUTONOMY_ENV_VAR = 'AI_AUTONOMY_MODE';
const DISABLED_AUTONOMY_VALUES = new Set(['0', 'false', 'no', 'off']);
const ENABLED_AUTONOMY_VALUES = new Set(['1', 'on', 'true', 'yes']);

export function isAutonomyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[AUTONOMY_ENV_VAR];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  if (DISABLED_AUTONOMY_VALUES.has(normalized)) {
    return false;
  }
  if (ENABLED_AUTONOMY_VALUES.has(normalized)) {
    return true;
  }

  // Keep autonomy enabled for unknown values to preserve prior behavior.
  return true;
}

export function shouldBypassAutomation(options: {
  behavior?: AgentLaunchBehaviorOptions;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const sandboxPreference = options.behavior?.sandbox;
  if (sandboxPreference === 'read-only' || sandboxPreference === 'workspace-write') {
    return false;
  }
  if (sandboxPreference === 'off') {
    return true;
  }
  return isAutonomyEnabled(options.env);
}

export function shouldBypassInteractive(options: {
  approvalProvided: boolean;
  enforceSandbox: boolean;
  env?: NodeJS.ProcessEnv;
  sandboxProvided: boolean;
  userProvidedBypass: boolean;
}): boolean {
  if (options.enforceSandbox) {
    return false;
  }
  if (options.approvalProvided || options.sandboxProvided || options.userProvidedBypass) {
    return false;
  }
  return isAutonomyEnabled(options.env);
}

export { AUTONOMY_ENV_VAR };
