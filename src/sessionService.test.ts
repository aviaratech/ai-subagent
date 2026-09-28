import type { ApiAgentSession, ApiAgentSessionOptions, RestrictedCodexHome, TokenUsage } from './vendor/ai/index.js';

import { listModels } from './vendor/ai/index.js';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createFileSubagentRegistry,
  createMemorySubagentRegistry,
  createSubagentService,
  type PersistedSubagentRecord,
  type SubagentRegistry,
  type SubagentServiceDependencies,
} from './subagentService.js';
import type { SubagentTelemetryEvent } from './subagentTelemetry.js';

interface AuditEvent {
  event: string;
  fields: Record<string, boolean | number | string | undefined>;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

interface ProcessOutcomeProbe {
  completionMs: number;
  exitCode: null | number;
  firstActivityMs?: number;
  lastActivityMs?: number;
  receivedBytes: number;
  signal: NodeJS.Signals | null;
  stderrBytes: number;
  stdoutBytes: number;
  structuredOutput?: {
    lastEventKind?: 'end' | 'other' | 'text' | 'tool_use';
    state: 'complete' | 'incomplete' | 'malformed' | 'none';
    terminalEventSeen: boolean;
    turnUsageReported: boolean;
    validEventCount: number;
  };
}

interface RestrictedHomeCall {
  mcpConfigPaths: string[];
  modelCatalogAliases?: unknown;
  modelProvider?: unknown;
}

interface RoutingTelemetryProbe {
  effectiveModelId?: string;
  effectiveReasoningEffort?: string;
  requestedModelId?: string;
  requestedReasoningEffort?: string;
}

function routingTelemetry(event: SubagentTelemetryEvent): RoutingTelemetryProbe {
  return event;
}

const DEFAULT_HARNESS_ENV: NodeJS.ProcessEnv = {
  EXAMPLE_CLOUD_PROFILE: 'operator-profile',
  GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test',
  HOME: '/home/example',
  LANG: 'en_US.UTF-8',
  OPENROUTER_API_KEY: 'openrouter-test-key',
  PATH: '/bin',
  TERM: 'xterm-256color',
  TMPDIR: '/var/folders/test',
};

function activeTimeoutCount(): number {
  return process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
}

function assertHostNativeEnv(env: ApiAgentSessionOptions['env']): void {
  if (env === undefined) {
    assert.fail('expected session env');
  }
  assert.strictEqual(env.HOME, '/home/example');
  assert.strictEqual(env.LANG, 'en_US.UTF-8');
  assert.equal(env.PATH?.split(delimiter).includes('/bin'), true);
  assert.strictEqual(env.TERM, 'xterm-256color');
  assert.strictEqual(env.TMPDIR, '/var/folders/test');
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function createHarness(
  input: {
    deferDisposals?: boolean;
    deferSuspends?: boolean;
    disposeFailures?: number;
    disposeRejectsActiveTurn?: boolean;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    resolveSuperpowersSkills?: SubagentServiceDependencies['resolveSuperpowersSkills'];
    sessionCapabilities?: ReturnType<ApiAgentSession['getCapabilities']>;
    suspendFailures?: number;
    suspendRejectsActiveTurn?: boolean;
    tokenUsage?: TokenUsage;
    tokenUsages?: (TokenUsage | undefined)[];
    validateProjectRoot?: (projectRoot: string) => string;
  } = {},
) {
  const auditEvents: AuditEvent[] = [];
  const createSessionCalls: ApiAgentSessionOptions[] = [];
  const sends: string[] = [];
  const deferredDisposals: Deferred<undefined>[] = [];
  const deferredSuspends: Deferred<undefined>[] = [];
  const deferredTurns: Deferred<string>[] = [];
  const disposedSessionIds: string[] = [];
  const suspendedSessionIds: string[] = [];
  const interruptedSessionIds: string[] = [];
  const preflightModelIds: string[] = [];
  const restrictedHomeCalls: RestrictedHomeCall[] = [];
  const restrictedHomeCleanups: string[] = [];
  const registryUpserts: PersistedSubagentRecord[] = [];
  const telemetryEvents: SubagentTelemetryEvent[] = [];
  const sessionCapabilities = input.sessionCapabilities;
  const configuredTokenUsage = input.tokenUsage;
  const configuredTokenUsages = input.tokenUsages;
  const deferDisposals = input.deferDisposals === true;
  const deferSuspends = input.deferSuspends === true;
  const disposeRejectsActiveTurn = input.disposeRejectsActiveTurn === true;
  const suspendRejectsActiveTurn = input.suspendRejectsActiveTurn === true;
  let registrySuccessfulUpsertsBeforeFailure: number | undefined;
  let registryUpsertFailures = 0;
  let remainingDisposeFailures = input.disposeFailures ?? 0;
  let remainingSuspendFailures = input.suspendFailures ?? 0;
  let restrictedHomeCounter = 0;
  let sessionCounter = 0;
  let tokenUsageIndex = 0;

  const memoryRegistry = createMemorySubagentRegistry();
  const registry: SubagentRegistry = {
    get: id => {
      const record = memoryRegistry.get(id);
      return record === undefined ? undefined : structuredClone(record);
    },
    remove: id => {
      memoryRegistry.remove(id);
    },
    upsert: record => {
      if (registrySuccessfulUpsertsBeforeFailure !== undefined) {
        if (registrySuccessfulUpsertsBeforeFailure === 0) {
          registrySuccessfulUpsertsBeforeFailure = undefined;
          throw new Error('registry persistence unavailable');
        }
        registrySuccessfulUpsertsBeforeFailure -= 1;
      }
      if (registryUpsertFailures > 0) {
        registryUpsertFailures -= 1;
        throw new Error('registry persistence unavailable');
      }
      registryUpserts.push(structuredClone(record));
      memoryRegistry.upsert(structuredClone(record));
    },
  };
  const service = createSubagentService({
    audit: (event, fields) => {
      auditEvents.push({ event, fields });
    },
    createSession: (input): ApiAgentSession => {
      createSessionCalls.push(input);
      sessionCounter += 1;
      const backendSessionId = input.sessionId ?? `backend-${sessionCounter.toString()}`;
      return {
        dispose: () => {
          if (disposeRejectsActiveTurn) {
            deferredTurns.at(-1)?.reject(new Error('provider teardown rejection'));
          }
          if (remainingDisposeFailures > 0) {
            remainingDisposeFailures -= 1;
            return Promise.reject(new Error('secret cleanup detail'));
          }
          if (deferDisposals) {
            const deferred = createDeferred<undefined>();
            deferredDisposals.push(deferred);
            return deferred.promise.then(() => {
              disposedSessionIds.push(backendSessionId);
            });
          }
          disposedSessionIds.push(backendSessionId);
          return Promise.resolve();
        },
        getCapabilities: () => sessionCapabilities ?? { fork: true, interrupt: true, queue: true, resume: true },
        getSessionId: () => backendSessionId,
        interrupt: () => {
          interruptedSessionIds.push(backendSessionId);
          deferredTurns.at(-1)?.reject(new Error('turn_interrupted'));
          return Promise.resolve();
        },
        isAlive: () => true,
        onExit: () => {},
        send: message => {
          sends.push(message);
          const deferred = createDeferred<string>();
          deferredTurns.push(deferred);
          const configuredTurnUsage = configuredTokenUsages?.[tokenUsageIndex];
          const usage: TokenUsage = configuredTurnUsage ??
            configuredTokenUsage ?? {
              attributionSource: 'provider-event',
              inputTokens: 5,
              model: input.modelId ?? input.model,
              outputTokens: 7,
              providerId: input.model,
              ...(input.modelId !== undefined ? { effectiveModelId: input.modelId } : {}),
              provider: {
                cacheCreationInputTokens: 11,
                cachedInputTokens: 2,
                cacheReadInputTokens: 13,
                inputTokens: 5,
                outputTokens: 7,
                reasoningOutputTokens: 3,
                totalTokens: 12,
              },
            };
          tokenUsageIndex += 1;
          if (configuredTokenUsages === undefined || configuredTurnUsage !== undefined) {
            input.onTokenUsage?.(usage);
          }
          return deferred.promise;
        },
        suspend: () => {
          if (suspendRejectsActiveTurn) {
            deferredTurns.at(-1)?.reject(new Error('provider suspension rejection'));
          }
          if (remainingSuspendFailures > 0) {
            remainingSuspendFailures -= 1;
            return Promise.reject(new Error('secret suspension detail'));
          }
          if (deferSuspends) {
            const deferred = createDeferred<undefined>();
            deferredSuspends.push(deferred);
            return deferred.promise.then(() => {
              suspendedSessionIds.push(backendSessionId);
            });
          }
          suspendedSessionIds.push(backendSessionId);
          return Promise.resolve();
        },
      };
    },
    env: input.env ?? DEFAULT_HARNESS_ENV,
    now:
      input.now ??
      (() => {
        let current = 1_000;
        return () => {
          current += 10;
          return current;
        };
      })(),
    registry,
    resolveSuperpowersSkills:
      input.resolveSuperpowersSkills ??
      (input => {
        const names =
          input.agentType === 'builder' ? ['using-superpowers', 'test-driven-development'] : ['using-superpowers'];
        const references = names.map(name => `/skills/${name}/SKILL.md`);
        return {
          names,
          references,
          skills: names.map((name, index) => ({
            digest: `digest-${name}`,
            name,
            reference: requireDefined(references[index], `expected reference for ${name}`),
          })),
        };
      }),
    runModelLaunchPreflight: input => {
      preflightModelIds.push(input.modelId);
      let providerId = 'openai';
      if (input.modelId.startsWith('claude-')) {
        providerId = 'anthropic';
      } else if (input.modelId.startsWith('grok-')) {
        providerId = 'xai';
      } else if (input.modelId.startsWith('glm-')) {
        providerId = 'z-ai';
      }
      let transport = 'codex-cli';
      if (input.modelId.startsWith('claude-')) {
        transport = 'claude-code';
      } else if (input.modelId.startsWith('grok-')) {
        transport = 'grok-build';
      }
      return Promise.resolve({
        authMode: 'host-subscription',
        ...(input.modelId.startsWith('grok-')
          ? {
              capabilityInventory: {
                inspectionStatus: 'ok' as const,
                mcpServers: [
                  { name: 'example-memory', origin: 'plugin:example-memory', transport: 'stdio' },
                  { name: 'github', origin: 'project', transport: 'http' },
                  { name: 'example-workflow', origin: 'plugin:example-workflow', transport: 'stdio' },
                ],
                missing: [],
                plugins: [
                  { name: 'example-memory', origin: 'project' },
                  { name: 'github', origin: 'user' },
                  { name: 'example-workflow', origin: 'project' },
                  { name: 'superpowers', origin: 'user' },
                ],
                skills: [
                  { name: 'memory-lifecycle', origin: 'plugin:example-memory' },
                  { name: 'pr-handoff', origin: 'plugin:example-workflow' },
                  { name: 'using-superpowers', origin: 'plugin:superpowers' },
                ],
              },
            }
          : {}),
        modelId: input.modelId,
        providerId,
        transport,
        version: 'test-cli 1.0.0',
      });
    },
    telemetry: {
      close: () => Promise.resolve(),
      recordEvent: event => {
        telemetryEvents.push(event);
      },
    },
    validateProjectRoot: input.validateProjectRoot ?? (projectRoot => projectRoot),
    writeRestrictedCodexHome: options => {
      restrictedHomeCounter += 1;
      restrictedHomeCalls.push(options);
      const codexHome = `/repo/worktree/.ai/ai-subagent-codex-home-${restrictedHomeCounter.toString()}`;
      const restricted: RestrictedCodexHome = {
        cleanup: () => {
          restrictedHomeCleanups.push(codexHome);
          return Promise.resolve();
        },
        codexHome,
      };
      return Promise.resolve(restricted);
    },
  });

  return {
    auditEvents,
    createSessionCalls,
    deferredDisposals,
    deferredSuspends,
    deferredTurns,
    disposedSessionIds,
    failNextRegistryUpserts: (count = 1) => {
      registryUpsertFailures = count;
    },
    failRegistryUpsertAfter: (successfulUpserts: number) => {
      registrySuccessfulUpsertsBeforeFailure = successfulUpserts;
    },
    interruptedSessionIds,
    preflightModelIds,
    registry,
    registryUpserts,
    restrictedHomeCalls,
    restrictedHomeCleanups,
    sends,
    service,
    suspendedSessionIds,
    telemetryEvents,
  };
}

function createPersistedRecord(id: string): PersistedSubagentRecord {
  return {
    agentType: 'default',
    createdAt: 1,
    id,
    lastActivityAt: 1,
    model: 'gpt',
    modelId: 'gpt-5.6-terra',
    projectRoot: '/repo/worktree',
    status: 'idle',
  };
}

function flushTurnDrain(): Promise<void> {
  return new Promise(resolveFlush => {
    setImmediate(resolveFlush);
  });
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    assert.fail(message);
  }
  return value;
}

void describe('ai-subagent session service', () => {
  void it('forwards caller directories without coupling native authority to issue metadata', async () => {
    const validationInputs: unknown[] = [];
    const { createSessionCalls, service, telemetryEvents } = createHarness({
      validateProjectRoot: projectRoot => {
        validationInputs.push(projectRoot);
        return '/repo/worktree';
      },
    });

    await service.spawnAgent({ agentType: 'ask', projectRoot: '/repo' });
    await service.spawnAgent({ agentType: 'builder', projectRoot: '/repo/worktree' });

    assert.deepStrictEqual(validationInputs, ['/repo', '/repo/worktree']);
    assert.strictEqual(createSessionCalls.length, 2);
    assert.strictEqual(telemetryEvents.filter(event => event.eventType === 'spawn').length, 2);
  });

  void it('launches one provider child immediately from a native spawn request', async () => {
    const { createSessionCalls, deferredTurns, preflightModelIds, sends, service, telemetryEvents } = createHarness();

    const result = await service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });

    assert.strictEqual(result.status, 'in_progress');
    assert.notStrictEqual(result.id, '');
    assert.strictEqual(createSessionCalls.length, 1);
    assert.strictEqual(deferredTurns.length, 1);
    assert.strictEqual(sends.length, 1);
    assert.deepStrictEqual(preflightModelIds, ['grok-4.5']);
    const spawnEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'spawn'),
      'expected spawn telemetry',
    );
    assert.deepStrictEqual(spawnEvent.selectedSkills, ['using-superpowers', 'test-driven-development']);
    const preflightEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'preflight'),
      'expected preflight telemetry',
    );
    assert.strictEqual(preflightEvent.capabilityInspectionStatus, 'ok');
    assert.deepStrictEqual(preflightEvent.capabilityMissing, []);
    assert.deepStrictEqual(preflightEvent.capabilityPlugins, [
      'example-memory@project',
      'github@user',
      'example-workflow@project',
      'superpowers@user',
    ]);
    assert.deepStrictEqual(preflightEvent.capabilityMcpServers, [
      'example-memory@plugin:example-memory',
      'github@project',
      'example-workflow@plugin:example-workflow',
    ]);
    assert.deepStrictEqual(preflightEvent.capabilitySkills, [
      'memory-lifecycle@plugin:example-memory',
      'pr-handoff@plugin:example-workflow',
      'using-superpowers@plugin:superpowers',
    ]);
  });

  void it('uses native Grok locally without a separate opt-in and rejects CI launches', async () => {
    const localHarness = createHarness();
    const localResult = await localHarness.service.spawnAgent({ agentType: 'builder', projectRoot: '/repo/worktree' });
    assert.strictEqual(localResult.status, 'idle');
    assert.strictEqual(localHarness.createSessionCalls.length, 1);

    const ciHarness = createHarness({ env: { ...DEFAULT_HARNESS_ENV, CI: 'true' } });
    await assert.rejects(
      () => ciHarness.service.spawnAgent({ agentType: 'builder', projectRoot: '/repo/worktree' }),
      /grok_trusted_local_unavailable/u,
    );
    assert.deepStrictEqual(ciHarness.createSessionCalls, []);
  });

  void it('allows Grok model overrides outside the builder preset with native authority', async () => {
    const { createSessionCalls, service } = createHarness();

    const result = await service.spawnAgent({
      agentType: 'reviewer',
      model: 'grok-4.5',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(result.modelId, 'grok-4.5');
    assert.strictEqual(result.reasoningEffort, 'high');
    const createSessionCall = createSessionCalls.at(0);
    assert.ok(createSessionCall);
    assert.deepStrictEqual(createSessionCall.behavior, { sandbox: 'off' });
    assert.strictEqual(createSessionCall.role, 'reviewer');
  });

  void it('constructs a native-authority provider session for every active model and preset', async () => {
    const agentTypes = ['ask', 'builder', 'default', 'explorer', 'reviewer', 'worker'] as const;
    for (const model of listModels()) {
      for (const agentType of agentTypes) {
        const { createSessionCalls, service } = createHarness();
        const result = await service.spawnAgent({
          agentType,
          model: model.id,
          projectRoot: '/repo/worktree',
        });
        const call = requireDefined(createSessionCalls[0], `expected ${agentType}/${model.id} session`);
        assert.strictEqual(result.modelId, model.id, `${agentType}/${model.id}`);
        assert.strictEqual(call.modelId, model.id, `${agentType}/${model.id}`);
        assert.deepStrictEqual(call.behavior, { sandbox: 'off' }, `${agentType}/${model.id}`);
        await service.closeAgent({ target: result.id });
      }
    }
  });

  void it('file registry merges interleaved writes from independent registry instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-subagent-registry-'));
    try {
      const registryPath = join(directory, 'subagent-sessions.json');
      const firstRegistry = createFileSubagentRegistry(registryPath);
      const secondRegistry = createFileSubagentRegistry(registryPath);

      firstRegistry.upsert(createPersistedRecord('first-agent'));
      secondRegistry.upsert(createPersistedRecord('second-agent'));

      const persisted = JSON.parse(readFileSync(registryPath, 'utf8')) as PersistedSubagentRecord[];
      assert.deepStrictEqual(persisted.map(record => record.id).sort(), ['first-agent', 'second-agent']);

      firstRegistry.remove('first-agent');
      assert.strictEqual(secondRegistry.get('first-agent'), undefined);
      assert.strictEqual(secondRegistry.get('second-agent')?.id, 'second-agent');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  void it('spawn_agent starts a selected Grok builder turn and wait_agent delivers completed output once', async () => {
    const { createSessionCalls, deferredTurns, restrictedHomeCalls, sends, service } = createHarness();

    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });

    assert.strictEqual(spawn.status, 'in_progress');
    assert.strictEqual(spawn.agentType, 'builder');
    assert.strictEqual(spawn.model, 'xai');
    assert.strictEqual(spawn.modelId, 'grok-4.5');
    assert.strictEqual(spawn.reasoningEffort, 'high');
    assert.deepStrictEqual(sends, ['Implement the scoped change.']);
    const createSessionCall = requireDefined(createSessionCalls[0], 'expected createSession to be called');
    assert.deepStrictEqual(createSessionCall.behavior, { sandbox: 'off' });
    assert.strictEqual(createSessionCall.role, 'builder');
    assert.strictEqual(createSessionCall.model, 'xai');
    assert.strictEqual(createSessionCall.modelId, 'grok-4.5');
    assert.strictEqual(createSessionCall.reasoning, 'high');
    assert.strictEqual(createSessionCall.projectRoot, '/repo/worktree');
    assert.strictEqual(createSessionCall.envMode, 'replace');
    assert.strictEqual(createSessionCall.runtimeMode, 'host-native');
    assert.strictEqual(createSessionCall.idleTimeoutMs, undefined);
    assert.strictEqual(createSessionCall.maxTurnMs, undefined);
    assert.deepStrictEqual(createSessionCall.superpowersSkillReferences, [
      '/skills/using-superpowers/SKILL.md',
      '/skills/test-driven-development/SKILL.md',
    ]);
    assert.match(JSON.stringify(createSessionCall.context), /Required Superpowers Bootstrap/u);
    assert.match(JSON.stringify(createSessionCall.context), /native file-edit\/patch tool/u);
    assert.match(JSON.stringify(createSessionCall.context), /apply_patch/u);
    assert.match(JSON.stringify(createSessionCall.context), /never write files via shell heredocs/u);
    const sessionEnv = requireDefined(createSessionCall.env, 'expected builder session env');
    assert.strictEqual(sessionEnv.CODEX_HOME, undefined);
    assertHostNativeEnv(sessionEnv);
    assert.strictEqual(sessionEnv.EXAMPLE_CLOUD_PROFILE, 'operator-profile');
    assert.strictEqual(sessionEnv.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_test');
    assert.strictEqual(sessionEnv.OPENROUTER_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify(createSessionCall.mcpConfig ?? []), /ai-subagent/u);
    assert.deepStrictEqual(restrictedHomeCalls, []);

    const firstWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 0 });
    const firstResult = requireDefined(firstWait.results[0], 'expected first wait result');
    assert.strictEqual(firstResult.id, spawn.id);
    assert.strictEqual(firstResult.agentType, 'builder');
    assert.strictEqual(firstResult.model, 'xai');
    assert.strictEqual(firstResult.modelId, 'grok-4.5');
    assert.strictEqual(firstResult.status, 'in_progress');

    deferredTurns[0]?.resolve('DONE\n\nchanged files: src/example.ts');
    const secondWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const secondResult = requireDefined(secondWait.results[0], 'expected second wait result');
    assert.strictEqual(secondResult.id, spawn.id);
    assert.strictEqual(secondResult.agentType, 'builder');
    assert.strictEqual(secondResult.model, 'xai');
    assert.strictEqual(secondResult.modelId, 'grok-4.5');
    assert.strictEqual(secondResult.output, 'DONE\n\nchanged files: src/example.ts');
    assert.strictEqual(secondResult.outputBytes, Buffer.byteLength('DONE\n\nchanged files: src/example.ts', 'utf8'));
    assert.strictEqual(secondResult.outputConsumed, true);
    assert.strictEqual(secondResult.outputTruncated, false);
    assert.match(secondResult.outputRef ?? '', /\/repo\/worktree\/\.ai\/logs\/ai-subagent-.+\.log/u);
    assert.strictEqual(secondResult.status, 'completed');

    const thirdWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 0 });
    const thirdResult = requireDefined(thirdWait.results[0], 'expected third wait result');
    assert.strictEqual(thirdResult.id, spawn.id);
    assert.strictEqual(thirdResult.output, undefined);
    assert.strictEqual(thirdResult.outputConsumed, true);
    assert.strictEqual(thirdResult.outputRef, secondResult.outputRef);
    assert.strictEqual(thirdResult.status, 'completed');

    const followUp = await service.sendInput({ message: 'Summarize the change.', target: spawn.id });
    assert.strictEqual(followUp.status, 'in_progress');
    deferredTurns[1]?.resolve('SECOND TURN');
    const fourthWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const fourthResult = requireDefined(fourthWait.results[0], 'expected fourth wait result');
    assert.strictEqual(fourthResult.output, 'SECOND TURN');
    assert.strictEqual(fourthResult.outputConsumed, true);
  });

  void it('extracts optional structured terminal summaries without replacing raw output', async () => {
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });

    const output = [
      'DONE_WITH_CONCERNS',
      '',
      'Implemented the scoped change.',
      '',
      '```json',
      JSON.stringify(
        {
          changed_files: ['src/example.ts', 'test/example.test.ts'],
          commands: ['npm test'],
          concerns: ['Watch follow-up reviewer coverage.'],
          evidence: {
            green: ['targeted test passed after implementation'],
            red: ['targeted test failed before implementation'],
          },
          terminal_status: 'DONE_WITH_CONCERNS',
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
    deferredTurns[0]?.resolve(output);

    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected completed wait result');

    assert.strictEqual(result.output, output);
    assert.strictEqual(result.summarySource, 'structured');
    assert.deepStrictEqual(result.structured, {
      changedFiles: ['src/example.ts', 'test/example.test.ts'],
      commands: ['npm test'],
      concerns: ['Watch follow-up reviewer coverage.'],
      evidence: {
        green: ['targeted test passed after implementation'],
        red: ['targeted test failed before implementation'],
      },
      terminalStatus: 'DONE_WITH_CONCERNS',
    });
  });

  void it('retains a sanitized transcript reference when a provider turn fails', async () => {
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });

    deferredTurns[0]?.reject(new Error('grok_malformed_output: Native Grok emitted a non-JSON streaming event.'));
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected failed result');

    assert.strictEqual(result.status, 'error');
    assert.match(result.outputRef ?? '', /\/repo\/worktree\/\.ai\/logs\/ai-subagent-.+\.log/u);
    assert.strictEqual(result.output, '');
    assert.strictEqual(result.outputBytes, 0);
  });

  void it('requires an explicit fenced terminal-status JSON summary before exposing structured output', async () => {
    const outputs = [
      JSON.stringify({ commands: ['pnpm test'], terminal_status: 'DONE' }),
      ['```json', JSON.stringify({ commands: ['pnpm test'] }), '```'].join('\n'),
      ['```ts', JSON.stringify({ commands: ['pnpm test'], terminal_status: 'DONE' }), '```'].join('\n'),
    ];

    for (const output of outputs) {
      const { deferredTurns, service } = createHarness();
      const spawn = await service.spawnAgent({
        agentType: 'builder',
        message: 'Implement the scoped change.',
        projectRoot: '/repo/worktree',
      });
      deferredTurns[0]?.resolve(output);

      const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
      const result = requireDefined(wait.results[0], 'expected completed wait result');

      assert.strictEqual(result.summarySource, 'none');
      assert.strictEqual(result.structured, undefined);
    }
  });

  void it('bounds structured terminal summary blocks and fields', async () => {
    const longSegment = 'x'.repeat(280);
    const changedFiles = Array.from({ length: 25 }, (_, index) => `src/${index.toString()}-${longSegment}.ts`);
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });
    const output = [
      'DONE',
      '```json',
      JSON.stringify({
        changed_files: changedFiles,
        terminal_status: `DONE_${longSegment}`,
      }),
      '```',
    ].join('\n');
    deferredTurns[0]?.resolve(output);

    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected completed wait result');

    assert.strictEqual(result.summarySource, 'structured');
    const structured = requireDefined(result.structured, 'expected structured result');
    assert.ok(Buffer.byteLength(structured.terminalStatus ?? '', 'utf8') <= 256);
    const boundedChangedFiles = requireDefined(structured.changedFiles, 'expected bounded changed files');
    assert.strictEqual(boundedChangedFiles.length, 20);
    assert.equal(
      boundedChangedFiles.every(file => Buffer.byteLength(file, 'utf8') <= 256),
      true,
    );

    const smallCapHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_MAX_OUTPUT_BYTES: '512',
      },
    });
    const oversizedSpawn = await smallCapHarness.service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });
    const oversizedOutput = [
      'DONE',
      '```json',
      JSON.stringify({
        changed_files: [longSegment.repeat(3)],
        terminal_status: 'DONE',
      }),
      '```',
    ].join('\n');
    smallCapHarness.deferredTurns[0]?.resolve(oversizedOutput);

    const oversizedWait = await smallCapHarness.service.waitAgent({ targets: [oversizedSpawn.id], timeoutMs: 100 });
    const oversizedResult = requireDefined(oversizedWait.results[0], 'expected completed wait result');

    assert.strictEqual(oversizedResult.status, 'completed');
    assert.ok((oversizedResult.output?.length ?? 0) > 0);
    assert.ok(Buffer.byteLength(oversizedResult.output ?? '', 'utf8') <= 512);
    assert.strictEqual(oversizedResult.outputTruncated, true);
    assert.strictEqual(oversizedResult.summarySource, 'none');
    assert.strictEqual(oversizedResult.structured, undefined);
  });

  void it('emits durable spawn and completed-turn telemetry with parent correlation and cached token totals', async () => {
    const { createSessionCalls, deferredTurns, service, telemetryEvents } = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_PARENT_SESSION_ID: 'parent-session-1',
      },
    });

    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'secret prompt body oauth-secret-marker raw transcript body',
      projectRoot: '/repo/worktree',
    });
    const createSessionCall = requireDefined(createSessionCalls[0], 'expected createSession to be called');
    const childEnv = requireDefined(createSessionCall.env, 'expected child session env');
    assert.strictEqual(childEnv.AI_SUBAGENT_AGENT_ID, spawn.id);
    assert.strictEqual(childEnv.AI_SUBAGENT_PARENT_AGENT_ID, undefined);
    assert.strictEqual(childEnv.AI_SUBAGENT_PARENT_SESSION_ID, 'parent-session-1');

    const spawnEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'spawn'),
      'expected spawn telemetry',
    );
    assert.strictEqual(spawnEvent.agentId, spawn.id);
    assert.strictEqual(spawnEvent.agentType, 'builder');
    assert.strictEqual(spawnEvent.childDepth, 1);
    assert.strictEqual(spawnEvent.depth, 0);
    assert.strictEqual(spawnEvent.model, 'xai');
    assert.strictEqual(spawnEvent.modelId, 'grok-4.5');
    assert.strictEqual(routingTelemetry(spawnEvent).effectiveModelId, 'grok-4.5');
    assert.strictEqual(routingTelemetry(spawnEvent).effectiveReasoningEffort, 'high');
    assert.strictEqual(spawnEvent.parentAgentId, undefined);
    assert.strictEqual(spawnEvent.parentSessionId, 'parent-session-1');
    assert.strictEqual(spawnEvent.parentSessionIdSource, 'env:AI_SUBAGENT_PARENT_SESSION_ID');
    assert.strictEqual(spawnEvent.project, 'worktree');
    assert.strictEqual(spawnEvent.provider, 'xai');
    assert.strictEqual(spawnEvent.requiresOpenRouter, false);
    assert.strictEqual(spawnEvent.schemaVersion, 2);
    assert.strictEqual(spawnEvent.requestedProvider, 'xai');
    assert.strictEqual(spawnEvent.resolvedProvider, 'xai');
    assert.strictEqual(spawnEvent.resolvedModelId, 'grok-4.5');
    assert.strictEqual(spawnEvent.attributionSource, 'exact-launch-contract');
    assert.strictEqual(Reflect.get(spawn, 'attributionSource'), 'provider-event');
    assert.strictEqual(Reflect.get(spawn, 'effectiveModelId'), 'grok-4.5');
    assert.strictEqual(Reflect.get(spawn, 'effectiveProvider'), 'xai');
    assert.strictEqual(Reflect.get(spawn, 'effectiveReasoningEffort'), 'high');
    assert.deepStrictEqual(spawnEvent.selectedSkillDigests, [
      'digest-using-superpowers',
      'digest-test-driven-development',
    ]);
    assert.deepStrictEqual(spawnEvent.capabilitiesUsed, ['spawn']);
    assert.strictEqual(spawnEvent.noNestedDelegation, true);
    assert.strictEqual(spawnEvent.status, 'ok');

    deferredTurns[0]?.resolve('secret result body');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });

    const completedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_completed'),
      'expected turn completion telemetry',
    );
    assert.strictEqual(completedEvent.agentId, spawn.id);
    assert.strictEqual(completedEvent.effectiveProvider, 'xai');
    assert.strictEqual(completedEvent.hostEffectiveModelId, 'grok-4.5');
    assert.strictEqual(completedEvent.outputBytes, Buffer.byteLength('secret result body', 'utf8'));
    assert.strictEqual(completedEvent.outputTruncated, false);
    assert.strictEqual(completedEvent.attributionSource, 'provider-event');
    assert.strictEqual(completedEvent.elapsedMs, completedEvent.waitMs);
    assert.strictEqual(completedEvent.cleanupOutcome, 'not_required');
    assert.strictEqual(completedEvent.resultBytes, Buffer.byteLength('secret result body', 'utf8'));
    assert.strictEqual(completedEvent.resultTruncated, false);
    assert.strictEqual(completedEvent.terminalCause, 'completed');
    assert.strictEqual(completedEvent.terminalOutcome, 'completed');
    assert.strictEqual(completedEvent.terminalOwner, 'provider');
    assert.equal(typeof completedEvent.transcriptRef, 'string');
    assert.strictEqual(completedEvent.status, 'ok');
    assert.strictEqual(completedEvent.totalCachedInputTokens, 26);
    assert.strictEqual(completedEvent.totalInputTokens, 5);
    assert.strictEqual(completedEvent.totalOutputTokens, 7);
    assert.strictEqual(completedEvent.totalReasoningOutputTokens, 3);
    assert.strictEqual(completedEvent.totalTokens, 12);
    assert.equal(typeof completedEvent.pollCount, 'number');
    assert.equal(typeof completedEvent.waitMs, 'number');
    assert.doesNotMatch(
      JSON.stringify(telemetryEvents),
      /secret prompt body|secret result body|oauth-secret-marker|raw transcript body/u,
    );
  });

  void it('does not inherit prior cumulative usage into a later failed turn', async () => {
    const firstTurnUsage: TokenUsage = {
      attributionSource: 'provider-event',
      inputTokens: 5,
      model: 'grok-4.5',
      outputTokens: 7,
      provider: {
        cachedInputTokens: 2,
        inputTokens: 5,
        outputTokens: 7,
        reasoningOutputTokens: 3,
        totalTokens: 12,
      },
      providerId: 'xai',
    };
    const { deferredTurns, registry, service, telemetryEvents } = createHarness({
      tokenUsages: [firstTurnUsage, undefined],
    });
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Complete the first turn.',
      model: 'grok-4.5',
      projectRoot: '/repo/worktree',
    });
    deferredTurns[0]?.resolve('first turn complete');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });

    await service.sendInput({ message: 'Fail without usage.', target: spawn.id });
    deferredTurns[1]?.reject(new Error('grok_terminal_failure: incomplete provider stream'));
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });

    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected failed-turn telemetry',
    );
    assert.strictEqual(failedEvent.turnUsageReported, false);
    assert.strictEqual(failedEvent.turnCachedInputTokens, undefined);
    assert.strictEqual(failedEvent.turnInputTokens, undefined);
    assert.strictEqual(failedEvent.turnOutputTokens, undefined);
    assert.strictEqual(failedEvent.turnReasoningOutputTokens, undefined);
    assert.strictEqual(failedEvent.turnTokens, undefined);
    assert.strictEqual(failedEvent.totalCachedInputTokens, 2);
    assert.strictEqual(failedEvent.totalInputTokens, 5);
    assert.strictEqual(failedEvent.totalOutputTokens, 7);
    assert.strictEqual(failedEvent.totalReasoningOutputTokens, 3);
    assert.strictEqual(failedEvent.totalTokens, 12);
    assert.strictEqual('usageReported' in failedEvent, false);
    assert.strictEqual(registry.get(spawn.id)?.totalTokens, 12);
  });

  void it('emits only the current successful turn usage alongside cumulative totals', async () => {
    const { deferredTurns, registry, service, telemetryEvents } = createHarness({
      tokenUsages: [
        {
          attributionSource: 'provider-event',
          inputTokens: 5,
          model: 'grok-4.5',
          outputTokens: 7,
          provider: {
            cachedInputTokens: 2,
            inputTokens: 5,
            outputTokens: 7,
            reasoningOutputTokens: 3,
            totalTokens: 12,
          },
          providerId: 'xai',
        },
        {
          attributionSource: 'provider-event',
          inputTokens: 11,
          model: 'grok-4.5',
          outputTokens: 13,
          provider: {
            cacheCreationInputTokens: 17,
            inputTokens: 11,
            outputTokens: 13,
            reasoningOutputTokens: 5,
            totalTokens: 24,
          },
          providerId: 'xai',
        },
      ],
    });
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Complete the first turn.',
      model: 'grok-4.5',
      projectRoot: '/repo/worktree',
    });
    deferredTurns[0]?.resolve('first turn complete');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });

    await service.sendInput({ message: 'Complete the second turn.', target: spawn.id });
    deferredTurns[1]?.resolve('second turn complete');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });

    const completedEvents = telemetryEvents.filter(event => event.eventType === 'turn_completed');
    const secondEvent = requireDefined(completedEvents[1], 'expected second completed-turn telemetry');
    assert.strictEqual(secondEvent.turnUsageReported, true);
    assert.strictEqual(secondEvent.turnCachedInputTokens, 17);
    assert.strictEqual(secondEvent.turnInputTokens, 11);
    assert.strictEqual(secondEvent.turnOutputTokens, 13);
    assert.strictEqual(secondEvent.turnReasoningOutputTokens, 5);
    assert.strictEqual(secondEvent.turnTokens, 24);
    assert.strictEqual(secondEvent.totalCachedInputTokens, 19);
    assert.strictEqual(secondEvent.totalInputTokens, 16);
    assert.strictEqual(secondEvent.totalOutputTokens, 20);
    assert.strictEqual(secondEvent.totalReasoningOutputTokens, 8);
    assert.strictEqual(secondEvent.totalTokens, 36);
    assert.strictEqual(registry.get(spawn.id)?.totalTokens, 36);
  });

  void it('emits budget rejection and close/dispose telemetry', async () => {
    const budgetHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_MAX_LIFECYCLE_CALLS: '1',
        CODEX_THREAD_ID: 'codex-thread-1',
      },
    });
    const spawn = await budgetHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    await assert.rejects(
      () => budgetHarness.service.sendInput({ message: 'continue', target: spawn.id }),
      /budget_exceeded: max_lifecycle_calls/u,
    );
    const budgetEvent = requireDefined(
      budgetHarness.telemetryEvents.find(event => event.eventType === 'budget_rejected'),
      'expected budget rejection telemetry',
    );
    assert.strictEqual(budgetEvent.agentId, spawn.id);
    assert.strictEqual(budgetEvent.current, 1);
    assert.strictEqual(budgetEvent.envKey, 'AI_SUBAGENT_MAX_LIFECYCLE_CALLS');
    assert.strictEqual(budgetEvent.limit, 1);
    assert.strictEqual(budgetEvent.limitName, 'max_lifecycle_calls');
    assert.strictEqual(budgetEvent.operation, 'send_input');
    assert.strictEqual(budgetEvent.parentSessionId, 'codex-thread-1');
    assert.strictEqual(budgetEvent.parentSessionIdSource, 'env:CODEX_THREAD_ID');
    assert.strictEqual(budgetEvent.status, 'error');

    await budgetHarness.service.closeAgent({ target: spawn.id });
    const closeEvent = requireDefined(
      budgetHarness.telemetryEvents.find(event => event.eventType === 'close'),
      'expected close telemetry',
    );
    assert.strictEqual(closeEvent.agentId, spawn.id);
    assert.strictEqual(closeEvent.status, 'ok');

    const disposeHarness = createHarness();
    const disposable = await disposeHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    await disposeHarness.service.dispose();
    const disposeEvent = requireDefined(
      disposeHarness.telemetryEvents.find(event => event.eventType === 'dispose'),
      'expected dispose telemetry',
    );
    assert.strictEqual(disposeEvent.agentId, disposable.id);
    assert.strictEqual(disposeEvent.parentSessionIdSource, 'fallback:server_run_id');
    assert.strictEqual(disposeEvent.status, 'ok');
  });

  void it('honors includeOutput=false without consuming completed output', async () => {
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'ask',
      message: 'Check this.',
      projectRoot: '/repo/worktree',
    });

    deferredTurns[0]?.resolve('bounded answer');
    const metadataWait = await service.waitAgent({ includeOutput: false, targets: [spawn.id], timeoutMs: 100 });
    const metadataResult = requireDefined(metadataWait.results[0], 'expected metadata wait result');
    assert.strictEqual(metadataResult.output, undefined);
    assert.strictEqual(metadataResult.outputBytes, Buffer.byteLength('bounded answer', 'utf8'));
    assert.strictEqual(metadataResult.outputConsumed, false);
    assert.strictEqual(metadataResult.status, 'completed');

    const deliveryWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 0 });
    const deliveryResult = requireDefined(deliveryWait.results[0], 'expected delivery wait result');
    assert.strictEqual(deliveryResult.output, 'bounded answer');
    assert.strictEqual(deliveryResult.outputConsumed, true);
  });

  void it('keeps provider completion when inline output crosses an operator cap', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-subagent-project-'));
    try {
      const { createSessionCalls, deferredTurns, service } = createHarness({
        env: {
          ...DEFAULT_HARNESS_ENV,
          AI_SUBAGENT_MAX_OUTPUT_BYTES: '10',
        },
      });
      const spawn = await service.spawnAgent({ agentType: 'ask', message: 'Check this.', projectRoot });
      assert.equal(Object.hasOwn(createSessionCalls[0] ?? {}, 'maxOutputBytes'), false);
      const output = '123456789\u{1F600}tail';

      deferredTurns[0]?.resolve(output);
      const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
      const result = requireDefined(wait.results[0], 'expected truncated wait result');

      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.output, '123456789');
      assert.strictEqual(result.outputBytes, Buffer.byteLength(output, 'utf8'));
      assert.strictEqual(result.outputConsumed, true);
      assert.strictEqual(result.outputTruncated, true);
      assert.strictEqual(result.status, 'completed');
      assert.match(result.outputRef ?? '', /\/\.ai\/logs\/ai-subagent-.+\.log/u);
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  void it('launches an explicitly selected subscription model without a second plugin confirmation', async () => {
    const harness = createHarness();
    const spawn = await harness.service.spawnAgent({
      agentType: 'reviewer',
      model: 'gpt-6-astra',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(spawn.agentType, 'reviewer');
    assert.strictEqual(spawn.modelId, 'gpt-6-astra');
    assert.strictEqual(spawn.reasoningEffort, 'xhigh');
    assert.deepStrictEqual(harness.auditEvents.find(event => event.event === 'subagent_spawn')?.fields, {
      agentType: 'reviewer',
      model: 'gpt',
      modelId: 'gpt-6-astra',
      provider: 'openai',
      reasoningEffort: 'xhigh',
      requestedModelId: 'gpt-6-astra',
      requestedReasoningEffort: 'xhigh',
      requiresOpenRouter: false,
      resolvedModelId: 'gpt-6-astra',
      resolvedReasoningEffort: 'xhigh',
    });
  });

  void it('keeps native GPT sessions on the parent host configuration', async () => {
    const { createSessionCalls, restrictedHomeCalls, service } = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_AGENT_IDENTITY: 'gpt-builder',
        CLAUDE_CONFIG_DIR: '/native/claude',
        CODEX_HOME: '/native/codex',
        GROK_HOME: '/native/grok',
      },
    });

    await service.spawnAgent({ agentType: 'reviewer', model: 'gpt-6-astra', projectRoot: '/repo/worktree' });

    const createSessionCall = requireDefined(createSessionCalls[0], 'expected reviewer session');
    assert.deepStrictEqual(createSessionCall.behavior, { sandbox: 'off' });
    assert.strictEqual(createSessionCall.model, 'gpt');
    assert.strictEqual(createSessionCall.modelId, 'gpt-6-astra');
    assert.strictEqual(createSessionCall.reasoning, 'xhigh');
    assert.strictEqual(createSessionCall.envMode, 'replace');
    assert.strictEqual(createSessionCall.runtimeMode, 'host-native');
    const sessionEnv = requireDefined(createSessionCall.env, 'expected reviewer session env');
    assert.strictEqual(sessionEnv.AI_AGENT_IDENTITY, 'gpt-builder');
    assert.strictEqual(sessionEnv.CLAUDE_CONFIG_DIR, '/native/claude');
    assert.strictEqual(sessionEnv.CODEX_HOME, '/native/codex');
    assert.strictEqual(sessionEnv.GROK_HOME, '/native/grok');
    assertHostNativeEnv(sessionEnv);
    assert.strictEqual(sessionEnv.EXAMPLE_CLOUD_PROFILE, 'operator-profile');
    assert.strictEqual(sessionEnv.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_test');
    assert.strictEqual(sessionEnv.OPENROUTER_API_KEY, undefined);
    assert.strictEqual(createSessionCall.mcpConfig, undefined);
    assert.strictEqual(createSessionCall.strictMcpConfig, undefined);
    assert.deepStrictEqual(restrictedHomeCalls, []);
  });

  void it('launches an ask from a readable non-writable directory without creating plugin state there', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-subagent-read-only-root-'));
    const home = mkdtempSync(join(tmpdir(), 'ai-subagent-read-only-home-'));
    chmodSync(projectRoot, 0o555);
    try {
      const { createSessionCalls, service } = createHarness({
        env: { ...DEFAULT_HARNESS_ENV, HOME: home },
      });

      const spawned = await service.spawnAgent({ agentType: 'ask', model: 'gpt-6-astra', projectRoot });

      assert.equal(spawned.status, 'idle');
      assert.equal(existsSync(join(projectRoot, '.ai')), false);
      const sessionOptions = createSessionCalls[0] as ApiAgentSessionOptions & { transcriptPath?: string };
      assert.match(sessionOptions.transcriptPath ?? '', /ai-subagent\/transcripts\/ai-subagent-.+\.log/u);
    } finally {
      chmodSync(projectRoot, 0o755);
      rmSync(projectRoot, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
    }
  });

  void it('does not follow a repository-controlled transcript directory symlink', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-subagent-symlink-root-'));
    const home = mkdtempSync(join(tmpdir(), 'ai-subagent-symlink-home-'));
    const outside = mkdtempSync(join(tmpdir(), 'ai-subagent-symlink-outside-'));
    mkdirSync(join(projectRoot, '.ai'));
    writeFileSync(join(outside, 'sentinel.txt'), 'unchanged\n', 'utf8');
    symlinkSync(outside, join(projectRoot, '.ai', 'logs'));
    try {
      const { createSessionCalls, service } = createHarness({
        env: { ...DEFAULT_HARNESS_ENV, HOME: home },
      });

      await service.spawnAgent({ agentType: 'ask', model: 'gpt-6-astra', projectRoot });

      const sessionOptions = requireDefined(createSessionCalls[0], 'expected ask session');
      assert.match(sessionOptions.transcriptPath ?? '', /ai-subagent\/transcripts\/ai-subagent-.+\.log/u);
      assert.deepStrictEqual(readdirSync(outside), ['sentinel.txt']);
      assert.strictEqual(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'unchanged\n');
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  void it('makes an existing transcript directory owner-private before use', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-subagent-private-transcript-root-'));
    const transcriptDirectory = join(projectRoot, '.ai', 'logs');
    mkdirSync(transcriptDirectory, { mode: 0o777, recursive: true });
    chmodSync(transcriptDirectory, 0o777);
    try {
      const { createSessionCalls, service } = createHarness();

      await service.spawnAgent({ agentType: 'ask', model: 'gpt-6-astra', projectRoot });

      assert.equal(statSync(transcriptDirectory).mode & 0o777, 0o700);
      assert.match(createSessionCalls[0]?.transcriptPath ?? '', /ai-subagent-.+\.log/u);
    } finally {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  void it('fails closed when the private fallback transcript directory is a symlink', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ai-subagent-fallback-root-'));
    const home = mkdtempSync(join(tmpdir(), 'ai-subagent-fallback-home-'));
    const outside = mkdtempSync(join(tmpdir(), 'ai-subagent-fallback-outside-'));
    const localState = join(home, '.local', 'share', 'ai-subagent');
    mkdirSync(localState, { recursive: true });
    symlinkSync(outside, join(localState, 'transcripts'));
    chmodSync(projectRoot, 0o555);
    try {
      const { service } = createHarness({ env: { ...DEFAULT_HARNESS_ENV, HOME: home } });

      await assert.rejects(
        service.spawnAgent({ agentType: 'ask', model: 'gpt-6-astra', projectRoot }),
        /unsafe_transcript_path/u,
      );
      assert.deepStrictEqual(readdirSync(outside), []);
    } finally {
      chmodSync(projectRoot, 0o755);
      rmSync(projectRoot, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  void it('keeps native Claude sessions on the parent host configuration', async () => {
    const { createSessionCalls, restrictedHomeCalls, service } = createHarness();

    await service.spawnAgent({ agentType: 'ask', model: 'claude-fable-5[1m]', projectRoot: '/repo/worktree' });

    const createSessionCall = requireDefined(createSessionCalls[0], 'expected Claude session');
    assert.deepStrictEqual(createSessionCall.behavior, { sandbox: 'off' });
    assert.strictEqual(createSessionCall.runtimeMode, 'host-native');
    assert.strictEqual(createSessionCall.mcpConfig, undefined);
    assert.strictEqual(createSessionCall.strictMcpConfig, undefined);
    assert.strictEqual(createSessionCall.env?.CODEX_HOME, undefined);
    assert.deepStrictEqual(restrictedHomeCalls, []);
  });

  void it('applies preset reasoning defaults and preserves explicit reviewer overrides', async () => {
    const defaultHarness = createHarness();
    const defaultSpawn = await defaultHarness.service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });
    const defaultCall = requireDefined(defaultHarness.createSessionCalls[0], 'expected default session');
    assert.strictEqual(defaultSpawn.modelId, 'gpt-5.6-terra');
    assert.strictEqual(defaultSpawn.reasoningEffort, 'xhigh');
    assert.strictEqual(defaultCall.modelId, 'gpt-5.6-terra');
    assert.strictEqual(defaultCall.reasoning, 'xhigh');

    const explorerHarness = createHarness();
    const explorerSpawn = await explorerHarness.service.spawnAgent({
      agentType: 'explorer',
      projectRoot: '/repo/worktree',
    });
    const explorerCall = requireDefined(explorerHarness.createSessionCalls[0], 'expected explorer session');
    assert.strictEqual(explorerSpawn.modelId, 'gpt-5.6-luna');
    assert.strictEqual(explorerSpawn.reasoningEffort, 'xhigh');
    assert.strictEqual(explorerCall.modelId, 'gpt-5.6-luna');
    assert.strictEqual(explorerCall.reasoning, 'xhigh');

    const overrideHarness = createHarness();
    const overrideSpawn = await overrideHarness.service.spawnAgent({
      agentType: 'reviewer',
      model: 'gpt-5.6-terra',
      projectRoot: '/repo/worktree',
      reasoningEffort: 'xhigh',
    });
    const overrideCall = requireDefined(overrideHarness.createSessionCalls[0], 'expected override session');
    assert.strictEqual(overrideSpawn.modelId, 'gpt-5.6-terra');
    assert.strictEqual(overrideSpawn.reasoningEffort, 'xhigh');
    assert.strictEqual(overrideCall.modelId, 'gpt-5.6-terra');
    assert.strictEqual(overrideCall.reasoning, 'xhigh');

    assert.deepStrictEqual(overrideHarness.auditEvents.find(event => event.event === 'subagent_spawn')?.fields, {
      agentType: 'reviewer',
      model: 'gpt',
      modelId: 'gpt-5.6-terra',
      provider: 'openai',
      reasoningEffort: 'xhigh',
      requestedModelId: 'gpt-5.6-terra',
      requestedReasoningEffort: 'xhigh',
      requiresOpenRouter: false,
      resolvedModelId: 'gpt-5.6-terra',
      resolvedReasoningEffort: 'xhigh',
    });

    const builderHarness = createHarness();
    const builderSpawn = await builderHarness.service.spawnAgent({
      agentType: 'builder',
      projectRoot: '/repo/worktree',
    });
    const builderCall = requireDefined(builderHarness.createSessionCalls[0], 'expected builder session');
    assert.strictEqual(builderSpawn.modelId, 'grok-4.5');
    assert.strictEqual(builderSpawn.reasoningEffort, 'high');
    assert.strictEqual(builderCall.reasoning, 'high');
    const builderSpawnEvent = requireDefined(
      builderHarness.telemetryEvents.find(event => event.eventType === 'spawn'),
      'expected default builder spawn telemetry',
    );
    assert.strictEqual(routingTelemetry(builderSpawnEvent).requestedModelId, 'grok-4.5');
    assert.strictEqual(routingTelemetry(builderSpawnEvent).requestedReasoningEffort, 'high');
    assert.strictEqual(routingTelemetry(builderSpawnEvent).effectiveModelId, 'grok-4.5');
    assert.strictEqual(routingTelemetry(builderSpawnEvent).effectiveReasoningEffort, 'high');

    const askHarness = createHarness();
    const askSpawn = await askHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    const askCall = requireDefined(askHarness.createSessionCalls[0], 'expected ask session');
    assert.strictEqual(askSpawn.modelId, 'grok-4.5');
    assert.strictEqual(askSpawn.reasoningEffort, 'high');
    assert.strictEqual(askCall.reasoning, 'high');

    const reviewerHarness = createHarness();
    const reviewerSpawn = await reviewerHarness.service.spawnAgent({
      agentType: 'reviewer',
      projectRoot: '/repo/worktree',
    });
    const reviewerCall = requireDefined(reviewerHarness.createSessionCalls[0], 'expected reviewer session');
    assert.strictEqual(reviewerSpawn.modelId, 'grok-4.5');
    assert.strictEqual(reviewerSpawn.reasoningEffort, 'high');
    assert.strictEqual(reviewerCall.reasoning, 'high');
  });

  void it('uses compatible preset effort before provider defaults for explicit models', async () => {
    const astraHarness = createHarness();
    const astra = await astraHarness.service.spawnAgent({
      agentType: 'reviewer',
      model: 'gpt-6-astra',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(astra.reasoningEffort, 'xhigh');
    assert.strictEqual(astraHarness.createSessionCalls[0]?.reasoning, 'xhigh');
    const astraSpawnEvent = requireDefined(
      astraHarness.telemetryEvents.find(event => event.eventType === 'spawn'),
      'expected explicit Astra spawn telemetry',
    );
    assert.strictEqual(routingTelemetry(astraSpawnEvent).requestedModelId, 'gpt-6-astra');
    assert.strictEqual(routingTelemetry(astraSpawnEvent).requestedReasoningEffort, 'xhigh');
    assert.strictEqual(routingTelemetry(astraSpawnEvent).effectiveModelId, 'gpt-6-astra');
    assert.strictEqual(routingTelemetry(astraSpawnEvent).effectiveReasoningEffort, 'xhigh');

    const terraHarness = createHarness();
    const terra = await terraHarness.service.spawnAgent({
      agentType: 'reviewer',
      model: 'gpt-5.6-terra',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(terra.reasoningEffort, 'xhigh');
    assert.strictEqual(terraHarness.createSessionCalls[0]?.reasoning, 'xhigh');

    const claudeHarness = createHarness();
    const claude = await claudeHarness.service.spawnAgent({
      agentType: 'default',
      model: 'claude-fable-5[1m]',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(claude.reasoningEffort, 'xhigh');
    assert.strictEqual(claudeHarness.createSessionCalls[0]?.reasoning, 'xhigh');
  });

  void it('rejects unknown or model-incompatible reasoning before creating resources', async () => {
    for (const [model, reasoningEffort] of [
      ['gpt-5.6-luna', 'ultra'],
      ['gpt-6-astra', 'extreme'],
      ['glm-5.2', 'high'],
    ] as const) {
      const harness = createHarness();
      await assert.rejects(
        () =>
          harness.service.spawnAgent({
            agentType: 'default',
            model,
            projectRoot: '/repo/worktree',
            reasoningEffort,
          }),
        /reasoning/u,
      );
      assert.deepStrictEqual(harness.createSessionCalls, []);
      assert.deepStrictEqual(harness.restrictedHomeCalls, []);
    }
  });

  void it('keeps nested delegation unavailable inside child sessions', async () => {
    const blockedHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_DEPTH: '1',
      },
    });

    await assert.rejects(
      () => blockedHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' }),
      /nested_delegation_disabled/u,
    );
    assert.deepStrictEqual(blockedHarness.createSessionCalls, []);
  });

  void it('enforces parent process active, spawned, and lifecycle budgets before creating resources', async () => {
    const spawnHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_MAX_ACTIVE_AGENTS: '1',
        AI_SUBAGENT_MAX_SPAWNED_AGENTS: '2',
      },
    });

    const first = await spawnHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    await assert.rejects(
      () => spawnHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' }),
      /budget_exceeded: max_active_agents.*current=1.*limit=1.*AI_SUBAGENT_MAX_ACTIVE_AGENTS/u,
    );
    await spawnHarness.service.closeAgent({ target: first.id });
    const second = await spawnHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    await spawnHarness.service.closeAgent({ target: second.id });
    await assert.rejects(
      () => spawnHarness.service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' }),
      /budget_exceeded: max_spawned_agents.*current=2.*limit=2.*AI_SUBAGENT_MAX_SPAWNED_AGENTS/u,
    );
    assert.strictEqual(spawnHarness.createSessionCalls.length, 2);

    const lifecycleHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_MAX_LIFECYCLE_CALLS: '1',
      },
    });
    const lifecycleSpawn = await lifecycleHarness.service.spawnAgent({
      agentType: 'ask',
      projectRoot: '/repo/worktree',
    });
    await assert.rejects(
      () => lifecycleHarness.service.sendInput({ message: 'continue', target: lifecycleSpawn.id }),
      /budget_exceeded: max_lifecycle_calls.*operation=send_input.*current=1.*limit=1.*AI_SUBAGENT_MAX_LIFECYCLE_CALLS/u,
    );
    await assert.doesNotReject(() => lifecycleHarness.service.closeAgent({ target: lifecycleSpawn.id }));
  });

  void it('does not count terminal agents against the active-agent budget', async () => {
    const completedHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_MAX_ACTIVE_AGENTS: '1',
        AI_SUBAGENT_MAX_SPAWNED_AGENTS: '2',
      },
    });

    const builder = await completedHarness.service.spawnAgent({
      agentType: 'builder',
      message: 'Implement the scoped change.',
      projectRoot: '/repo/worktree',
    });
    completedHarness.deferredTurns[0]?.resolve('DONE');
    const builderWait = await completedHarness.service.waitAgent({ targets: [builder.id], timeoutMs: 100 });
    assert.strictEqual(requireDefined(builderWait.results[0], 'expected completed builder').status, 'completed');

    const reviewer = await completedHarness.service.spawnAgent({
      agentType: 'reviewer',
      message: 'Review the builder output.',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(reviewer.status, 'in_progress');
    completedHarness.deferredTurns[1]?.resolve('VERDICT: approve');
    await completedHarness.service.waitAgent({ targets: [reviewer.id], timeoutMs: 100 });

    await assert.rejects(
      () =>
        completedHarness.service.spawnAgent({
          agentType: 'builder',
          message: 'Try a third agent.',
          projectRoot: '/repo/worktree',
        }),
      /budget_exceeded: max_spawned_agents.*current=2.*limit=2.*AI_SUBAGENT_MAX_SPAWNED_AGENTS/u,
    );

    const errorHarness = createHarness({
      env: {
        ...DEFAULT_HARNESS_ENV,
        AI_SUBAGENT_MAX_ACTIVE_AGENTS: '1',
        AI_SUBAGENT_MAX_SPAWNED_AGENTS: '3',
      },
    });
    const failed = await errorHarness.service.spawnAgent({
      agentType: 'ask',
      message: 'Check this.',
      projectRoot: '/repo/worktree',
    });
    errorHarness.deferredTurns[0]?.reject(new Error('provider failed'));
    const failedWait = await errorHarness.service.waitAgent({ targets: [failed.id], timeoutMs: 100 });
    assert.strictEqual(requireDefined(failedWait.results[0], 'expected failed result').status, 'error');

    const next = await errorHarness.service.spawnAgent({
      agentType: 'ask',
      message: 'Try again with a fresh agent.',
      projectRoot: '/repo/worktree',
    });
    assert.strictEqual(next.status, 'in_progress');
  });

  void it('uses a generous default lifetime spawn backstop for normal builder-review loops', async () => {
    const { service } = createHarness();

    for (let index = 0; index < 13; index += 1) {
      const spawn = await service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
      await service.closeAgent({ target: spawn.id });
    }
  });

  void it('reports sanitized progress without changing observational wait behavior', async () => {
    let currentTime = 1_000;
    const { createSessionCalls, deferredTurns, disposedSessionIds, registry, registryUpserts, service } = createHarness(
      {
        now: () => currentTime,
      },
    );
    const spawn = await service.spawnAgent({
      agentType: 'ask',
      message: 'Keep working.',
      projectRoot: '/repo/worktree',
    });

    const onActivity = requireDefined(createSessionCalls[0]?.onActivity, 'expected session activity callback');
    currentTime = 1_010;
    onActivity({ bytes: 5, source: 'stdout' });
    currentTime = 1_020;
    onActivity({ bytes: 12, source: 'stderr' });
    currentTime = 1_030;
    const active = await service.waitAgent({ includeOutput: false, targets: [spawn.id], timeoutMs: 0 });

    assert.deepStrictEqual(Reflect.get(active.results[0] ?? {}, 'progress'), {
      activityCount: 2,
      elapsedMs: 30,
      firstActivityAtMs: 1_010,
      idleMs: 10,
      lastActivityAtMs: 1_020,
      receivedBytes: 17,
      startedAtMs: 1_000,
    });
    assert.strictEqual(active.results[0]?.outputConsumed, undefined);
    assert.deepStrictEqual(disposedSessionIds, []);
    assert.strictEqual(registry.get(spawn.id)?.status, 'in_progress');

    deferredTurns[0]?.resolve('finished after observation');
    const terminal = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const terminalResult = requireDefined(terminal.results[0], 'expected terminal result');
    assert.strictEqual(terminalResult.output, 'finished after observation');
    assert.strictEqual(Reflect.get(terminalResult, 'progress'), undefined);
    assert.strictEqual(terminalResult.status, 'completed');

    const registryWriteCount = registryUpserts.length;
    const disposedCount = disposedSessionIds.length;
    const observedAgain = await service.waitAgent({ targets: [spawn.id], timeoutMs: 0 });
    assert.strictEqual(observedAgain.results[0]?.output, undefined);
    assert.strictEqual(observedAgain.results[0]?.outputConsumed, true);
    assert.strictEqual(registryUpserts.length, registryWriteCount);
    assert.strictEqual(disposedSessionIds.length, disposedCount);
  });

  void it('persists sanitized child-process completion evidence for parent health decisions', async () => {
    let currentTime = 1_000;
    const { createSessionCalls, deferredTurns, registry, service, telemetryEvents } = createHarness({
      now: () => currentTime,
    });
    const spawn = await service.spawnAgent({
      agentType: 'ask',
      message: 'Keep working until the parent decides otherwise.',
      projectRoot: '/repo/worktree',
    });

    const sessionOptions = requireDefined(createSessionCalls[0], 'expected session options');
    const onProcessOutcome = (
      sessionOptions as ApiAgentSessionOptions & {
        onProcessOutcome?: (outcome: ProcessOutcomeProbe) => void;
      }
    ).onProcessOutcome;
    assert.notStrictEqual(onProcessOutcome, undefined);
    onProcessOutcome?.({
      completionMs: 80,
      exitCode: 1,
      firstActivityMs: 20,
      lastActivityMs: 60,
      receivedBytes: 17,
      signal: null,
      stderrBytes: 12,
      stdoutBytes: 5,
      structuredOutput: {
        lastEventKind: 'tool_use',
        state: 'incomplete',
        terminalEventSeen: false,
        turnUsageReported: false,
        validEventCount: 3,
      },
    });

    currentTime = 1_080;
    deferredTurns[0]?.reject(new Error('grok_terminal_failure: Native Grok ended without a structured result.'));
    const terminal = await service.waitAgent({ includeOutput: false, targets: [spawn.id], timeoutMs: 100 });
    const terminalResult = requireDefined(terminal.results[0], 'expected terminal result');

    assert.deepStrictEqual(Reflect.get(terminalResult, 'processOutcome'), {
      completionMs: 80,
      exitCode: 1,
      firstActivityMs: 20,
      lastActivityMs: 60,
      receivedBytes: 17,
      signal: null,
      stderrBytes: 12,
      stdoutBytes: 5,
      structuredOutput: {
        lastEventKind: 'tool_use',
        state: 'incomplete',
        terminalEventSeen: false,
        turnUsageReported: false,
        validEventCount: 3,
      },
    });
    assert.deepStrictEqual(Reflect.get(registry.get(spawn.id) ?? {}, 'processOutcome'), {
      completionMs: 80,
      exitCode: 1,
      firstActivityMs: 20,
      lastActivityMs: 60,
      receivedBytes: 17,
      signal: null,
      stderrBytes: 12,
      stdoutBytes: 5,
      structuredOutput: {
        lastEventKind: 'tool_use',
        state: 'incomplete',
        terminalEventSeen: false,
        turnUsageReported: false,
        validEventCount: 3,
      },
    });
    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected terminal telemetry',
    );
    assert.strictEqual(Reflect.get(failedEvent, 'processExitCode'), 1);
    assert.strictEqual(Reflect.get(failedEvent, 'processReceivedBytes'), 17);
    assert.strictEqual(Reflect.get(failedEvent, 'processCompletionMs'), 80);
    assert.strictEqual(Reflect.get(failedEvent, 'processLastActivityMs'), 60);
    assert.strictEqual(Reflect.get(failedEvent, 'processStderrBytes'), 12);
    assert.strictEqual(Reflect.get(failedEvent, 'processStdoutBytes'), 5);
    assert.deepStrictEqual(Reflect.get(failedEvent, 'structuredOutput'), {
      lastEventKind: 'tool_use',
      state: 'incomplete',
      terminalEventSeen: false,
      turnUsageReported: false,
      validEventCount: 3,
    });
  });

  void it('clears the observation timeout when an active turn settles first', async () => {
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'ask',
      message: 'Finish before the observation deadline.',
      projectRoot: '/repo/worktree',
    });
    const timeoutCountBeforeWait = activeTimeoutCount();

    const waiting = service.waitAgent({ targets: [spawn.id], timeoutMs: 2_000 });
    deferredTurns[0]?.resolve('finished');
    const result = await waiting;

    assert.strictEqual(result.results[0]?.status, 'completed');
    assert.strictEqual(activeTimeoutCount(), timeoutCountBeforeWait);
  });

  void it('omits child timeout options from every provider session', async () => {
    const { createSessionCalls, service } = createHarness();
    await service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    const sessionOptions = requireDefined(createSessionCalls[0], 'expected session options');
    assert.strictEqual(sessionOptions.idleTimeoutMs, undefined);
    assert.strictEqual(sessionOptions.maxTurnMs, undefined);
  });

  void it('launches default Grok ask presets with native authority', async () => {
    const { createSessionCalls, service } = createHarness();

    await service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });

    const createSessionCall = requireDefined(createSessionCalls[0], 'expected ask session');
    assert.deepStrictEqual(createSessionCall.behavior, { sandbox: 'off' });
    assert.strictEqual(createSessionCall.model, 'xai');
    assert.strictEqual(createSessionCall.modelId, 'grok-4.5');
    assert.strictEqual(createSessionCall.envMode, 'replace');
    assert.strictEqual(createSessionCall.runtimeMode, 'host-native');
    const sessionEnv = requireDefined(createSessionCall.env, 'expected ask session env');
    assertHostNativeEnv(sessionEnv);
    assert.strictEqual(sessionEnv.EXAMPLE_CLOUD_PROFILE, 'operator-profile');
    assert.strictEqual(sessionEnv.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_test');
    assert.strictEqual(sessionEnv.OPENROUTER_API_KEY, undefined);
    assert.strictEqual(createSessionCall.mcpConfig, undefined);
    assert.strictEqual(createSessionCall.strictMcpConfig, undefined);

    await service.dispose();
  });

  void it('fails closed before creating a manually selected GLM fallback when OpenRouter credentials are missing', async () => {
    const { createSessionCalls, restrictedHomeCalls, service } = createHarness({
      env: {},
    });

    await assert.rejects(
      () => service.spawnAgent({ agentType: 'builder', model: 'glm-5.2', projectRoot: '/repo/worktree' }),
      /missing_openrouter_api_key/u,
    );
    assert.deepStrictEqual(createSessionCalls, []);
    assert.deepStrictEqual(restrictedHomeCalls, []);
  });

  void it('fails loudly for unsupported native spawn option hints', async () => {
    const { createSessionCalls, service } = createHarness();

    await assert.rejects(
      () => service.spawnAgent({ agentType: 'default', forkContext: true, projectRoot: '/repo/worktree' }),
      /agent_fork_source_required/u,
    );
    await assert.rejects(
      () => service.spawnAgent({ agentType: 'builder', forkContext: true, projectRoot: '/repo/worktree' }),
      /agent_fork_unsupported/u,
    );
    await assert.rejects(
      () => service.spawnAgent({ agentType: 'default', projectRoot: '/repo/worktree', serviceTier: 'standard' }),
      /unsupported_spawn_option: service_tier/u,
    );
    assert.deepStrictEqual(createSessionCalls, []);
  });

  void it('queues concurrent send_input and starts it after the active turn settles', async () => {
    const { deferredTurns, sends, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });

    await service.sendInput({ message: 'first', target: spawn.id });
    const queued = await service.sendInput({ message: 'second', target: spawn.id });
    assert.strictEqual(queued.status, 'in_progress');
    assert.deepStrictEqual(sends, ['first']);

    deferredTurns[0]?.resolve('first complete');
    await flushTurnDrain();
    assert.deepStrictEqual(sends, ['first', 'second']);

    deferredTurns[1]?.resolve('second complete');
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const waitResult = wait.results.at(0);
    assert.ok(waitResult);
    assert.strictEqual(waitResult.output, 'second complete');
    assert.strictEqual(waitResult.status, 'completed');
  });

  void it('wait_agent follows a queued replacement turn instead of returning an empty result', async () => {
    const { deferredTurns, sends, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      message: 'first',
      projectRoot: '/repo/worktree',
    });
    await service.sendInput({ message: 'second', target: spawn.id });

    const waiting = service.waitAgent({ targets: [spawn.id], timeoutMs: 1_000 });
    deferredTurns[0]?.resolve('first complete');
    await flushTurnDrain();
    assert.deepStrictEqual(sends, ['first', 'second']);
    deferredTurns[1]?.resolve('second complete');

    const result = await waiting;
    const queuedResult = requireDefined(result.results[0], 'expected queued turn result');
    assert.strictEqual(queuedResult.id, spawn.id);
    assert.strictEqual(queuedResult.output, 'second complete');
    assert.strictEqual(queuedResult.status, 'completed');
  });

  void it('bounds queued turns per agent before accepting more work', async () => {
    const { service } = createHarness({
      env: { ...DEFAULT_HARNESS_ENV, AI_SUBAGENT_MAX_QUEUED_TURNS_PER_AGENT: '1' },
    });
    const spawn = await service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });

    await service.sendInput({ message: 'active', target: spawn.id });
    await service.sendInput({ message: 'queued', target: spawn.id });
    await assert.rejects(() => service.sendInput({ message: 'too many', target: spawn.id }), /agent_queue_full/u);
  });

  void it('interrupts a supported active turn and starts the replacement before older queued turns', async () => {
    const { deferredTurns, interruptedSessionIds, sends, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });

    await service.sendInput({ message: 'first', target: spawn.id });
    await service.sendInput({ message: 'older queued', target: spawn.id });
    const replacement = await service.sendInput({ interrupt: true, message: 'replacement', target: spawn.id });

    assert.strictEqual(replacement.status, 'in_progress');
    assert.deepStrictEqual(interruptedSessionIds, ['backend-1']);
    assert.deepStrictEqual(sends, ['first', 'replacement']);
    const interruptedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected interrupted-turn telemetry',
    );
    assert.strictEqual(interruptedEvent.terminalCause, 'cancelled');
    assert.strictEqual(interruptedEvent.terminalOwner, 'parent');

    deferredTurns[1]?.resolve('replacement complete');
    await flushTurnDrain();
    assert.deepStrictEqual(sends, ['first', 'replacement', 'older queued']);
    deferredTurns[2]?.resolve('queue complete');
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    assert.strictEqual(wait.results[0]?.output, 'queue complete');
  });

  void it('fails closed before interrupting when the selected transport lacks interrupt support', async () => {
    const { interruptedSessionIds, sends, service } = createHarness({
      sessionCapabilities: { fork: false, interrupt: false, queue: false, resume: false },
    });
    const spawn = await service.spawnAgent({ agentType: 'ask', projectRoot: '/repo/worktree' });
    await service.sendInput({ message: 'first', target: spawn.id });

    await assert.rejects(
      () => service.sendInput({ interrupt: true, message: 'replacement', target: spawn.id }),
      /agent_interrupt_unsupported/u,
    );
    assert.deepStrictEqual(interruptedSessionIds, []);
    assert.deepStrictEqual(sends, ['first']);
  });

  void it('wait_agent returns when the first requested active turn settles', async () => {
    const { deferredTurns, service } = createHarness();
    const first = await service.spawnAgent({ agentType: 'ask', message: 'first', projectRoot: '/repo/worktree' });
    const second = await service.spawnAgent({ agentType: 'ask', message: 'second', projectRoot: '/repo/worktree' });

    const waiting = service.waitAgent({ targets: [first.id, second.id], timeoutMs: 100 });
    deferredTurns[0]?.resolve('first complete');
    const result = await waiting;

    assert.deepStrictEqual(
      result.results.map(item => item.id),
      [first.id],
    );
    assert.strictEqual(result.results[0]?.status, 'completed');
  });

  void it('delivers turn failures through wait_agent without unhandled rejections', async () => {
    const { deferredTurns, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({ agentType: 'ask', message: 'Check this', projectRoot: '/repo/worktree' });

    deferredTurns[0]?.reject(new Error('provider failed'));
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected failure wait result');

    assert.strictEqual(result.error, 'provider failed');
    assert.strictEqual(result.id, spawn.id);
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.terminalCause, 'provider_error');
    assert.strictEqual(result.terminalOwner, 'provider');
    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected failed-turn telemetry',
    );
    assert.strictEqual(failedEvent.cleanupOutcome, 'not_required');
    assert.strictEqual(failedEvent.terminalCause, 'provider_error');
    assert.strictEqual(failedEvent.terminalOwner, 'provider');
  });

  void it('retains a bounded provider terminal status without parsing error prose', async () => {
    const { deferredTurns, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Check this',
      projectRoot: '/repo/worktree',
    });

    deferredTurns[0]?.reject(
      Object.assign(new Error('opaque native terminal failure'), {
        code: 'grok_acp_provider_failed',
        terminalStatus: 'Cancelled',
      }),
    );
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected failed result');
    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected failed-turn telemetry',
    );

    assert.strictEqual(result.providerTerminalStatus, 'Cancelled');
    assert.strictEqual(result.terminalCause, 'grok_acp_provider_failed');
    assert.strictEqual(result.terminalOwner, 'provider');
    assert.strictEqual(failedEvent.providerTerminalStatus, 'Cancelled');
    assert.strictEqual(failedEvent.terminalCause, 'grok_acp_provider_failed');
    assert.strictEqual(failedEvent.terminalOwner, 'provider');
  });

  void it('exposes exhausted Grok usage as a stable provider-owned terminal cause', async () => {
    const { deferredTurns, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'ask',
      message: 'Check this',
      projectRoot: '/repo/worktree',
    });

    deferredTurns[0]?.reject(
      Object.assign(new Error('safe adapter-owned usage message'), {
        code: 'grok_usage_balance_exhausted',
        terminalStatus: 'http_402',
      }),
    );
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected failed result');
    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected failed-turn telemetry',
    );

    assert.strictEqual(result.providerTerminalStatus, 'http_402');
    assert.strictEqual(result.terminalCause, 'grok_usage_balance_exhausted');
    assert.strictEqual(result.terminalOwner, 'provider');
    assert.strictEqual(failedEvent.providerTerminalStatus, 'http_402');
    assert.strictEqual(failedEvent.terminalCause, 'grok_usage_balance_exhausted');
    assert.strictEqual(failedEvent.terminalOwner, 'provider');
  });

  void it('attributes stable adapter and policy failures without parsing provider prose', async () => {
    const { deferredTurns, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({ agentType: 'ask', message: 'Check this', projectRoot: '/repo/worktree' });

    deferredTurns[0]?.reject(
      Object.assign(new Error('provider prose must not become a terminal cause'), {
        code: 'grok_acp_protocol_malformed',
      }),
    );
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.sendInput({ message: 'Try a policy failure', target: spawn.id });
    deferredTurns[1]?.reject(
      Object.assign(new Error('another provider message'), { code: 'grok_acp_attribution_mismatch' }),
    );
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.sendInput({ message: 'Try an attribution failure', target: spawn.id });
    deferredTurns[2]?.reject(
      Object.assign(new Error('model detail must remain opaque'), {
        code: 'claude_unexpected_model_attribution',
      }),
    );
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.sendInput({ message: 'Try a capacity failure', target: spawn.id });
    deferredTurns[3]?.reject(
      Object.assign(new Error('capacity detail must remain opaque'), {
        code: 'claude_capacity_exhausted',
      }),
    );
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.sendInput({ message: 'Try an output-bound failure', target: spawn.id });
    deferredTurns[4]?.reject(
      Object.assign(new Error('provider output detail must remain opaque'), {
        code: 'grok_output_limit_exceeded',
      }),
    );
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });

    const failures = telemetryEvents.filter(event => event.eventType === 'turn_failed');
    assert.deepStrictEqual(
      failures.map(event => [event.terminalOwner, event.terminalCause]),
      [
        ['adapter', 'grok_acp_protocol_malformed'],
        ['policy', 'grok_acp_attribution_mismatch'],
        ['policy', 'claude_unexpected_model_attribution'],
        ['provider', 'claude_capacity_exhausted'],
        ['adapter', 'grok_output_limit_exceeded'],
      ],
    );
  });

  void it('collapses unrecognized error codes to a provider-owned generic cause', async () => {
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({ agentType: 'ask', message: 'Check this', projectRoot: '/repo/worktree' });

    deferredTurns[0]?.reject(
      Object.assign(new Error('foreign provider detail'), { code: 'foreign_untrusted_error_code' }),
    );
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected failed result');

    assert.strictEqual(result.terminalCause, 'provider_error');
    assert.strictEqual(result.terminalOwner, 'provider');
  });

  void it('records turn-level adapter cleanup failures as failed cleanup', async () => {
    const { deferredTurns, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'builder',
      message: 'Check this',
      projectRoot: '/repo/worktree',
    });

    deferredTurns[0]?.reject(
      Object.assign(new Error('bounded cleanup failure'), { code: 'grok_session_cleanup_failed' }),
    );
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected failed result');
    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected failed-turn telemetry',
    );

    assert.strictEqual(result.cleanupOutcome, 'failed');
    assert.strictEqual(result.terminalCause, 'grok_session_cleanup_failed');
    assert.strictEqual(result.terminalOwner, 'runtime');
    assert.strictEqual(failedEvent.cleanupOutcome, 'failed');
  });

  void it('surfaces reviewer capacity failures without changing the resolved model or effort', async () => {
    const { deferredTurns, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'reviewer',
      message: 'Review this change.',
      model: 'gpt-6-astra',
      projectRoot: '/repo/worktree',
    });

    deferredTurns[0]?.reject(new Error('provider_capacity_exhausted'));
    const wait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const result = requireDefined(wait.results[0], 'expected reviewer failure');
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.modelId, 'gpt-6-astra');
    assert.strictEqual(result.reasoningEffort, 'xhigh');
    const failedEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'turn_failed'),
      'expected failed-turn telemetry',
    );
    assert.strictEqual(routingTelemetry(failedEvent).effectiveModelId, 'gpt-6-astra');
    assert.strictEqual(routingTelemetry(failedEvent).effectiveReasoningEffort, 'xhigh');
    assert.strictEqual(failedEvent.resolvedReasoningEffort, 'xhigh');
  });

  void it('clears stale turn errors after a failed turn is retried successfully', async () => {
    const { deferredTurns, service } = createHarness();
    const spawn = await service.spawnAgent({ agentType: 'ask', message: 'Check this', projectRoot: '/repo/worktree' });

    deferredTurns[0]?.reject(new Error('provider failed once'));
    const failedWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const failedResult = requireDefined(failedWait.results[0], 'expected failed wait result');
    assert.strictEqual(failedResult.error, 'provider failed once');
    assert.strictEqual(failedResult.status, 'error');

    const retry = await service.sendInput({ message: 'Try again', target: spawn.id });
    assert.strictEqual(retry.error, undefined);
    assert.strictEqual(retry.status, 'in_progress');

    deferredTurns[1]?.resolve('retry succeeded');
    const successWait = await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    const successResult = requireDefined(successWait.results[0], 'expected successful retry result');
    assert.strictEqual(successResult.error, undefined);
    assert.strictEqual(successResult.output, 'retry succeeded');
    assert.strictEqual(successResult.status, 'completed');
  });

  void it('close_agent destroys its provider session and prevents a later resume', async () => {
    const { createSessionCalls, deferredTurns, disposedSessionIds, registry, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'reviewer',
      message: 'Review the worktree.',
      model: 'gpt-6-astra',
      projectRoot: '/repo/worktree',
    });
    deferredTurns[0]?.resolve('Findings.\n\nVERDICT: approve');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.closeAgent({ target: spawn.id });

    assert.deepStrictEqual(disposedSessionIds, ['backend-1']);
    assert.strictEqual(registry.get(spawn.id)?.backendSessionId, undefined);
    await assert.rejects(() => service.resumeAgent({ id: spawn.id }), /agent_not_resumable/u);
    assert.strictEqual(createSessionCalls.length, 1);

    registry.upsert({
      agentType: 'default',
      createdAt: 1,
      id: 'blank-session',
      lastActivityAt: 1,
      model: 'gpt',
      modelId: 'gpt-5.6-terra',
      projectRoot: '/repo/worktree',
      status: 'closed',
    });
    await assert.rejects(() => service.resumeAgent({ id: 'blank-session' }), /agent_not_resumable/u);
  });

  void it('resume_agent restores a persisted Grok conversation before constructing a session', async () => {
    const { createSessionCalls, registry, service } = createHarness();
    registry.upsert({
      agentType: 'reviewer',
      backendSessionId: 'unexpected-grok-session',
      createdAt: 1,
      id: 'grok-session',
      lastActivityAt: 1,
      model: 'xai',
      modelId: 'grok-4.5',
      projectRoot: '/repo/worktree',
      reasoningEffort: 'high',
      selectedSkillDigests: ['digest-using-superpowers'],
      selectedSkills: ['using-superpowers'],
      status: 'idle',
    });

    const resumed = await service.resumeAgent({ id: 'grok-session' });
    assert.strictEqual(resumed.status, 'idle');
    assert.strictEqual(createSessionCalls[0]?.sessionId, 'unexpected-grok-session');
  });

  void it('close_agent deletes a persisted provider session after host restart without requiring resume', async () => {
    const { createSessionCalls, disposedSessionIds, registry, service } = createHarness({
      resolveSuperpowersSkills: () => {
        throw new Error('current skill policy must not gate destructive cleanup');
      },
    });
    registry.upsert({
      agentType: 'ask',
      backendSessionId: 'persisted-grok-session',
      cleanupOutcome: 'succeeded',
      createdAt: 1,
      id: 'persisted-grok-agent',
      lastActivityAt: 1,
      model: 'xai',
      modelId: 'grok-4.5',
      projectRoot: '/repo/worktree',
      reasoningEffort: 'high',
      selectedSkillDigests: ['obsolete-skill-digest'],
      selectedSkills: ['obsolete-skill'],
      status: 'idle',
      terminalCause: 'host_shutdown',
      terminalOwner: 'runtime',
    });

    const closed = await service.closeAgent({ target: 'persisted-grok-agent' });

    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.cleanupOutcome, 'succeeded');
    assert.strictEqual(closed.terminalCause, 'closed');
    assert.strictEqual(closed.terminalOwner, 'parent');
    assert.strictEqual(createSessionCalls[0]?.sessionId, 'persisted-grok-session');
    assert.deepStrictEqual(createSessionCalls[0].context, []);
    assert.deepStrictEqual(disposedSessionIds, ['persisted-grok-session']);
    assert.strictEqual(registry.get('persisted-grok-agent')?.backendSessionId, undefined);
  });

  void it('host shutdown suspends a provider child for resume without deleting its session', async () => {
    const { createSessionCalls, deferredTurns, disposedSessionIds, registry, service, suspendedSessionIds } =
      createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'reviewer',
      message: 'Review the worktree.',
      model: 'gpt-5.6-terra',
      projectRoot: '/repo/worktree',
    });
    deferredTurns[0]?.resolve('VERDICT: approve');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.dispose();

    const resumed = await service.resumeAgent({ id: spawn.id });
    assert.strictEqual(resumed.modelId, 'gpt-5.6-terra');
    assert.strictEqual(resumed.reasoningEffort, 'xhigh');
    assert.strictEqual(resumed.status, 'idle');
    assert.strictEqual(createSessionCalls.at(-1)?.modelId, 'gpt-5.6-terra');
    assert.strictEqual(createSessionCalls.at(-1)?.reasoning, 'xhigh');
    assert.strictEqual(createSessionCalls.at(-1)?.sessionId, 'backend-1');
    assert.deepStrictEqual(disposedSessionIds, []);
    assert.deepStrictEqual(suspendedSessionIds, ['backend-1']);
    assert.strictEqual(registry.get(spawn.id)?.status, 'idle');
  });

  void it('host shutdown preserves a first-turn provider session for resume', async () => {
    const { createSessionCalls, registry, service, suspendedSessionIds } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'ask',
      message: 'Start a Grok conversation.',
      model: 'grok-4.5',
      projectRoot: '/repo/worktree',
    });

    await service.dispose();

    assert.strictEqual(registry.get(spawn.id)?.backendSessionId, 'backend-1');
    assert.deepStrictEqual(suspendedSessionIds, ['backend-1']);

    const resumed = await service.resumeAgent({ id: spawn.id });
    assert.strictEqual(resumed.status, 'idle');
    assert.strictEqual(createSessionCalls.at(-1)?.sessionId, 'backend-1');
  });

  void it('resume_agent fails closed when an approved Superpowers skill digest changes', async () => {
    let digest = 'digest-1';
    const { deferredTurns, service } = createHarness({
      resolveSuperpowersSkills: () => ({
        names: ['using-superpowers'],
        references: ['/skills/using-superpowers/SKILL.md'],
        skills: [{ digest, name: 'using-superpowers', reference: '/skills/using-superpowers/SKILL.md' }],
      }),
    });
    const spawn = await service.spawnAgent({
      agentType: 'reviewer',
      message: 'Review.',
      model: 'gpt-6-astra',
      projectRoot: '/repo/worktree',
    });
    deferredTurns[0]?.resolve('VERDICT: approve');
    await service.waitAgent({ targets: [spawn.id], timeoutMs: 100 });
    await service.dispose();
    digest = 'digest-2';

    await assert.rejects(() => service.resumeAgent({ id: spawn.id }), /agent_resume_policy_drift/u);
  });

  void it('close_agent reports cleanup failure and remains retryable until cleanup succeeds', async () => {
    const { disposedSessionIds, registry, service, telemetryEvents } = createHarness({ disposeFailures: 1 });
    const spawn = await service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });

    await assert.rejects(() => service.closeAgent({ target: spawn.id }), /agent_cleanup_failed/u);
    assert.strictEqual(registry.get(spawn.id)?.status, 'error');
    assert.deepStrictEqual(disposedSessionIds, []);
    const failedCloseEvent = requireDefined(
      telemetryEvents.find(event => event.eventType === 'close' && event.status === 'error'),
      'expected failed close telemetry',
    );
    assert.strictEqual(failedCloseEvent.cleanupOutcome, 'failed');
    assert.strictEqual(failedCloseEvent.terminalCause, 'cleanup_failed');
    assert.strictEqual(failedCloseEvent.terminalOwner, 'runtime');

    const closed = await service.closeAgent({ target: spawn.id });
    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.cleanupOutcome, 'succeeded');
    assert.strictEqual(closed.terminalCause, 'closed');
    assert.strictEqual(closed.terminalOwner, 'parent');
    assert.deepStrictEqual(disposedSessionIds, ['backend-1']);
  });

  void it('close_agent is idempotent and blocks future sends', async () => {
    const { disposedSessionIds, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });

    const closed = await service.closeAgent({ target: spawn.id });
    assert.strictEqual(closed.id, spawn.id);
    assert.strictEqual(closed.agentType, 'default');
    assert.strictEqual(closed.model, 'gpt');
    assert.strictEqual(closed.modelId, 'gpt-5.6-terra');
    assert.strictEqual(closed.reasoningEffort, 'xhigh');
    assert.strictEqual(closed.status, 'closed');
    assert.deepStrictEqual(await service.closeAgent({ target: spawn.id }), { id: spawn.id, status: 'closed' });
    assert.deepStrictEqual(disposedSessionIds, ['backend-1']);
    await assert.rejects(() => service.sendInput({ message: 'after close', target: spawn.id }), /agent_closed/u);
  });

  void it('close_agent keeps closed status when an in-flight turn resolves later', async () => {
    const { deferredTurns, disposedSessionIds, registry, service } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      message: 'Work for a while.',
      projectRoot: '/repo/worktree',
    });

    await service.closeAgent({ target: spawn.id });
    const turn = requireDefined(deferredTurns[0], 'expected in-flight turn');
    turn.resolve('late output after close');
    await new Promise(resolveLater => {
      setImmediate(resolveLater);
    });

    assert.deepStrictEqual(await service.waitAgent({ targets: [spawn.id], timeoutMs: 0 }), {
      results: [
        {
          agentType: 'default',
          attributionSource: 'provider-event',
          cleanupOutcome: 'succeeded',
          effectiveModelId: 'gpt-5.6-terra',
          effectiveProvider: 'gpt',
          effectiveReasoningEffort: 'xhigh',
          id: spawn.id,
          model: 'gpt',
          modelId: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          requestedModelId: 'gpt-5.6-terra',
          requestedReasoningEffort: 'xhigh',
          status: 'closed',
          terminalCause: 'closed',
          terminalOwner: 'parent',
        },
      ],
    });
    assert.strictEqual(registry.get(spawn.id)?.status, 'closed');
    assert.deepStrictEqual(disposedSessionIds, ['backend-1']);
  });

  void it('close_agent finalizes an active turn before provider teardown can reject it', async () => {
    const { registry, service, telemetryEvents } = createHarness({ suspendRejectsActiveTurn: true });
    const spawn = await service.spawnAgent({
      agentType: 'default',
      message: 'Work until closed.',
      projectRoot: '/repo/worktree',
    });

    const closed = await service.closeAgent({ target: spawn.id });
    await flushTurnDrain();

    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.terminalCause, 'closed');
    assert.strictEqual(closed.terminalOwner, 'parent');
    assert.strictEqual(registry.get(spawn.id)?.status, 'closed');
    assert.strictEqual(
      telemetryEvents.some(event => event.eventType === 'turn_failed'),
      false,
    );
  });

  void it('close_agent still disposes an active child when closing-state persistence fails', async () => {
    const { disposedSessionIds, failNextRegistryUpserts, service, telemetryEvents } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      message: 'Work until closed.',
      projectRoot: '/repo/worktree',
    });
    failNextRegistryUpserts();

    const closed = await service.closeAgent({ target: spawn.id });

    assert.strictEqual(closed.status, 'closed');
    assert.deepStrictEqual(disposedSessionIds, ['backend-1']);
    assert.strictEqual(
      telemetryEvents.some(event => event.errorMessage === 'agent_registry_persist_failed'),
      true,
    );
  });

  void it('dispose persists a resumable host-suspended child when an in-flight turn settles after shutdown', async () => {
    const { deferredTurns, disposedSessionIds, registry, service, suspendedSessionIds } = createHarness();
    const spawn = await service.spawnAgent({
      agentType: 'default',
      message: 'Keep working until shutdown.',
      projectRoot: '/repo/worktree',
    });

    await service.dispose();
    const turn = requireDefined(deferredTurns[0], 'expected in-flight turn');
    turn.resolve('late output after dispose');
    await new Promise(resolveLater => {
      setImmediate(resolveLater);
    });

    assert.deepStrictEqual(await service.waitAgent({ targets: [spawn.id], timeoutMs: 0 }), {
      results: [
        {
          agentType: 'default',
          attributionSource: 'provider-event',
          cleanupOutcome: 'succeeded',
          effectiveModelId: 'gpt-5.6-terra',
          effectiveProvider: 'gpt',
          effectiveReasoningEffort: 'xhigh',
          id: spawn.id,
          model: 'gpt',
          modelId: 'gpt-5.6-terra',
          reasoningEffort: 'xhigh',
          requestedModelId: 'gpt-5.6-terra',
          requestedReasoningEffort: 'xhigh',
          status: 'idle',
          terminalCause: 'host_shutdown',
          terminalOwner: 'runtime',
        },
      ],
    });
    assert.strictEqual(registry.get(spawn.id)?.status, 'idle');
    assert.deepStrictEqual(disposedSessionIds, []);
    assert.deepStrictEqual(suspendedSessionIds, ['backend-1']);
  });

  void it('dispose finalizes active turns before provider suspension can reject them', async () => {
    const { registry, service, telemetryEvents } = createHarness({ disposeRejectsActiveTurn: true });
    const spawn = await service.spawnAgent({
      agentType: 'default',
      message: 'Work until shutdown.',
      projectRoot: '/repo/worktree',
    });

    await service.dispose();
    await flushTurnDrain();

    assert.strictEqual(registry.get(spawn.id)?.status, 'idle');
    assert.strictEqual(
      telemetryEvents.some(event => event.eventType === 'turn_failed'),
      false,
    );
  });

  void it('dispose still suspends active children when closing-state persistence fails', async () => {
    const { failNextRegistryUpserts, service, suspendedSessionIds, telemetryEvents } = createHarness();
    await service.spawnAgent({
      agentType: 'default',
      message: 'Work until shutdown.',
      projectRoot: '/repo/worktree',
    });
    failNextRegistryUpserts();

    await service.dispose();

    assert.deepStrictEqual(suspendedSessionIds, ['backend-1']);
    assert.strictEqual(
      telemetryEvents.some(event => event.errorMessage === 'agent_registry_persist_failed'),
      true,
    );
  });

  void it('dispose awaits every child when one suspension record persistence fails', async () => {
    const { deferredSuspends, failRegistryUpsertAfter, service, suspendedSessionIds } = createHarness({
      deferSuspends: true,
    });
    await service.spawnAgent({ agentType: 'default', projectRoot: '/repo/worktree' });
    await service.spawnAgent({ agentType: 'default', projectRoot: '/repo/worktree' });
    failRegistryUpsertAfter(2);

    let settled = false;
    const disposal = service.dispose().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    void disposal.finally(() => {
      settled = true;
    });
    assert.strictEqual(deferredSuspends.length, 2);

    deferredSuspends[0]?.resolve(undefined);
    await flushTurnDrain();
    const settledBeforeSibling = settled;
    deferredSuspends[1]?.resolve(undefined);
    const outcome = await disposal;

    assert.strictEqual(settledBeforeSibling, false);
    assert.deepStrictEqual(suspendedSessionIds, ['backend-1', 'backend-2']);
    assert.match(outcome.error instanceof Error ? outcome.error.message : '', /agent_registry_persist_failed/u);
  });

  void it('dispose reports a suspension failure without persisting or emitting a successful shutdown', async () => {
    const { registry, service, telemetryEvents } = createHarness({ suspendFailures: 1 });
    const spawn = await service.spawnAgent({
      agentType: 'default',
      projectRoot: '/repo/worktree',
    });

    await assert.rejects(() => service.dispose(), /agent_cleanup_failed/u);

    assert.strictEqual(registry.get(spawn.id)?.status, 'error');
    assert.strictEqual(
      telemetryEvents.some(
        event => event.eventType === 'dispose' && event.agentId === spawn.id && event.status === 'ok',
      ),
      false,
    );
    assert.strictEqual(
      telemetryEvents.some(
        event => event.eventType === 'dispose' && event.agentId === spawn.id && event.status === 'error',
      ),
      true,
    );
  });
});
