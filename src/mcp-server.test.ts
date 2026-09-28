import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSubagentMcpServer, registerProcessCleanup } from './mcp-server.js';
import type { SubagentService } from './subagentService.js';

type ProcessCleanupEvent = 'beforeExit' | 'SIGINT' | 'SIGTERM';
type StdinCleanupEvent = 'close' | 'end';
type ToolResponse = Promise<{ content: { text: string; type: 'text' }[] }>;

function createServiceMock(overrides: Partial<SubagentService> = {}): SubagentService {
  return {
    closeAgent: () => Promise.resolve({ id: 'agent-1', status: 'closed' }),
    dispose: () => Promise.resolve(),
    resumeAgent: () => Promise.resolve({ id: 'agent-1', status: 'idle' }),
    sendInput: () => Promise.resolve({ id: 'agent-1', status: 'in_progress' }),
    spawnAgent: () =>
      Promise.resolve({
        agentType: 'builder',
        id: 'agent-1',
        model: 'gpt',
        modelId: 'glm-5.2',
        status: 'in_progress',
      }),
    waitAgent: () =>
      Promise.resolve({
        results: [{ id: 'agent-1', output: 'DONE', status: 'completed' }],
      }),
    ...overrides,
  };
}

function getRegisteredTools(server: object): Record<
  string,
  {
    handler?: (input: Record<string, unknown>) => ToolResponse;
    inputSchema?: { safeParse?: (input: unknown) => { success: boolean } };
  }
> {
  return Reflect.get(server, '_registeredTools') as Record<
    string,
    {
      handler?: (input: Record<string, unknown>) => ToolResponse;
      inputSchema?: { safeParse?: (input: unknown) => { success: boolean } };
    }
  >;
}

void describe('ai-subagent MCP server', () => {
  void it('registers exactly the native lifecycle tool names', () => {
    const server = createSubagentMcpServer({ service: createServiceMock() });

    const tools = Object.keys(getRegisteredTools(server)).sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(tools, ['close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent']);
  });

  void it('spawn_agent delegates supported native-compatible fields to the service', async () => {
    let received: Record<string, unknown> | undefined;
    const server = createSubagentMcpServer({
      service: createServiceMock({
        spawnAgent: input => {
          received = input as unknown as Record<string, unknown>;
          return Promise.resolve({
            agentType: 'builder',
            id: 'agent-1',
            model: 'gpt',
            modelId: 'glm-5.2',
            status: 'in_progress',
          });
        },
      }),
    });

    const spawnTool = getRegisteredTools(server).spawn_agent;
    if (spawnTool?.handler === undefined) {
      assert.fail('Expected spawn_agent handler to be registered.');
    }

    const result = await spawnTool.handler({
      agent_type: 'worker',
      fork_context: true,
      message: 'Implement the scoped change.',
      model: 'glm-5.2',
      project_root: '/repo/worktree',
      purpose: 'Implement the scoped change.',
      reasoning_effort: 'high',
    });

    assert.deepStrictEqual(received, {
      agentType: 'worker',
      forkContext: true,
      message: 'Implement the scoped change.',
      model: 'glm-5.2',
      projectRoot: '/repo/worktree',
      purpose: 'Implement the scoped change.',
      reasoningEffort: 'high',
    });
    assert.deepStrictEqual(JSON.parse(result.content[0]?.text ?? '{}'), {
      agentType: 'builder',
      id: 'agent-1',
      model: 'gpt',
      modelId: 'glm-5.2',
      status: 'in_progress',
    });
    const safeParse = spawnTool.inputSchema?.safeParse;
    if (safeParse === undefined) {
      assert.fail('Expected spawn_agent input schema parser to be registered.');
    }
    assert.strictEqual(
      safeParse({
        agent_type: 'builder',
        items: [{ text: 'Do work', type: 'text' }],
        model: 'glm-5.2',
        purpose: 'Implement the scoped change.',
        reasoning_effort: 'medium',
        service_tier: 'standard',
      }).success,
      true,
    );
  });

  void it('delegates the supplied project root so the service can apply preset-aware validation', async () => {
    let receivedProjectRoot: string | undefined;
    const server = createSubagentMcpServer({
      service: createServiceMock({
        spawnAgent: input => {
          receivedProjectRoot = input.projectRoot;
          return Promise.resolve({ id: 'agent-1', status: 'idle' });
        },
      }),
    });
    const spawnTool = getRegisteredTools(server).spawn_agent;
    if (spawnTool?.handler === undefined) {
      assert.fail('Expected spawn_agent handler to be registered.');
    }
    const spawnHandler = spawnTool.handler;

    await spawnHandler({ agent_type: 'ask', project_root: '/repo' });
    assert.strictEqual(receivedProjectRoot, '/repo');
  });

  void it('spawn_agent rejects unsupported native-compatible hints before delegating', async () => {
    let called = false;
    const server = createSubagentMcpServer({
      service: createServiceMock({
        spawnAgent: () => {
          called = true;
          return Promise.resolve({ id: 'agent-1', status: 'idle' });
        },
      }),
    });

    const spawnTool = getRegisteredTools(server).spawn_agent;
    if (spawnTool?.handler === undefined) {
      assert.fail('Expected spawn_agent handler to be registered.');
    }
    const spawnHandler = spawnTool.handler;

    await assert.rejects(
      () => spawnHandler({ agent_type: 'builder', service_tier: 'standard' }),
      /unsupported_spawn_option: service_tier/u,
    );
    assert.equal(called, false);
  });

  void it('send_input, wait_agent, resume_agent, and close_agent use native field names', async () => {
    const received: Record<string, unknown>[] = [];
    const server = createSubagentMcpServer({
      service: createServiceMock({
        closeAgent: input => {
          received.push({ closeAgent: input });
          return Promise.resolve({ id: input.target, status: 'closed' });
        },
        resumeAgent: input => {
          received.push({ resumeAgent: input });
          return Promise.resolve({ id: input.id, status: 'idle' });
        },
        sendInput: input => {
          received.push({ sendInput: input });
          return Promise.resolve({ id: input.target, status: 'in_progress' });
        },
        waitAgent: input => {
          received.push({ waitAgent: input });
          return Promise.resolve({
            results: input.targets.map(target => ({
              id: target,
              progress: {
                activityCount: 2,
                elapsedMs: 30,
                idleMs: 10,
                lastActivityAtMs: 1_020,
                receivedBytes: 17,
                startedAtMs: 1_000,
              },
              status: 'in_progress' as const,
            })),
          });
        },
      }),
    });

    const tools = getRegisteredTools(server);
    await tools.send_input?.handler?.({ interrupt: true, message: 'continue', target: 'agent-1' });
    const waitResponse = await tools.wait_agent?.handler?.({
      include_output: false,
      targets: ['agent-1', 'agent-2'],
      timeout_ms: 0,
    });
    await tools.resume_agent?.handler?.({ id: 'agent-1' });
    await tools.close_agent?.handler?.({ target: 'agent-1' });

    const resumeSafeParse = tools.resume_agent?.inputSchema?.safeParse;
    if (resumeSafeParse === undefined) {
      assert.fail('Expected resume_agent input schema parser to be registered.');
    }
    assert.strictEqual(resumeSafeParse({ id: 'agent-1' }).success, true);

    assert.deepStrictEqual(received, [
      { sendInput: { interrupt: true, message: 'continue', target: 'agent-1' } },
      { waitAgent: { includeOutput: false, targets: ['agent-1', 'agent-2'], timeoutMs: 0 } },
      { resumeAgent: { id: 'agent-1' } },
      { closeAgent: { target: 'agent-1' } },
    ]);
    assert.deepStrictEqual(JSON.parse(waitResponse?.content[0]?.text ?? '{}'), {
      results: [
        {
          id: 'agent-1',
          progress: {
            activityCount: 2,
            elapsedMs: 30,
            idleMs: 10,
            lastActivityAtMs: 1_020,
            receivedBytes: 17,
            startedAtMs: 1_000,
          },
          status: 'in_progress',
        },
        {
          id: 'agent-2',
          progress: {
            activityCount: 2,
            elapsedMs: 30,
            idleMs: 10,
            lastActivityAtMs: 1_020,
            receivedBytes: 17,
            startedAtMs: 1_000,
          },
          status: 'in_progress',
        },
      ],
    });
  });

  void it('awaits disposal and exits on SIGTERM cleanup', async () => {
    const handlers: Partial<Record<ProcessCleanupEvent, () => void>> = {};
    const exits: number[] = [];
    const events: string[] = [];
    const processTarget = {
      exit: (code?: number): void => {
        events.push('exit');
        exits.push(code ?? 0);
      },
      once: (event: ProcessCleanupEvent, listener: () => void): void => {
        handlers[event] = listener;
      },
    };

    registerProcessCleanup(
      createServiceMock({
        dispose: () => {
          events.push('dispose');
          return Promise.resolve();
        },
      }),
      { logError: () => {}, target: processTarget },
    );

    handlers.SIGTERM?.();
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    assert.deepStrictEqual(events, ['dispose', 'exit']);
    assert.deepStrictEqual(exits, [0]);
  });

  void it('awaits disposal and exits on SIGINT cleanup', async () => {
    const handlers: Partial<Record<ProcessCleanupEvent, () => void>> = {};
    const exits: number[] = [];
    const events: string[] = [];
    const processTarget = {
      exit: (code?: number): void => {
        events.push('exit');
        exits.push(code ?? 0);
      },
      once: (event: ProcessCleanupEvent, listener: () => void): void => {
        handlers[event] = listener;
      },
    };

    registerProcessCleanup(
      createServiceMock({
        dispose: () => {
          events.push('dispose');
          return Promise.resolve();
        },
      }),
      { logError: () => {}, target: processTarget },
    );

    handlers.SIGINT?.();
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    assert.deepStrictEqual(events, ['dispose', 'exit']);
    assert.deepStrictEqual(exits, [130]);
  });

  void it('awaits disposal once and exits on stdio disconnect cleanup', async () => {
    const handlers: Partial<Record<ProcessCleanupEvent, () => void>> = {};
    const stdinHandlers: Partial<Record<StdinCleanupEvent, () => void>> = {};
    const exits: number[] = [];
    const events: string[] = [];
    const processTarget = {
      exit: (code?: number): void => {
        events.push('exit');
        exits.push(code ?? 0);
      },
      once: (event: ProcessCleanupEvent, listener: () => void): void => {
        handlers[event] = listener;
      },
      stdin: {
        once: (event: StdinCleanupEvent, listener: () => void): void => {
          stdinHandlers[event] = listener;
        },
      },
    };

    registerProcessCleanup(
      createServiceMock({
        dispose: () => {
          events.push('dispose');
          return Promise.resolve();
        },
      }),
      { logError: () => {}, target: processTarget },
    );

    stdinHandlers.end?.();
    stdinHandlers.close?.();
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    assert.notStrictEqual(handlers.beforeExit, undefined);
    assert.deepStrictEqual(events, ['dispose', 'exit']);
    assert.deepStrictEqual(exits, [0]);
  });
});
