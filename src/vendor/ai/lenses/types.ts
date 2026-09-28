import type { AgentModelName } from '../shared/agentConstants.js';

export interface LensCatalog {
  defaultLens: string;
  lenses: Record<string, LensDefinition>;
  maxLenses: number;
  version: string;
}

export type LensCatalogInput = LensCatalog;

export interface LensDefinition {
  activationHints: string[];
  defaultBlocking: boolean;
  description: string;
  model: AgentModelName;
  promptPath: string;
  scope: LensScope;
}

export type LensScope = 'both' | 'epic' | 'pr';
