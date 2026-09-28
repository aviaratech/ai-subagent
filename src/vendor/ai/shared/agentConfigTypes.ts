export interface AgentConfig {
  /** Flag for approval/permission mode (e.g., --permission-mode) */
  approvalFlag: string;

  /** Short form of approval flag if any (e.g., -a for GPT via Codex CLI) */
  approvalFlagShort?: string;

  /** CLI binary name (usually same as agent name) */
  binary: string;

  /** Flag to bypass all approvals/sandbox (e.g., --dangerously-skip-permissions or --dangerously-bypass-approvals-and-sandbox) */
  bypassFlag: string;

  /** Short form of bypass flag if any (e.g., -y for gemini) */
  bypassFlagShort?: string;

  /** Context file name (e.g., claude-context.txt) */
  contextFileName: string;

  /** Whether to handle --cd flag (Codex CLI specific) */
  handleCdFlag?: boolean;

  /** Env var name for seeding initial message in interactive mode */
  initialMessageEnvVar?: string;

  /** Install instructions shown when CLI not found */
  installInstructions: string[];

  /** Hook to load additional settings (claude-specific for .claude/settings.local.json) */
  loadSettings?: (projectRoot: string) => AgentSettings;

  /** Max prompt length for sanitization */
  maxPromptLength?: number;

  /** Agent name used for display and file naming */
  name: AgentName;

  /** Sandbox-specific flag if separate from approval (e.g., --sandbox) */
  sandboxFlag?: string;

  /** Short form of sandbox flag (e.g., -s) */
  sandboxFlagShort?: string;

  /** Whether to sanitize/truncate prompt (Codex CLI specific) */
  sanitizePrompt?: boolean;

  /** Whether to resolve git root for cwd (Codex CLI specific) */
  useGitRoot?: boolean;
}

export type AgentName = AgentModelName;

export interface AgentSettings {
  instructions?: string;
  model?: string;
}
import type { AgentModelName } from './agentConstants.js';
