import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { LensCatalog, LensDefinition } from './types.js';

const CATALOG_PATH_PARTS = ['ops', 'ai', 'lenses', 'catalog.json'];

export function getLensDefinition(options: { lens: string; projectRoot: string }): LensDefinition {
  const lensName = options.lens.trim();
  if (lensName.length === 0) {
    throw new Error('Lens name must be non-empty.');
  }
  const catalog = loadLensCatalog(options.projectRoot);
  const definition = catalog.lenses[lensName];
  if (!definition) {
    const available = Object.keys(catalog.lenses)
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
    throw new Error(`Unknown lens "${lensName}". Available lenses: ${available}`);
  }
  return definition;
}

export function getLensPrompt(options: { lens: string; projectRoot: string }): string {
  const definition = getLensDefinition(options);
  const promptPath = resolve(options.projectRoot, definition.promptPath);
  if (!existsSync(promptPath)) {
    throw new Error(`Lens prompt not found for "${options.lens}" at ${promptPath}`);
  }
  return readFileSync(promptPath, 'utf8').trim();
}

export function loadLensCatalog(projectRoot: string): LensCatalog {
  const catalogPath = resolve(projectRoot, ...CATALOG_PATH_PARTS);
  if (!existsSync(catalogPath)) {
    throw new Error(`Lens catalog not found at ${catalogPath}`);
  }
  const raw = readFileSync(catalogPath, 'utf8');
  try {
    return JSON.parse(raw) as LensCatalog;
  } catch (error) {
    throw new Error(
      `Failed to parse lens catalog (${catalogPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type { LensCatalog, LensDefinition } from './types.js';
