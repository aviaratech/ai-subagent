/**
 * Shared type definitions for the provider runtime
 *
 * but are now defined locally to decouple the packages.
 */

/**
 * Configuration for agent documentation discovery and loading.
 */
export interface AgentDocsConfig {
  agentsExclude?: string[];
  agentsInclude?: string[];
  agentsLimit?: number;
}

/**
 * Semantic type alias for agent identity (e.g., "claude-builder", "gpt-reviewer").
 * Used when configuring agent context and settings.
 *
 * Note: This is a semantic type alias for documentation purposes. While SonarJS suggests
 * using string directly, we keep this alias to maintain API clarity and allow for
 * future type refinements without breaking changes.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type AgentIdentity = string;
