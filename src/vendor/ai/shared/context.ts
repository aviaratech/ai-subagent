import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import fg from 'fast-glob';

import { getAgentDocsConfig } from './assistantConfig.js';
import type { AgentRole } from './rolePreambles.js';
import { filterContentForRole, getRolePreambleForRole } from './rolePreambles.js';
import type { AgentDocsConfig } from './types.js';

/**
 * Structured context section passed by a model-launch caller.
 */
export interface ContextSection {
  body: string;
  heading: string;
}

interface AgentDocument {
  content: string;
  path: string;
  relativePath: string;
  type: AgentDocumentType;
}

interface AgentDocumentCount {
  loaded: number;
  total: number;
}

type AgentDocumentType = 'agent' | 'readme';

/**
 * Options for loading agent documents.
 */
interface LoadAgentDocumentsOptions {
  /**
   * Explicit role for content filtering.
   */
  role?: AgentRole;
}
const ROOT_CONSTITUTION_DOC = 'CONSTITUTION.md';
const ROOT_AGENTS_DOC = 'AGENTS.md';
const ROOT_README_DOC = 'README.md';
const ROOT_WORKFLOW_DOC = 'WORKFLOW_REFERENCE.md';
const QUALITY_CHARTER_DOC = join('docs', 'process', 'quality-charter.md');
const VALUE_GATE_DOC = join('docs', 'process', 'value-gate.md');
const ADDITIONAL_DOC_EXCERPT_LIMIT = 500;
const SECTION_SEPARATOR = '\n\n---\n\n';
const DEFAULT_AGENT_DOC_INCLUDE_PATTERNS = [
  ROOT_CONSTITUTION_DOC,
  ROOT_AGENTS_DOC,
  QUALITY_CHARTER_DOC,
  VALUE_GATE_DOC,
  '**/AGENTS*.md',
];
const DEFAULT_AGENT_DOC_EXCLUDE_PATTERNS = [
  'node_modules/**',
  '**/node_modules/**',
  '.git/**',
  '**/.git/**',
  '.worktrees/**',
  '**/.worktrees/**',
  '.ai/worktrees/**',
  '**/.ai/worktrees/**',
  '.claude/worktrees/**',
  '**/.claude/worktrees/**',
  '.history/**',
  '**/.history/**',
  '.local/**',
  '**/.local/**',
  '.turbo/**',
  '**/.turbo/**',
  'build/**',
  '**/build/**',
  'coverage/**',
  '**/coverage/**',
  'dist/**',
  '**/dist/**',
];
const ON_DEMAND_REFERENCE_DOC_RELATIVE_PATHS = [ROOT_WORKFLOW_DOC, ROOT_README_DOC, '.codex/config.toml'];
const PRIMARY_DOC_RELATIVE_PATHS = new Set([
  QUALITY_CHARTER_DOC,
  ROOT_AGENTS_DOC,
  ROOT_CONSTITUTION_DOC,
  VALUE_GATE_DOC,
]);
const REVIEWER_PRIMARY_DOC_RELATIVE_PATHS = new Set([ROOT_AGENTS_DOC, ROOT_CONSTITUTION_DOC, VALUE_GATE_DOC]);

export interface ProjectContextSnapshotOptions {
  projectRoot: string;
  role?: AgentRole;
}

interface BuildBaseContextOptions {
  customInstructions?: string;
  projectRoot: string;
  /**
   * Explicit role for this agent.
   * When provided, uses this role for preamble and content filtering.
   */
  role?: AgentRole;
}

interface BuildBaseContextParts {
  prefix: string;
  workflowInstructions: string;
}

interface BuildContextOptions extends BuildBaseContextOptions {
  /**
   * Context sections supplied by the caller.
   * These render before workflow/reference documentation so task context
   * appears before long docs.
   */
  context?: ContextSection[];
}

interface ContextDocumentStats {
  agents: AgentDocumentCount;
  readmes: AgentDocumentCount;
  totalDiscovered: number;
  totalLoaded: number;
}

interface LoadAgentDocumentsResult {
  documents: AgentDocument[];
  stats: ContextDocumentStats;
}

const PROJECT_CONTEXT_SNAPSHOT_HEADING = 'Project Context Snapshot';

/**
 * Build the canonical agent context prompt.
 */
export function buildAgentContext({ context, customInstructions, projectRoot, role }: BuildContextOptions): string {
  const baseContextOptions: BuildBaseContextOptions = {
    projectRoot,
    ...(customInstructions !== undefined ? { customInstructions } : {}),
    ...(role !== undefined ? { role } : {}),
  };
  const contextParts = buildBaseContextParts(baseContextOptions);
  let prompt = contextParts.prefix;

  // Render caller-provided task/issue context before reference docs.
  if (context !== undefined && context.length > 0) {
    const rendered = renderContextSections(context);
    if (rendered.length > 0) {
      prompt += rendered;
      if (contextParts.workflowInstructions.length > 0) {
        prompt += SECTION_SEPARATOR;
      }
    }
  }

  prompt += contextParts.workflowInstructions;
  return prompt;
}

/**
 * Build the shared base context used by API and CLI launch paths.
 */
export function buildBaseContext({ customInstructions, projectRoot, role }: BuildBaseContextOptions): string {
  const contextParts = buildBaseContextParts({
    ...(customInstructions !== undefined ? { customInstructions } : {}),
    projectRoot,
    ...(role !== undefined ? { role } : {}),
  });
  return `${contextParts.prefix}${contextParts.workflowInstructions}`;
}

export function createProjectContextSnapshot({ projectRoot, role }: ProjectContextSnapshotOptions): ContextSection[] {
  const loadOptions = buildLoadAgentDocumentsOptions(role);
  const { documents } = loadAgentDocuments(projectRoot, loadOptions);
  if (documents.length === 0) {
    return [];
  }

  const body = renderWorkflowInstructions(documents, role === 'reviewer').trim();
  if (body.length === 0) {
    return [];
  }

  return [
    {
      body,
      heading: PROJECT_CONTEXT_SNAPSHOT_HEADING,
    },
  ];
}

/**
 * Discover AGENTS documentation that should seed agent sessions. Applies the
 * configured include/exclude globs and returns the content plus relative paths.
 * When role is provided, filters out sections not relevant to the role.
 */
export function loadAgentDocuments(projectRoot: string, options?: LoadAgentDocumentsOptions): LoadAgentDocumentsResult {
  const role = options?.role;
  const docConfig: AgentDocsConfig = getAgentDocsConfig(projectRoot);
  const includePatterns = resolveIncludePatterns(DEFAULT_AGENT_DOC_INCLUDE_PATTERNS, docConfig);
  const excludePatterns = resolveExcludePatterns(DEFAULT_AGENT_DOC_EXCLUDE_PATTERNS, docConfig);
  const limit = docConfig.agentsLimit ?? 50;

  const determineType = (file: string): AgentDocumentType => {
    const fileName = basename(file).toLowerCase();
    if (fileName.startsWith('readme')) {
      return 'readme';
    }
    return 'agent';
  };

  const files = fg.sync(includePatterns, {
    absolute: true,
    cwd: projectRoot,
    dot: false,
    followSymbolicLinks: false,
    ignore: excludePatterns,
    onlyFiles: true,
  });

  const uniquePaths = Array.from(new Set(files));
  const sortedPaths = sortDocumentPaths({
    determineType,
    paths: uniquePaths,
    projectRoot,
  });
  const { agentPaths, readmePaths } = splitPathsByType(sortedPaths, determineType);
  const limited = limitPaths({ agentPaths, limit, readmePaths });

  const totalAgents = agentPaths.length;
  const totalReadmes = readmePaths.length;

  if (limited.length === 0) {
    console.warn('⚠️  Warning: No agent context docs found for the configured include patterns.');
  } else if (uniquePaths.length > limited.length) {
    console.log(`ℹ️  Loaded ${String(limited.length)} context docs (limit ${String(limit)}). Remaining files skipped.`);
  }

  const stats: ContextDocumentStats = {
    agents: { loaded: 0, total: totalAgents },
    readmes: { loaded: 0, total: totalReadmes },
    totalDiscovered: totalAgents + totalReadmes,
    totalLoaded: 0,
  };

  const docs: AgentDocument[] = [];
  for (const file of limited) {
    const loadedDoc = loadAgentDocument({
      determineType,
      file,
      projectRoot,
      role,
    });
    if (loadedDoc === undefined) {
      continue;
    }
    if (loadedDoc.type === 'agent') {
      stats.agents.loaded += 1;
    } else {
      stats.readmes.loaded += 1;
    }
    stats.totalLoaded += 1;
    docs.push(loadedDoc);
  }

  return { documents: docs, stats };
}

/**
 * Render ContextSection entries as markdown.
 */
export function renderContextSections(sections: ContextSection[]): string {
  const rendered: string[] = [];
  for (const section of sections) {
    const heading = section.heading.trim();
    const body = section.body.trim();
    if (heading.length === 0 && body.length === 0) {
      continue;
    }
    if (heading.length === 0) {
      rendered.push(body);
      continue;
    }
    if (body.length === 0) {
      rendered.push(`## ${heading}`);
      continue;
    }
    rendered.push(`## ${heading}\n\n${body}`);
  }
  return rendered.join('\n\n');
}

function applyRoleFilter(options: { content: string; role: AgentRole | undefined }): string {
  return filterContentForRole(options.content, options.role);
}

function buildBaseContextParts({
  customInstructions,
  projectRoot,
  role,
}: BuildBaseContextOptions): BuildBaseContextParts {
  const loadOptions = buildLoadAgentDocumentsOptions(role);
  const { documents: agentDocs } = loadAgentDocuments(projectRoot, loadOptions);
  const isReviewer = role === 'reviewer';
  let prompt = '';
  if (role !== undefined) {
    const rolePreamble = getRolePreambleForRole(role);
    prompt += `${rolePreamble}${SECTION_SEPARATOR}`;
  }

  prompt += '# Project Context\n\n';

  if (typeof customInstructions === 'string' && customInstructions.length > 0) {
    prompt += `${customInstructions}\n\n`;
  }

  return {
    prefix: prompt,
    workflowInstructions: renderWorkflowInstructions(agentDocs, isReviewer),
  };
}

function buildLoadAgentDocumentsOptions(role: AgentRole | undefined): LoadAgentDocumentsOptions | undefined {
  return role === undefined ? undefined : { role };
}

function limitPaths(options: { agentPaths: string[]; limit: number; readmePaths: string[] }): string[] {
  const limited: string[] = [];
  for (const file of options.agentPaths) {
    if (limited.length >= options.limit) {
      break;
    }
    limited.push(file);
  }
  if (limited.length < options.limit) {
    for (const file of options.readmePaths) {
      if (limited.length >= options.limit) {
        break;
      }
      limited.push(file);
    }
  }
  return limited;
}

function loadAgentDocument(options: {
  determineType: (file: string) => AgentDocumentType;
  file: string;
  projectRoot: string;
  role: AgentRole | undefined;
}): AgentDocument | undefined {
  try {
    const rawContent = readFileSync(options.file, 'utf8').trim();
    if (rawContent.length === 0) {
      return undefined;
    }
    const relativePath = relative(options.projectRoot, options.file) || basename(options.file);
    const content = applyRoleFilter({
      content: rawContent,
      role: options.role,
    });
    const type = options.determineType(options.file);
    return {
      content,
      path: options.file,
      relativePath,
      type,
    };
  } catch (error) {
    console.warn(
      `⚠️  Warning: Unable to read ${options.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function renderOnDemandDocumentationSection(agentDocs: AgentDocument[], isReviewer: boolean): string {
  if (isReviewer) {
    return '';
  }

  const loadedPaths = new Set(agentDocs.map(doc => doc.relativePath));
  const onDemandPaths = ON_DEMAND_REFERENCE_DOC_RELATIVE_PATHS.filter(path => !loadedPaths.has(path));
  if (onDemandPaths.length === 0) {
    return '';
  }

  let section = '### On-Demand Documentation\n\n';
  section += 'Load these references only when the task explicitly needs them:\n\n';
  for (const path of onDemandPaths) {
    section += `- ${path}\n`;
  }
  section += '\n';

  return section;
}

function renderWorkflowInstructions(agentDocs: AgentDocument[], isReviewer: boolean): string {
  if (agentDocs.length === 0) {
    return '';
  }

  const primaryDocPaths = isReviewer ? REVIEWER_PRIMARY_DOC_RELATIVE_PATHS : PRIMARY_DOC_RELATIVE_PATHS;
  const primaryDocs = agentDocs.filter(doc => primaryDocPaths.has(doc.relativePath));
  const otherDocs = agentDocs.filter(doc => !primaryDocPaths.has(doc.relativePath));
  let instructions = '## Workflow Instructions\n\n';

  for (const doc of primaryDocs) {
    instructions += `### ${doc.relativePath}\n\n`;
    instructions += `${doc.content}\n\n`;
  }

  if (otherDocs.length > 0) {
    instructions += '### Additional Documentation\n\n';
    instructions += 'The following documentation files are available for reference:\n\n';
    for (const doc of otherDocs) {
      if (isReviewer) {
        instructions += `- ${doc.relativePath}\n`;
        continue;
      }

      const excerpt = doc.content.slice(0, ADDITIONAL_DOC_EXCERPT_LIMIT).trim();
      const truncated = doc.content.length > ADDITIONAL_DOC_EXCERPT_LIMIT;
      instructions += `**${doc.relativePath}**\n`;
      instructions += `${excerpt}${truncated ? '...\n\n_(Read full file for complete documentation)_' : ''}\n\n`;
    }

    if (isReviewer) {
      instructions += '\n';
    }
  }

  instructions += renderOnDemandDocumentationSection(agentDocs, isReviewer);
  return instructions;
}

function resolveExcludePatterns(defaultExcludePatterns: string[], docConfig: AgentDocsConfig | undefined): string[] {
  const excludeOverrides = docConfig?.agentsExclude;
  return excludeOverrides && excludeOverrides.length > 0
    ? Array.from(new Set([...defaultExcludePatterns, ...excludeOverrides]))
    : defaultExcludePatterns;
}

function resolveIncludePatterns(defaultIncludePatterns: string[], docConfig: AgentDocsConfig | undefined): string[] {
  const includeOverrides = docConfig?.agentsInclude;
  return includeOverrides && includeOverrides.length > 0
    ? Array.from(new Set([...defaultIncludePatterns, ...includeOverrides]))
    : defaultIncludePatterns;
}

function sortDocumentPaths(options: {
  determineType: (file: string) => AgentDocumentType;
  paths: string[];
  projectRoot: string;
}): string[] {
  const { determineType, projectRoot } = options;
  const rootConstitution = resolve(projectRoot, ROOT_CONSTITUTION_DOC);
  const rootAgents = resolve(projectRoot, ROOT_AGENTS_DOC);
  const rootReadme = resolve(projectRoot, ROOT_README_DOC);
  const sorted = [...options.paths];

  sorted.sort((a, b) => {
    if (a === rootConstitution) {
      return -1;
    }
    if (b === rootConstitution) {
      return 1;
    }
    if (a === rootAgents) {
      return -1;
    }
    if (b === rootAgents) {
      return 1;
    }
    if (a === rootReadme) {
      return -1;
    }
    if (b === rootReadme) {
      return 1;
    }

    const typeRank = (determineType(a) === 'readme' ? 1 : 0) - (determineType(b) === 'readme' ? 1 : 0);
    if (typeRank !== 0) {
      return typeRank;
    }
    return a.localeCompare(b);
  });

  return sorted;
}

function splitPathsByType(
  paths: string[],
  determineType: (file: string) => AgentDocumentType,
): {
  agentPaths: string[];
  readmePaths: string[];
} {
  const agentPaths: string[] = [];
  const readmePaths: string[] = [];
  for (const file of paths) {
    if (determineType(file) === 'agent') {
      agentPaths.push(file);
    } else {
      readmePaths.push(file);
    }
  }
  return { agentPaths, readmePaths };
}
