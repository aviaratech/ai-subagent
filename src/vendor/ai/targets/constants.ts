/**
 * Canonical constants for AI launch binary resolution.
 *
 * The CLI binary name differs from the logical agent name for GPT
 * (executable is 'codex').
 *
 * Add additional constants here as they gain consumers.
 */

import type { AgentRuntimeMode } from '../api/types.js';

// --- CLI Binary Names (actual executables on disk) ---
export const BINARY_GPT = 'codex' as const;
/** Resolve the native Codex binary without repository-specific wrappers. */
export function resolveGptLaunchBinary(_options: {
  env?: NodeJS.ProcessEnv;
  projectRoot: string;
  runtimeMode?: AgentRuntimeMode;
}): string {
  return BINARY_GPT;
}
