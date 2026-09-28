import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface ContextFileResult {
  contextPath: string;
  promptPath: string;
}

const DEFAULT_CONTEXT_DIR = ['.ai', 'state', 'contexts'];

export function buildContextReadPrompt(contextPath: string): string {
  return `Read ${contextPath} for complete project context.`;
}

export function writeContextFile(options: {
  fileName: string;
  projectRoot: string;
  prompt: string;
}): ContextFileResult {
  const contextDir = resolve(options.projectRoot, ...DEFAULT_CONTEXT_DIR);
  if (!existsSync(contextDir)) {
    mkdirSync(contextDir, { recursive: true });
  }

  const contextPath = resolve(contextDir, options.fileName);
  writeFileSync(contextPath, options.prompt, 'utf8');

  return {
    contextPath,
    promptPath: resolvePromptPath(options.projectRoot, contextPath),
  };
}

function resolvePromptPath(projectRoot: string, contextPath: string): string {
  const relativePath = relative(projectRoot, contextPath);
  if (relativePath.length === 0 || relativePath.startsWith('..')) {
    return contextPath;
  }
  return relativePath;
}
