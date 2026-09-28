import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MODEL_REASONING_EFFORTS } from './vendor/ai/index.js';
import { createMcpServer, isMcpServerEntry, startMcpServerStdio, textResponse } from './vendor/plugin-core/index.js';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v3';

import { createSubagentService, type SubagentService } from './subagentService.js';

interface CloseToolInput {
  target: string;
}

type ProcessCleanupEvent = 'beforeExit' | 'SIGINT' | 'SIGTERM';
interface ProcessCleanupTarget {
  exit: (code?: number) => never | void;
  once: (event: ProcessCleanupEvent, listener: () => void) => unknown;
  stdin?: {
    once: (event: StdinCleanupEvent, listener: () => void) => unknown;
  };
}

interface RegisterProcessCleanupOptions {
  logError?: (error: unknown) => void;
  target?: ProcessCleanupTarget;
}

interface RegisterToolInput<TInput extends object> {
  definition: {
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (input: TInput) => ToolResponse;
  name: string;
}

interface ResumeToolInput {
  id: string;
}

interface SendToolInput {
  interrupt?: boolean;
  items?: unknown[];
  message?: string;
  target: string;
}

interface SpawnToolInput {
  agent_type?: string;
  fork_context?: boolean;
  items?: unknown[];
  message?: string;
  model?: string;
  project_root?: string;
  purpose?: string;
  reasoning_effort?: string;
  service_tier?: string;
}

type StdinCleanupEvent = 'close' | 'end';

interface SubagentMcpServerOptions {
  defaultProjectRoot?: () => string | undefined;
  service?: SubagentService;
}

type ToolResponse = Promise<{ content: { text: string; type: 'text' }[] }>;

interface WaitToolInput {
  include_output?: boolean;
  targets: string[];
  timeout_ms?: number;
}

export function createSubagentMcpServer(options?: SubagentMcpServerOptions): McpServer {
  const service = options?.service ?? createSubagentService();
  const resolveDefaultProjectRoot = options?.defaultProjectRoot ?? (() => undefined);
  const server = createMcpServer({ name: 'ai-subagent', version: '0.1.0' });
  const rawRegister = server.registerTool.bind(server) as unknown as (...args: unknown[]) => void;
  function registerTool<TInput extends object>(input: RegisterToolInput<TInput>): void {
    rawRegister(input.name, input.definition, input.handler);
  }

  registerTool<SpawnToolInput>({
    definition: {
      description:
        'Start a provider-backed child. Save its id to poll, continue its conversation, or resume it after host disconnect; close is deliberately destructive.',
      inputSchema: {
        agent_type: z.string().optional().describe('Subagent preset: builder, reviewer, ask, explorer, default'),
        fork_context: z
          .boolean()
          .optional()
          .describe(
            'Native-compatible fork request; the service capability-gates the selected model and exact source binding',
          ),
        items: z.array(z.unknown()).optional().describe('Native-compatible item payloads to render into the turn'),
        message: z.string().optional().describe('Initial message; when provided, spawn_agent starts the first turn'),
        model: z.string().optional().describe('Registered model id override'),
        project_root: z.string().optional().describe('Repo/worktree root for the subagent'),
        purpose: z
          .string()
          .optional()
          .describe('Concise delegation purpose used only to select relevant installed skills'),
        reasoning_effort: z
          .enum(MODEL_REASONING_EFFORTS)
          .optional()
          .describe('Reasoning effort for models that support it'),
        service_tier: z
          .string()
          .optional()
          .describe('Native-compatible field; currently fails loudly because ai-subagent cannot select service tiers'),
      },
    },
    handler: async input => {
      assertSupportedSpawnToolOptions(input);
      const projectRoot = await resolveProjectRoot({
        inputProjectRoot: input.project_root,
        resolveDefaultProjectRoot,
        server,
      });
      const result = await service.spawnAgent({
        ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
        ...(input.fork_context !== undefined ? { forkContext: input.fork_context } : {}),
        ...(input.items !== undefined ? { items: input.items } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.reasoning_effort !== undefined ? { reasoningEffort: input.reasoning_effort } : {}),
        ...(input.service_tier !== undefined ? { serviceTier: input.service_tier } : {}),
      });
      return textResponse(JSON.stringify(result));
    },
    name: 'spawn_agent',
  });

  registerTool<SendToolInput>({
    definition: {
      description:
        'Continue an open provider-backed child in the same provider conversation. Queue input, or replace an interruptible active turn.',
      inputSchema: {
        interrupt: z
          .boolean()
          .optional()
          .describe('Interrupt the active turn before starting this replacement; unsupported transports fail closed'),
        items: z.array(z.unknown()).optional().describe('Native-compatible item payloads to render into the turn'),
        message: z.string().optional().describe('Message to send to the subagent'),
        target: z.string().describe('Subagent id returned by spawn_agent or resume_agent'),
      },
    },
    handler: async input => {
      const result = await service.sendInput({
        ...(input.interrupt !== undefined ? { interrupt: input.interrupt } : {}),
        ...(input.items !== undefined ? { items: input.items } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        target: input.target,
      });
      return textResponse(JSON.stringify(result));
    },
    name: 'send_input',
  });

  registerTool<WaitToolInput>({
    definition: {
      description:
        'Observe provider-backed children without cancelling them. Use timeout_ms=0 with include_output=false to poll sanitized health; timeout_ms limits only this observation.',
      inputSchema: {
        include_output: z
          .boolean()
          .optional()
          .describe('When false, return output metadata without delivering or consuming the output body'),
        targets: z.array(z.string()).describe('Subagent ids to wait on'),
        timeout_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Maximum observation wait in milliseconds; never a child deadline'),
      },
    },
    handler: async input => {
      const result = await service.waitAgent({
        ...(input.include_output !== undefined ? { includeOutput: input.include_output } : {}),
        targets: input.targets,
        ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      });
      return textResponse(JSON.stringify(result));
    },
    name: 'wait_agent',
  });

  registerTool<ResumeToolInput>({
    definition: {
      description:
        'Rehydrate a child suspended by MCP/host disconnect, then continue it with send_input. Explicitly closed children cannot resume; unsupported durable sessions fail closed.',
      inputSchema: {
        id: z.string().describe('Subagent id to resume'),
      },
    },
    handler: async input => {
      const result = await service.resumeAgent({
        id: input.id,
      });
      return textResponse(JSON.stringify(result));
    },
    name: 'resume_agent',
  });

  registerTool<CloseToolInput>({
    definition: {
      description:
        'Stop a provider-backed child, delete its native provider session, and release local resources. This parent-owned cancellation action invalidates resume.',
      inputSchema: {
        target: z.string().describe('Subagent id to close'),
      },
    },
    handler: async input => {
      const result = await service.closeAgent({ target: input.target });
      return textResponse(JSON.stringify(result));
    },
    name: 'close_agent',
  });

  return server;
}

export function registerProcessCleanup(service: SubagentService, options: RegisterProcessCleanupOptions = {}): void {
  const target = options.target ?? process;
  const logError = options.logError ?? console.error;
  let cleanupPromise: Promise<void> | undefined;
  let exitStarted = false;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= service.dispose();
    return cleanupPromise;
  };
  const exitAfterCleanup = (code: number): void => {
    if (exitStarted) {
      return;
    }
    exitStarted = true;
    void cleanup().then(
      () => {
        target.exit(code);
      },
      (error: unknown) => {
        logError(error);
        target.exit(1);
      },
    );
  };

  target.once('beforeExit', () => {
    void cleanup();
  });
  target.once('SIGINT', () => {
    exitAfterCleanup(130);
  });
  target.once('SIGTERM', () => {
    exitAfterCleanup(0);
  });
  target.stdin?.once('end', () => {
    exitAfterCleanup(0);
  });
  target.stdin?.once('close', () => {
    exitAfterCleanup(0);
  });
}

export async function startSubagentMcpStdio(): Promise<void> {
  const service = createSubagentService();
  registerProcessCleanup(service);
  const server = createSubagentMcpServer({
    defaultProjectRoot: resolveProcessProjectRoot,
    service,
  });
  await startMcpServerStdio(server);
}

function assertSupportedSpawnToolOptions(input: SpawnToolInput): void {
  if (input.service_tier !== undefined && input.service_tier.trim().length > 0) {
    throw new Error('unsupported_spawn_option: service_tier is not supported by ai-subagent yet.');
  }
}

async function resolveClientProjectRoots(server: McpServer): Promise<string[]> {
  try {
    const result = await server.server.listRoots(undefined, { timeout: 1_000 });
    const paths: string[] = [];
    for (const root of result.roots) {
      const pathname = resolveFileRootPath(root.uri);
      if (pathname !== undefined) {
        paths.push(pathname);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

function resolveFileRootPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') {
      return undefined;
    }
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function resolveProcessProjectRoot(): string | undefined {
  const cwd = process.cwd();
  if (basename(cwd) === 'ai-subagent' && basename(dirname(cwd)) === 'plugins') {
    return undefined;
  }
  return cwd;
}

async function resolveProjectRoot(input: {
  inputProjectRoot: string | undefined;
  resolveDefaultProjectRoot: () => string | undefined;
  server: McpServer;
}): Promise<string | undefined> {
  if (input.inputProjectRoot !== undefined) {
    return input.inputProjectRoot;
  }

  const clientRoots = await resolveClientProjectRoots(input.server);
  const clientRoot = clientRoots[0];
  if (clientRoot !== undefined) {
    return clientRoot;
  }

  return input.resolveDefaultProjectRoot();
}

if (isMcpServerEntry()) {
  void startSubagentMcpStdio();
}
