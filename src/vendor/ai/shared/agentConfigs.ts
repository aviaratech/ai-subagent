import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentConfig, AgentSettings } from './agentConfigTypes.js';
import type { GPT_CLI_COMMAND } from './agentConstants.js';

import { BINARY_GPT } from '../targets/constants.js';
import { AGENT_MODEL_CLAUDE, AGENT_MODEL_GEMINI, AGENT_MODEL_GPT, GROK_CLI_COMMAND } from './agentConstants.js';

function loadClaudeSettings(projectRoot: string): AgentSettings {
  const config: AgentSettings = {};

  // Load .claude/settings.local.json if it exists
  const settingsPath = resolve(projectRoot, '.claude', 'settings.local.json');
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        instructions?: unknown;
        model?: unknown;
      };
      if (typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
        config.model = parsed.model.trim();
      }
      if (typeof parsed.instructions === 'string' && parsed.instructions.trim().length > 0) {
        config.instructions = parsed.instructions.trim();
      }
    } catch (error) {
      console.warn('⚠️  Warning: Could not parse .claude/settings.local.json', error);
    }
  }

  return config;
}

export const CLAUDE_CONFIG: AgentConfig = {
  approvalFlag: '--permission-mode',
  binary: 'claude',
  bypassFlag: '--dangerously-skip-permissions',
  contextFileName: 'claude-context.txt',
  initialMessageEnvVar: 'CLAUDE_INITIAL_MESSAGE',
  installInstructions: [
    '1. Install Claude Code CLI: https://www.anthropic.com/claude-code',
    '2. Use Claude VS Code extension (auto-loads .claude/settings.local.json)',
  ],
  loadSettings: loadClaudeSettings,
  name: AGENT_MODEL_CLAUDE,
};

export const GPT_CONFIG: AgentConfig = {
  approvalFlag: '--ask-for-approval',
  approvalFlagShort: '-a',
  binary: BINARY_GPT,
  bypassFlag: '--dangerously-bypass-approvals-and-sandbox',
  contextFileName: 'gpt-context.txt',
  handleCdFlag: true,
  initialMessageEnvVar: 'CODEX_INITIAL_MESSAGE',
  installInstructions: [
    '1. Install Codex CLI: https://github.com/openai/codex',
    '2. Use VS Code Codex extension (auto-loads .codex/config.toml)',
  ],
  maxPromptLength: 12000,
  name: AGENT_MODEL_GPT,
  sandboxFlag: '--sandbox',
  sandboxFlagShort: '-s',
  sanitizePrompt: true,
  useGitRoot: true,
};

export const GEMINI_CONFIG: AgentConfig = {
  approvalFlag: '--approval-mode',
  binary: 'gemini',
  bypassFlag: '--yolo',
  bypassFlagShort: '-y',
  contextFileName: 'gemini-context.txt',
  installInstructions: [
    '1. Install Gemini CLI: pnpm install -g @google/gemini-cli',
    '2. See: https://github.com/google-gemini/gemini-cli',
  ],
  name: AGENT_MODEL_GEMINI,
  sandboxFlag: '--sandbox',
  sandboxFlagShort: '-s',
};

type AgentConfigKey = AgentConfig['name'] | typeof GPT_CLI_COMMAND | typeof GROK_CLI_COMMAND;

export function getAgentConfig(agent: AgentConfigKey): AgentConfig {
  if (agent === GROK_CLI_COMMAND) {
    throw new Error(
      'The native Grok transport is available only through the ai-subagent trusted-local builder preset.',
    );
  }
  if (agent === AGENT_MODEL_CLAUDE) {
    return CLAUDE_CONFIG;
  }
  if (agent === AGENT_MODEL_GEMINI) {
    return GEMINI_CONFIG;
  }
  return GPT_CONFIG;
}
