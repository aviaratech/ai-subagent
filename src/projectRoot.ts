import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolve the caller's working directory without imposing repository workflow.
 */
export function validateSubagentProjectRoot(projectRoot: string): string {
  try {
    const canonicalProjectRoot = realpathSync(resolve(projectRoot));
    if (!statSync(canonicalProjectRoot).isDirectory()) {
      throw new Error('not a directory');
    }
    return canonicalProjectRoot;
  } catch {
    throw new Error('invalid_subagent_project_root: expected an existing readable directory.');
  }
}
