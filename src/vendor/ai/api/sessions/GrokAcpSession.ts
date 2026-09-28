import { type ChildProcess, execFile, spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { basename, isAbsolute } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';

import type {
  AgentSessionCapabilities,
  AgentSessionProcessOutcome,
  AgentSessionStructuredOutputSummary,
} from '../types.js';
import type { AgentSession, InternalAgentSessionOptions } from './types.js';

import { AGENT_MODEL_XAI, GROK_CLI_COMMAND } from '../../shared/agentConstants.js';
import { MODEL_TRANSPORTS, resolveModelReasoningEffort } from '../../shared/modelPolicy.js';
import { resolveBinaryPath } from '../../shared/resolveBinary.js';
import { AcpOpaqueProtocolError, createOpaqueAcpStream } from './acpOpaqueStream.js';
import { terminateProcessWithGrace } from './processTermination.js';
import { createChildProcessOutcomeTracker, estimateTokens, sessionHelpers } from './types.js';

const EXPECTED_MODEL_ID = 'grok-4.5';
const EXPECTED_REASONING_EFFORT = 'high';
const CACHED_TOKEN_AUTH_METHOD = 'cached_token';
const DEFAULT_MAX_OUTPUT_BYTES = 16_000_000;
const MAX_PROVIDER_ERROR_MESSAGE_BYTES = 65_536;
const MAX_PROMPT_BYTES = 2_000_000;
const MAX_SKILL_REFERENCES = 8;
const MAX_SKILL_REFERENCE_BYTES = 4_096;
const GROK_DENIED_MCP_RULES = ['MCPTool(ai-subagent__*)'] as const;

export interface GrokAcpSessionDependencies {
  command?: string;
  deleteSession?: (request: AcpSessionDeleteRequest) => Promise<void>;
  maxOutputBytes?: number;
  spawnAgent?: (request: AcpProcessRequest) => ChildProcess;
}

interface AcpProcessRequest {
  args: string[];
  command: string;
  options: SpawnOptions;
}

interface AcpSessionDeleteRequest {
  args: string[];
  command: string;
  options: SpawnOptions;
}

interface ActiveTurn {
  cancelRequested: boolean;
  context?: acp.ClientContext;
  process: ChildProcess;
  sessionId?: string;
}

interface ConnectedChildProcess extends ChildProcess {
  stderr: Readable;
  stdin: Writable;
  stdout: Readable;
}

interface ConnectionErrorContext {
  cancelled: boolean;
  phase: ConnectionPhase;
}

interface ConnectionExecution<T> {
  cancelled: boolean;
  error?: Error;
  result?: T;
}

interface ConnectionOptions {
  initialPhase: ConnectionPhase;
  reportOutcome: boolean;
  turn?: {
    observation: ProtocolObservation;
    onSessionUpdate: (notification: acp.SessionNotification) => void;
  };
}

type ConnectionPhase = 'authenticate' | 'initialize' | 'prompt';

interface ConnectionRequest<T> {
  operation: (context: acp.ClientContext, initialize: acp.InitializeResponse) => Promise<T>;
  options: ConnectionOptions;
}

interface OutcomeReport {
  processOutcome: ReturnType<typeof createChildProcessOutcomeTracker>;
  terminal: Awaited<ReturnType<typeof processClose>>;
  turn: ConnectionOptions['turn'];
}

interface ProtocolObservation {
  lastEventKind?: AgentSessionStructuredOutputSummary['lastEventKind'];
  state: AgentSessionStructuredOutputSummary['state'];
  terminalEventSeen: boolean;
  turnUsageReported: boolean;
  validEventCount: number;
}

interface SessionConnection {
  configOptions: acp.SessionConfigOption[] | null | undefined;
  sessionId: string;
}

class GrokAcpError extends Error {
  constructor(
    readonly code: string,
    readonly terminalStatus?: string,
  ) {
    super(code);
    this.name = 'GrokAcpError';
  }
}

/** Grok's native ACP session adapter. */
export class GrokAcpSession extends EventEmitter implements AgentSession {
  process?: ChildProcess;

  private activeSend: Promise<string> | undefined;
  private activeSessionId: string | undefined;
  private activeTurn: ActiveTurn | undefined;
  private readonly command: string | undefined;
  private readonly deleteSession: (request: AcpSessionDeleteRequest) => Promise<void>;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly logPath: null | string;
  private readonly maxOutputBytes: number;

  private readonly spawnAgent: (request: AcpProcessRequest) => ChildProcess;

  constructor(
    private readonly options: InternalAgentSessionOptions,
    dependencies: GrokAcpSessionDependencies = {},
  ) {
    super();
    this.assertLaunchContract();
    assertSuperpowersSkillReferences(this.options.superpowersSkillReferences);
    this.activeSessionId = options.sessionId;
    this.logPath = sessionHelpers.prepareTranscriptPath(options);
    this.maxOutputBytes = dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.command = dependencies.command;
    this.deleteSession = dependencies.deleteSession ?? deleteGrokSession;
    this.spawnAgent =
      dependencies.spawnAgent ??
      (request =>
        spawn(request.command, request.args, {
          ...request.options,
          shell: false,
        }));
    this.writeLog('[session] initialized Grok ACP session');
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.disposed = true;
    const operation = this.disposeSession();
    this.disposePromise = operation;
    void operation.catch(() => {
      if (this.disposePromise === operation) {
        this.disposePromise = undefined;
      }
    });
    return operation;
  }

  getCapabilities(): AgentSessionCapabilities {
    const transport = MODEL_TRANSPORTS['grok-build'];
    return {
      fork: transport.fork,
      interrupt: transport.interrupt,
      queue: transport.queue,
      resume: transport.resume,
    };
  }

  getSessionId(): string | undefined {
    return this.activeSessionId;
  }

  async interrupt(): Promise<void> {
    const activeTurn = this.activeTurn;
    if (activeTurn === undefined) {
      return;
    }
    activeTurn.cancelRequested = true;
    if (activeTurn.context !== undefined && activeTurn.sessionId !== undefined) {
      try {
        await activeTurn.context.notify(acp.methods.agent.session.cancel, {
          sessionId: activeTurn.sessionId,
        });
      } catch {
        // Local termination remains the deterministic cancellation fallback.
      }
      const stdin = activeTurn.process.stdin;
      if (stdin !== null && !stdin.destroyed) {
        await new Promise<void>(resolveFlush => {
          stdin.end(resolveFlush);
        });
      }
      await new Promise<void>(resolveImmediate => {
        setImmediate(resolveImmediate);
      });
    }
    await terminateProcessWithGrace(activeTurn.process);
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  onExit(listener: (code: null | number, signal: NodeJS.Signals | null) => void): void {
    this.on('exit', listener);
  }

  send(input: string): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error('Cannot send message: Grok ACP session already disposed.'));
    }
    if (this.activeSend !== undefined) {
      return Promise.reject(new Error('Cannot send message: Grok ACP turn already active.'));
    }

    const operation = Promise.resolve().then(() => this.sendTurn(input));
    this.activeSend = operation;
    void operation.then(
      () => {
        if (this.activeSend === operation) {
          this.activeSend = undefined;
        }
      },
      () => {
        if (this.activeSend === operation) {
          this.activeSend = undefined;
        }
      },
    );
    return operation;
  }

  async suspend(): Promise<void> {
    const activeSend = this.activeSend;
    await this.interrupt();
    await activeSend?.catch(() => undefined);
  }

  private assertExactConfiguration(configOptions: acp.SessionConfigOption[] | null | undefined): void {
    if (configOptions === undefined || configOptions === null) {
      return;
    }
    const modelConfig = findSelectConfig(configOptions, 'model');
    const effortConfig = findSelectConfig(configOptions, 'thought_level');
    if (
      (modelConfig !== undefined &&
        modelConfig.currentValue !== EXPECTED_MODEL_ID &&
        modelConfig.currentValue !== `${EXPECTED_MODEL_ID}-build`) ||
      (effortConfig !== undefined && effortConfig.currentValue !== EXPECTED_REASONING_EFFORT)
    ) {
      throw new GrokAcpError('grok_acp_attribution_mismatch');
    }
  }

  private assertLaunchContract(): void {
    this.assertRequestedSelection();
    this.assertRuntimeEnvironment();
    this.assertProjectRoot();
  }

  private assertProjectRoot(): void {
    try {
      if (!statSync(realpathSync(this.options.projectRoot)).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new Error('grok_project_root_required');
    }
  }

  private assertRequestedSelection(): void {
    if (this.options.agent !== AGENT_MODEL_XAI) {
      throw new Error('Grok ACP sessions require the xai agent family.');
    }
    const model = sessionHelpers.resolveModelSelection(this.options);
    if (model?.resolvedModelId !== EXPECTED_MODEL_ID || model.providerId !== AGENT_MODEL_XAI) {
      throw new Error(`Grok ACP sessions require model "${EXPECTED_MODEL_ID}".`);
    }
    if (resolveModelReasoningEffort(EXPECTED_MODEL_ID, this.options.reasoning) !== EXPECTED_REASONING_EFFORT) {
      throw new Error(`Grok ACP sessions require reasoning effort "${EXPECTED_REASONING_EFFORT}".`);
    }
  }

  private assertRuntimeEnvironment(): void {
    if (this.options.runtimeMode !== 'host-native') {
      throw new Error('grok_native_runtime_required');
    }
    if (this.options.envMode !== 'replace') {
      throw new Error('grok_isolation_required');
    }
    const env = sessionHelpers.buildProcessEnv(this.options);
    if (
      env.AI_SUBAGENT_NESTED_DELEGATION !== '0' ||
      env.AI_SUBAGENT_AGENT_ID?.trim().length === 0 ||
      env.AI_SUBAGENT_AGENT_ID === undefined
    ) {
      throw new Error('grok_native_runtime_required');
    }
    if (hasValue(env.XAI_API_KEY) || hasValue(env.OPENROUTER_API_KEY)) {
      throw new Error('grok_subscription_oauth_only');
    }
    if (isNonLocalExecutionEnvironment(process.env) || isNonLocalExecutionEnvironment(env)) {
      throw new Error('grok_trusted_local_unavailable');
    }
  }

  private async disposeSession(): Promise<void> {
    const activeSend = this.activeSend;
    await this.interrupt();
    await activeSend?.catch(() => undefined);
    const sessionId = this.activeSessionId;
    if (sessionId !== undefined) {
      const env = sessionHelpers.buildProcessEnv(this.options);
      const command = this.command ?? realpathSync(resolveBinaryPath(GROK_CLI_COMMAND, env));
      try {
        await this.deleteSession({
          args: ['--no-auto-update', 'sessions', 'delete', sessionId],
          command,
          options: {
            cwd: this.options.projectRoot,
            env,
            shell: false,
          },
        });
      } catch {
        throw new GrokAcpError('grok_session_cleanup_failed');
      }
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = undefined;
      }
      this.writeLog('[grok] native ACP session deleted');
    }
    this.emit('exit', 0, null);
  }

  private async executeConnection<T>(
    child: ConnectedChildProcess,
    request: ConnectionRequest<T>,
  ): Promise<ConnectionExecution<T>> {
    let phase = request.options.initialPhase;
    const client = acp.client({ name: 'ai-subagent' });
    client.onRequest(acp.methods.client.session.requestPermission, context => {
      const activeSessionId = this.activeTurn?.sessionId;
      if (activeSessionId === undefined || context.params.sessionId !== activeSessionId) {
        return { outcome: { outcome: 'cancelled' } };
      }
      const allowOnce = context.params.options.find(option => option.kind === 'allow_once');
      if (allowOnce === undefined) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return {
        outcome: {
          optionId: allowOnce.optionId,
          outcome: 'selected',
        },
      };
    });
    const turn = request.options.turn;
    if (turn !== undefined) {
      client.onNotification(acp.methods.client.session.update, context => {
        turn.onSessionUpdate(context.params);
      });
    }
    const stream = createOpaqueAcpStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const launchError = new Promise<never>((_resolve, reject) => {
      child.once('error', () => {
        reject(new GrokAcpError('grok_launch_failed'));
      });
    });
    try {
      const result = await Promise.race([
        client.connectWith(stream, async context => {
          phase = 'initialize';
          const initialize = await context.request(acp.methods.agent.initialize, {
            clientCapabilities: {},
            clientInfo: { name: 'ai-subagent', version: '1' },
            protocolVersion: acp.PROTOCOL_VERSION,
          });
          if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw new GrokAcpError('grok_acp_protocol_unsupported');
          }
          if (!initialize.authMethods?.some(method => method.id === CACHED_TOKEN_AUTH_METHOD)) {
            throw new GrokAcpError('grok_authentication_failed');
          }
          phase = 'authenticate';
          await context.request(acp.methods.agent.authenticate, {
            methodId: CACHED_TOKEN_AUTH_METHOD,
          });
          phase = request.options.initialPhase;
          return request.operation(context, initialize);
        }),
        launchError,
      ]);
      return { cancelled: false, result };
    } catch (error) {
      const cancelled = this.activeTurn?.cancelRequested ?? false;
      return {
        cancelled,
        error: mapConnectionError(error, { cancelled, phase }),
      };
    } finally {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    }
  }

  private async launchConnectionProcess(
    processOutcome: ReturnType<typeof createChildProcessOutcomeTracker>,
  ): Promise<ConnectedChildProcess> {
    const env = sessionHelpers.buildProcessEnv(this.options);
    const command = this.command ?? realpathSync(resolveBinaryPath(GROK_CLI_COMMAND, env));
    let child: ChildProcess;
    try {
      child = this.spawnAgent({
        args: [
          '--no-auto-update',
          '--cwd',
          this.options.projectRoot,
          '--model',
          EXPECTED_MODEL_ID,
          '--oauth',
          '--reasoning-effort',
          EXPECTED_REASONING_EFFORT,
          '--no-subagents',
          '--no-memory',
          '--always-approve',
          ...GROK_DENIED_MCP_RULES.flatMap(rule => ['--deny', rule]),
          'agent',
          'stdio',
        ],
        command,
        options: {
          cwd: this.options.projectRoot,
          env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      });
    } catch {
      throw new GrokAcpError('grok_launch_failed');
    }
    if (!hasConnectedStreams(child)) {
      await terminateProcessWithGrace(child);
      throw new GrokAcpError('grok_launch_failed');
    }
    const recordActivity = (chunk: Buffer | string, source: 'stderr' | 'stdout'): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, 'utf8');
      processOutcome.recordActivity({ bytes, source });
      this.options.onActivity?.({ bytes, source });
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      recordActivity(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      recordActivity(chunk, 'stderr');
    });
    this.process = child;
    this.activeTurn = { cancelRequested: false, process: child };
    return child;
  }

  private async openSession(
    context: acp.ClientContext,
    initialize: acp.InitializeResponse,
  ): Promise<SessionConnection> {
    const sessionId = this.activeSessionId;
    if (sessionId === undefined) {
      const created = await context.request(acp.methods.agent.session.new, {
        cwd: this.options.projectRoot,
        mcpServers: [],
      });
      return {
        configOptions: created.configOptions,
        sessionId: created.sessionId,
      };
    }

    if (initialize.agentCapabilities?.sessionCapabilities?.resume !== undefined) {
      const resumed = await context.request(acp.methods.agent.session.resume, {
        cwd: this.options.projectRoot,
        mcpServers: [],
        sessionId,
      });
      return {
        configOptions: resumed.configOptions,
        sessionId,
      };
    }
    if (initialize.agentCapabilities?.loadSession === true) {
      const loaded = await context.request(acp.methods.agent.session.load, {
        cwd: this.options.projectRoot,
        mcpServers: [],
        sessionId,
      });
      return {
        configOptions: loaded.configOptions,
        sessionId,
      };
    }
    throw new GrokAcpError('grok_acp_resume_unsupported');
  }

  private reportConnectionOutcome(report: OutcomeReport): void {
    const observation = report.turn?.observation ?? {
      state: 'incomplete',
      terminalEventSeen: false,
      turnUsageReported: false,
      validEventCount: 0,
    };
    const structuredOutput: AgentSessionStructuredOutputSummary = {
      ...(observation.lastEventKind === undefined ? {} : { lastEventKind: observation.lastEventKind }),
      state: observation.state,
      terminalEventSeen: observation.terminalEventSeen,
      turnUsageReported: observation.turnUsageReported,
      validEventCount: observation.validEventCount,
    };
    this.options.onProcessOutcome?.({
      ...report.processOutcome.complete(report.terminal),
      structuredOutput,
    });
  }

  private sendTurn(input: string): Promise<string> {
    const prompt = buildPrompt(this.options.contextPrompt, input);
    const observation: ProtocolObservation = {
      state: 'incomplete',
      terminalEventSeen: false,
      turnUsageReported: false,
      validEventCount: 0,
    };
    let response = '';
    let responseBytes = 0;
    let outputLimitExceeded = false;
    let targetSessionId = this.activeSessionId;
    let turnUpdatesStarted = false;

    return this.withConnection(
      async (context, initialize) => {
        const session = await this.openSession(context, initialize);
        targetSessionId = session.sessionId;
        this.activeSessionId = session.sessionId;
        this.assertExactConfiguration(session.configOptions);
        if (this.activeTurn !== undefined) {
          this.activeTurn.context = context;
          this.activeTurn.sessionId = session.sessionId;
        }

        turnUpdatesStarted = true;
        const promptResult = await context.request(acp.methods.agent.session.prompt, {
          prompt: [{ text: prompt, type: 'text' }],
          sessionId: session.sessionId,
        });
        observation.validEventCount += 1;
        observation.lastEventKind = 'end';
        observation.terminalEventSeen = true;
        // ACP v1.3 usage is experimental and cumulative across the provider
        // session, so it cannot truthfully populate per-turn telemetry.
        observation.turnUsageReported = false;
        observation.state = promptResult.stopReason === 'end_turn' ? 'complete' : 'incomplete';

        if (promptResult.stopReason !== 'end_turn') {
          throw new GrokAcpError('grok_acp_protocol_incomplete');
        }
        if (outputLimitExceeded) {
          throw new GrokAcpError('grok_output_limit_exceeded');
        }
        this.options.onTokenUsage?.({
          attributionSource: 'exact-launch-contract',
          effectiveModelId: EXPECTED_MODEL_ID,
          inputTokens: estimateTokens(prompt),
          model: AGENT_MODEL_XAI,
          outputTokens: estimateTokens(response),
          providerId: AGENT_MODEL_XAI,
          reasoningEffort: EXPECTED_REASONING_EFFORT,
          requestedModelId: EXPECTED_MODEL_ID,
          resolvedModelId: EXPECTED_MODEL_ID,
        });
        this.writeLog(`[grok] ACP terminal end; events=${String(observation.validEventCount)}`);
        return response;
      },
      {
        initialPhase: 'prompt',
        reportOutcome: true,
        turn: {
          observation,
          onSessionUpdate: notification => {
            if (!turnUpdatesStarted || notification.sessionId !== targetSessionId) {
              return;
            }
            observation.validEventCount += 1;
            observation.lastEventKind = classifyUpdate(notification.update);
            if (
              notification.update.sessionUpdate !== 'agent_message_chunk' ||
              notification.update.content.type !== 'text'
            ) {
              return;
            }
            const bytes = Buffer.byteLength(notification.update.content.text, 'utf8');
            if (responseBytes + bytes > this.maxOutputBytes) {
              outputLimitExceeded = true;
              return;
            }
            responseBytes += bytes;
            response += notification.update.content.text;
          },
        },
      },
    );
  }

  private async withConnection<T>(
    operation: (context: acp.ClientContext, initialize: acp.InitializeResponse) => Promise<T>,
    options: ConnectionOptions,
  ): Promise<T> {
    const processOutcome = createChildProcessOutcomeTracker();
    const child = await this.launchConnectionProcess(processOutcome);
    const closeResult = processClose(child);
    const execution = await this.executeConnection(child, { operation, options });
    const terminal = await closeResult;
    if (this.process === child) {
      delete this.process;
    }
    if (this.activeTurn?.process === child) {
      this.activeTurn = undefined;
    }
    if (options.reportOutcome) {
      this.reportConnectionOutcome({ processOutcome, terminal, turn: options.turn });
    }
    if (execution.error !== undefined) {
      throw execution.error;
    }
    if (terminal.exitCode !== 0 || terminal.signal !== null) {
      throw new GrokAcpError(execution.cancelled ? 'grok_cancelled' : 'grok_acp_process_failed');
    }
    return execution.result as T;
  }

  private writeLog(message: string): void {
    sessionHelpers.writeLogMessage({
      logger: this.options.logger,
      logPath: this.logPath,
      message,
      prefix: this.options.outputPrefix ?? AGENT_MODEL_XAI,
    });
  }
}

function assertSuperpowersSkillReferences(references: string[] | undefined): void {
  if (references === undefined) {
    return;
  }
  if (!Array.isArray(references) || references.length > MAX_SKILL_REFERENCES) {
    throw new GrokAcpError('grok_skill_reference_invalid');
  }
  for (const reference of references) {
    try {
      if (
        typeof reference !== 'string' ||
        Buffer.byteLength(reference, 'utf8') > MAX_SKILL_REFERENCE_BYTES ||
        !isAbsolute(reference) ||
        basename(reference) !== 'SKILL.md'
      ) {
        throw new Error('invalid skill reference');
      }
      const stat = lstatSync(reference);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('invalid skill reference');
      }
      const canonicalReference = realpathSync(reference);
      const canonicalStat = lstatSync(canonicalReference);
      if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) {
        throw new Error('invalid skill reference');
      }
    } catch {
      throw new GrokAcpError('grok_skill_reference_invalid');
    }
  }
}

function buildPrompt(contextPrompt: string, input: string): string {
  const prompt = `${contextPrompt}\n\n${input.trim()}`;
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new GrokAcpError('grok_prompt_too_large');
  }
  return prompt;
}

function classifyUpdate(update: acp.SessionUpdate): NonNullable<AgentSessionStructuredOutputSummary['lastEventKind']> {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return 'text';
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    return 'tool_use';
  }
  return 'other';
}

function deleteGrokSession(request: AcpSessionDeleteRequest): Promise<void> {
  return new Promise((resolveDelete, rejectDelete) => {
    try {
      execFile(request.command, request.args, request.options, error => {
        if (error === null) {
          resolveDelete();
        } else {
          rejectDelete(new GrokAcpError('grok_session_cleanup_failed'));
        }
      });
    } catch {
      rejectDelete(new GrokAcpError('grok_session_cleanup_failed'));
    }
  });
}

function findSelectConfig(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  category: 'model' | 'thought_level',
): (acp.SessionConfigOption & { type: 'select' }) | undefined {
  return configOptions?.find(
    (option): option is acp.SessionConfigOption & { type: 'select' } =>
      option.type === 'select' && option.category === category,
  );
}

function hasConnectedStreams(child: ChildProcess): child is ConnectedChildProcess {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function isNonLocalExecutionEnvironment(env: NodeJS.ProcessEnv): boolean {
  const executionEnvironment = env.AI_SUBAGENT_EXECUTION_ENV?.trim().toLowerCase();
  return (
    isTruthy(env.CI) ||
    isTruthy(env.GITHUB_ACTIONS) ||
    env.KUBERNETES_SERVICE_HOST !== undefined ||
    env.AWS_EXECUTION_ENV !== undefined ||
    executionEnvironment === 'ci' ||
    executionEnvironment === 'container' ||
    executionEnvironment === 'remote' ||
    executionEnvironment === 'server'
  );
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.trim().toLowerCase() === 'true';
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapConnectionError(error: unknown, context: ConnectionErrorContext): Error {
  if (error instanceof GrokAcpError) {
    return error;
  }
  if (error instanceof AcpOpaqueProtocolError) {
    return new GrokAcpError('grok_acp_protocol_malformed');
  }
  if (context.cancelled) {
    return new GrokAcpError('grok_cancelled');
  }
  if (context.phase === 'authenticate') {
    return new GrokAcpError('grok_authentication_failed');
  }
  if (context.phase === 'prompt') {
    if (error instanceof acp.RequestError) {
      const status = providerHttpStatus(error);
      if (status === 401 || status === 403) {
        return new GrokAcpError('grok_authentication_failed', `http_${String(status)}`);
      }
      if (status === 402) {
        return new GrokAcpError('grok_usage_balance_exhausted', 'http_402');
      }
      if (status === 429) {
        return new GrokAcpError('grok_capacity_exhausted', 'http_429');
      }
      return new GrokAcpError('grok_acp_provider_failed', status === undefined ? undefined : `http_${String(status)}`);
    }
    return new GrokAcpError('grok_acp_protocol_incomplete');
  }
  return new GrokAcpError('grok_acp_protocol_incomplete');
}

function processClose(child: ChildProcess): Promise<Pick<AgentSessionProcessOutcome, 'exitCode' | 'signal'>> {
  return new Promise(resolveClose => {
    child.once('close', (exitCode, signal) => {
      resolveClose({ exitCode, signal });
    });
  });
}

function providerHttpStatus(error: acp.RequestError): number | undefined {
  const dataStatus = statusFromProviderValue(error.data);
  if (dataStatus !== undefined) {
    return dataStatus;
  }
  if (Buffer.byteLength(error.message, 'utf8') > MAX_PROVIDER_ERROR_MESSAGE_BYTES) {
    return undefined;
  }
  const statusMatch = /(?:http_status|status(?: code)?)\D{0,16}(401|402|403|429|5\d{2})/iu.exec(error.message);
  return statusMatch?.[1] === undefined ? undefined : Number(statusMatch[1]);
}

function statusFromProviderValue(value: unknown): number | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  for (const key of ['http_status', 'httpStatus', 'status', 'statusCode']) {
    const candidate = value[key];
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      (candidate === 401 ||
        candidate === 402 ||
        candidate === 403 ||
        candidate === 429 ||
        (candidate >= 500 && candidate <= 599))
    ) {
      return candidate;
    }
  }
  return undefined;
}
