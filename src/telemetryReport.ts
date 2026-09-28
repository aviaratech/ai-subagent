import { readLocalTelemetry } from './vendor/telemetry/index.js';

export interface SubagentTelemetryRecentEvent {
  createdAt: string;
  errorMessage?: string;
  eventType: string;
  inputSummary: Record<string, unknown>;
  parentSessionId: string;
  status: string;
  toolName?: string;
}

export interface SubagentTelemetryReportInput {
  limit?: number;
  lookbackDays?: number;
  now?: () => Date;
  rootDir?: string;
}

export interface SubagentTelemetryReportResult {
  lookbackDays: number;
  recentEvents: SubagentTelemetryRecentEvent[];
  sessions: SubagentTelemetrySessionSummary[];
  storageDiagnostics: SubagentTelemetryStorageDiagnostics;
}

export interface SubagentTelemetrySessionSummary {
  agents: number;
  budgetRejections: number;
  capabilitiesUsed: string[];
  capabilityInspectionStatuses: string[];
  capabilityMcpServers: string[];
  capabilityMissing: string[];
  capabilityPlugins: string[];
  capabilitySkills: string[];
  cleanupFailures: number;
  costUsd: number;
  failureProcessSources: string[];
  failureProtocolStates: string[];
  failures: number;
  lastSeen: string;
  maxDepth?: number;
  modelBreakdown?: string;
  outputBytes: number;
  parentSessionId: string;
  parentSessionSource?: string;
  preflightAuthModes: string[];
  preflightTransports: string[];
  project?: string;
  reasoningEfforts: string[];
  sendInputCount: number;
  serverRunId?: string;
  spawns: number;
  terminalCauses: string[];
  totalCachedInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningOutputTokens: number;
  totalTokens: number;
  transcriptRefReads: number;
  truncatedOutputs: number;
  turnCachedInputTokens: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  turnReasoningOutputTokens: number;
  turns: number;
  turnTokens: number;
  turnUsageAvailability: string[];
  verificationStatuses: string[];
}

export interface SubagentTelemetryStorageDiagnostics {
  malformedLineCount: number;
  oversizedLineCount: number;
  rejectedRecordCount: number;
}

interface MutableSessionSummary {
  agentIds: Set<string>;
  budgetRejections: number;
  capabilitiesUsed: Set<string>;
  capabilityInspectionStatuses: Set<string>;
  capabilityMcpServers: Set<string>;
  capabilityMissing: Set<string>;
  capabilityPlugins: Set<string>;
  capabilitySkills: Set<string>;
  cleanupFailures: number;
  costUsd: number;
  explicitSendInputCount: number;
  failureProcessSourceCounts: Map<string, number>;
  failureProtocolStateCounts: Map<string, number>;
  failures: number;
  lastSeen: string;
  maxDepth?: number;
  modelCounts: Map<string, number>;
  observedSendInputCount: number;
  outputBytes: number;
  parentSessionId: string;
  parentSessionSource?: string;
  preflightAuthModes: Set<string>;
  preflightTransports: Set<string>;
  project?: string;
  reasoningEfforts: Set<string>;
  serverRunId?: string;
  spawns: number;
  terminalCauseCounts: Map<string, number>;
  tokenTotalsByAgent: Map<string, TokenTotals>;
  truncatedOutputs: number;
  turns: number;
  turnTokenTotals: TurnTokenTotals;
  turnUsageAvailabilityCounts: Map<string, number>;
  verificationStatuses: Set<string>;
}

interface TokenTotals {
  totalCachedInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningOutputTokens: number;
  totalTokens: number;
}

interface TurnTokenTotals {
  turnCachedInputTokens: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  turnReasoningOutputTokens: number;
  turnTokens: number;
}

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_LIMIT = 20;

export function formatSubagentTelemetryReport(result: SubagentTelemetryReportResult): string {
  const lines = [`ai-subagent telemetry report (last ${String(result.lookbackDays)} days)`];

  if (result.sessions.length === 0) {
    lines.push('No ai-subagent telemetry events found.');
  } else {
    for (const session of result.sessions) {
      const source = session.parentSessionSource ?? 'unknown';
      const project = session.project ?? 'unknown';
      const depth = session.maxDepth === undefined ? 'unknown' : String(session.maxDepth);
      lines.push(
        [
          `- ${session.parentSessionId}`,
          `project=${project}`,
          `source=${source}`,
          session.serverRunId === undefined ? '' : `server=${session.serverRunId}`,
          `agents=${String(session.agents)}`,
          `spawns=${String(session.spawns)}`,
          `turns=${String(session.turns)}`,
          `failures=${String(session.failures)}`,
          `budgets=${String(session.budgetRejections)}`,
          `depth=${depth}`,
          `tokens=in:${String(session.totalInputTokens)} cached:${String(
            session.totalCachedInputTokens,
          )} out:${String(session.totalOutputTokens)} reasoning:${String(
            session.totalReasoningOutputTokens,
          )} total:${String(session.totalTokens)}`,
          `turn_tokens=in:${String(session.turnInputTokens)} cached:${String(
            session.turnCachedInputTokens,
          )} out:${String(session.turnOutputTokens)} reasoning:${String(
            session.turnReasoningOutputTokens,
          )} total:${String(session.turnTokens)}`,
          `turn_usage=${joinOrNone(session.turnUsageAvailability)}`,
          `output=${String(session.outputBytes)}B truncated=${String(session.truncatedOutputs)}`,
          `terminal=${joinOrNone(session.terminalCauses)} cleanup_failures=${String(session.cleanupFailures)}`,
          `failure_sources=${joinOrNone(session.failureProcessSources)}`,
          `failure_protocol=${joinOrNone(session.failureProtocolStates)}`,
          `preflight=auth:${joinOrNone(session.preflightAuthModes)} transports:${joinOrNone(
            session.preflightTransports,
          )}`,
          `capability_inspection=${joinOrNone(session.capabilityInspectionStatuses)} missing=${joinOrNone(
            session.capabilityMissing,
          )}`,
          `mcp=${joinOrNone(session.capabilityMcpServers)}`,
          `plugins=${joinOrNone(session.capabilityPlugins)}`,
          `skills=${joinOrNone(session.capabilitySkills)}`,
          `capabilities=${joinOrNone(session.capabilitiesUsed)}`,
          `verify=${joinOrNone(session.verificationStatuses)} cost_usd=${String(session.costUsd)}`,
          'transcript_ref_reads:0',
          session.modelBreakdown === undefined ? '' : `models=${session.modelBreakdown}`,
          session.reasoningEfforts.length > 0 ? `efforts=${session.reasoningEfforts.join('|')}` : '',
          `last=${session.lastSeen}`,
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }

  lines.push(
    `storage=malformed:${String(result.storageDiagnostics.malformedLineCount)} oversized:${String(
      result.storageDiagnostics.oversizedLineCount,
    )} rejected:${String(result.storageDiagnostics.rejectedRecordCount)}`,
  );

  if (result.recentEvents.length > 0) {
    lines.push('', 'Recent budget/failure events:');
    for (const event of result.recentEvents.slice(0, 5)) {
      const message = event.errorMessage === undefined ? '' : ` error=${event.errorMessage}`;
      lines.push(
        `- ${event.createdAt} ${event.parentSessionId}:${event.toolName ?? event.eventType} ${event.status}${message}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function querySubagentTelemetryReport(input: SubagentTelemetryReportInput = {}): SubagentTelemetryReportResult {
  const lookbackDays = positiveInteger(input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 'lookbackDays');
  const limit = positiveInteger(input.limit ?? DEFAULT_LIMIT, 'limit');
  const now = input.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('subagent_telemetry_invalid_clock: now() returned an invalid date.');
  }
  const cutoff = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const local = readLocalTelemetry({
    ...(input.now !== undefined ? { now: input.now } : {}),
    retentionDays: lookbackDays,
    ...(input.rootDir !== undefined ? { rootDir: input.rootDir } : {}),
  });
  const sessions = new Map<string, MutableSessionSummary>();
  const recentEvents: SubagentTelemetryRecentEvent[] = [];

  for (const record of local.records) {
    if (record.kind !== 'event' || Date.parse(record.recordedAt) < cutoff) {
      continue;
    }
    const event = asRecord(record.data);
    if (asString(event.plugin) !== 'ai-subagent') {
      continue;
    }
    const parentSessionId = asString(event.sessionId) ?? 'unknown';
    const eventType = asString(event.eventType) ?? 'unknown';
    const status = asString(event.status) ?? 'unknown';
    const toolName = asString(event.toolName);
    const errorMessage = asString(event.errorMessage);
    const summary = asRecord(event.inputSummary);
    const session = sessions.get(parentSessionId) ?? createMutableSession(parentSessionId, record.recordedAt);
    aggregateEvent({ eventType, recordedAt: record.recordedAt, session, summary, toolName });
    sessions.set(parentSessionId, session);

    if (status === 'error' || eventType === 'budget_rejected' || eventType === 'turn_failed') {
      recentEvents.push({
        createdAt: record.recordedAt,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        eventType,
        inputSummary: summary,
        parentSessionId,
        status,
        ...(toolName !== undefined ? { toolName } : {}),
      });
    }
  }

  return {
    lookbackDays,
    recentEvents: recentEvents.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit),
    sessions: [...sessions.values()].map(finalizeSession).sort(compareSessions).slice(0, limit),
    storageDiagnostics: {
      malformedLineCount: local.malformedLineCount,
      oversizedLineCount: local.oversizedLineCount,
      rejectedRecordCount: local.rejectedRecordCount,
    },
  };
}

export function runSubagentTelemetryReportCli(argv: readonly string[]): Promise<void> {
  const options = parseReportArgs(argv);
  const report = querySubagentTelemetryReport(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatSubagentTelemetryReport(report));
  return Promise.resolve();
}

function addStrings(target: Set<string>, value: unknown): void {
  for (const item of asStringList(value)) {
    target.add(item);
  }
}

function addTurnTokenTotals(totals: TurnTokenTotals, summary: Record<string, unknown>): void {
  totals.turnCachedInputTokens += asNumber(summary.turnCachedInputTokens) ?? 0;
  totals.turnInputTokens += asNumber(summary.turnInputTokens) ?? 0;
  totals.turnOutputTokens += asNumber(summary.turnOutputTokens) ?? 0;
  totals.turnReasoningOutputTokens += asNumber(summary.turnReasoningOutputTokens) ?? 0;
  totals.turnTokens += asNumber(summary.turnTokens) ?? 0;
}

function aggregateEvent(input: {
  eventType: string;
  recordedAt: string;
  session: MutableSessionSummary;
  summary: Record<string, unknown>;
  toolName: string | undefined;
}): void {
  const { eventType, recordedAt, session, summary, toolName } = input;
  session.lastSeen = recordedAt > session.lastSeen ? recordedAt : session.lastSeen;
  const agentId = asString(summary.agentId);
  if (agentId !== undefined) {
    session.agentIds.add(agentId);
    if (hasTokenTotals(summary)) {
      session.tokenTotalsByAgent.set(agentId, tokenTotals(summary));
    }
  }
  assignSessionIdentity(session, summary);
  const maxDepth = maxDefined(session.maxDepth, asNumber(summary.depth), asNumber(summary.childDepth));
  if (maxDepth !== undefined) {
    session.maxDepth = maxDepth;
  }
  addStrings(session.capabilitiesUsed, summary.capabilitiesUsed);
  addStrings(session.capabilityInspectionStatuses, summary.capabilityInspectionStatus);
  addStrings(session.capabilityMcpServers, summary.capabilityMcpServers);
  addStrings(session.capabilityMissing, summary.capabilityMissing);
  addStrings(session.capabilityPlugins, summary.capabilityPlugins);
  addStrings(session.capabilitySkills, summary.capabilitySkills);
  addStrings(session.preflightAuthModes, summary.preflightAuthMode);
  addStrings(session.preflightTransports, summary.preflightTransport);
  addStrings(session.verificationStatuses, summary.verificationStatus);
  addStrings(session.reasoningEfforts, summary.effectiveReasoningEffort ?? summary.reasoningEffort);
  session.explicitSendInputCount += asNumber(summary.sendInputCount) ?? 0;
  session.costUsd += asFloat(summary.costUsd) ?? 0;
  session.cleanupFailures += summary.cleanupOutcome === 'failed' ? 1 : 0;
  const terminalOwner = asString(summary.terminalOwner);
  const terminalCause = asString(summary.terminalCause);
  if (terminalOwner !== undefined && terminalCause !== undefined) {
    const key = `${terminalOwner}/${terminalCause}`;
    session.terminalCauseCounts.set(key, (session.terminalCauseCounts.get(key) ?? 0) + 1);
  }

  if (eventType === 'spawn') {
    session.spawns += 1;
    const provider =
      asString(summary.effectiveProvider) ?? asString(summary.provider) ?? asString(summary.model) ?? 'unknown';
    const modelId = asString(summary.effectiveModelId) ?? asString(summary.modelId) ?? 'unknown';
    const key = `${provider}/${modelId}`;
    session.modelCounts.set(key, (session.modelCounts.get(key) ?? 0) + 1);
  }
  if (eventType === 'turn_completed' || eventType === 'turn_failed') {
    session.turns += 1;
    addTurnTokenTotals(session.turnTokenTotals, summary);
    let turnUsageAvailability = 'unknown';
    if (summary.turnUsageReported === true) {
      turnUsageAvailability = 'reported';
    } else if (summary.turnUsageReported === false) {
      turnUsageAvailability = 'unreported';
    }
    incrementCount(session.turnUsageAvailabilityCounts, turnUsageAvailability);
  }
  if (eventType === 'turn_failed') {
    session.failures += 1;
    incrementCount(session.failureProcessSourceCounts, failureProcessSource(summary));
    incrementCount(session.failureProtocolStateCounts, failureProtocolState(summary));
  }
  if (eventType === 'budget_rejected') {
    session.budgetRejections += 1;
  }
  if (toolName === 'send_input' || asString(summary.operation) === 'send_input') {
    session.observedSendInputCount += 1;
  }
  if (eventType === 'turn_completed') {
    const outputBytes = asNumber(summary.outputBytes) ?? 0;
    session.outputBytes += outputBytes;
    session.truncatedOutputs += summary.outputTruncated === true ? 1 : 0;
  }
}

function asFloat(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = asFloat(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assignSessionIdentity(session: MutableSessionSummary, summary: Record<string, unknown>): void {
  const parentSessionSource = asString(summary.parentSessionIdSource);
  if (session.parentSessionSource === undefined && parentSessionSource !== undefined) {
    session.parentSessionSource = parentSessionSource;
  }
  const project = asString(summary.project);
  if (session.project === undefined && project !== undefined) {
    session.project = project;
  }
  const serverRunId = asString(summary.serverRunId);
  if (session.serverRunId === undefined && serverRunId !== undefined) {
    session.serverRunId = serverRunId;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  const raw = asString(value);
  return raw === undefined
    ? []
    : raw
        .split(/[,|]/u)
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function compareSessions(left: SubagentTelemetrySessionSummary, right: SubagentTelemetrySessionSummary): number {
  return (
    right.budgetRejections - left.budgetRejections ||
    right.failures - left.failures ||
    right.totalTokens - left.totalTokens ||
    right.lastSeen.localeCompare(left.lastSeen)
  );
}

function createMutableSession(parentSessionId: string, recordedAt: string): MutableSessionSummary {
  return {
    agentIds: new Set<string>(),
    budgetRejections: 0,
    capabilitiesUsed: new Set<string>(),
    capabilityInspectionStatuses: new Set<string>(),
    capabilityMcpServers: new Set<string>(),
    capabilityMissing: new Set<string>(),
    capabilityPlugins: new Set<string>(),
    capabilitySkills: new Set<string>(),
    cleanupFailures: 0,
    costUsd: 0,
    explicitSendInputCount: 0,
    failureProcessSourceCounts: new Map<string, number>(),
    failureProtocolStateCounts: new Map<string, number>(),
    failures: 0,
    lastSeen: recordedAt,
    modelCounts: new Map<string, number>(),
    observedSendInputCount: 0,
    outputBytes: 0,
    parentSessionId,
    preflightAuthModes: new Set<string>(),
    preflightTransports: new Set<string>(),
    reasoningEfforts: new Set<string>(),
    spawns: 0,
    terminalCauseCounts: new Map<string, number>(),
    tokenTotalsByAgent: new Map<string, TokenTotals>(),
    truncatedOutputs: 0,
    turns: 0,
    turnTokenTotals: turnTokenTotals({}),
    turnUsageAvailabilityCounts: new Map<string, number>(),
    verificationStatuses: new Set<string>(),
  };
}

function failureProcessSource(summary: Record<string, unknown>): 'mixed' | 'none' | 'stderr' | 'stdout' | 'unknown' {
  const stderrBytes = asNumber(summary.processStderrBytes);
  const stdoutBytes = asNumber(summary.processStdoutBytes);
  if (stderrBytes === undefined && stdoutBytes === undefined) {
    return 'unknown';
  }
  const hasStderr = (stderrBytes ?? 0) > 0;
  const hasStdout = (stdoutBytes ?? 0) > 0;
  if (hasStderr && hasStdout) {
    return 'mixed';
  }
  if (hasStderr) {
    return 'stderr';
  }
  if (hasStdout) {
    return 'stdout';
  }
  return 'none';
}

function failureProtocolState(
  summary: Record<string, unknown>,
): 'complete' | 'incomplete' | 'malformed' | 'none' | 'unknown' {
  const state = asString(asRecord(summary.structuredOutput).state);
  if (state === 'complete' || state === 'incomplete' || state === 'malformed' || state === 'none') {
    return state;
  }
  return 'unknown';
}

function finalizeSession(session: MutableSessionSummary): SubagentTelemetrySessionSummary {
  const totals = [...session.tokenTotalsByAgent.values()].reduce<TokenTotals>(
    (result, current) => ({
      totalCachedInputTokens: result.totalCachedInputTokens + current.totalCachedInputTokens,
      totalInputTokens: result.totalInputTokens + current.totalInputTokens,
      totalOutputTokens: result.totalOutputTokens + current.totalOutputTokens,
      totalReasoningOutputTokens: result.totalReasoningOutputTokens + current.totalReasoningOutputTokens,
      totalTokens: result.totalTokens + current.totalTokens,
    }),
    tokenTotals({}),
  );
  const modelBreakdown = [...session.modelCounts.entries()]
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
    .map(([key, count]) => `${key}=${String(count)}`)
    .join(', ');
  return {
    agents: session.agentIds.size,
    budgetRejections: session.budgetRejections,
    capabilitiesUsed: sorted(session.capabilitiesUsed),
    capabilityInspectionStatuses: sorted(session.capabilityInspectionStatuses),
    capabilityMcpServers: sorted(session.capabilityMcpServers),
    capabilityMissing: sorted(session.capabilityMissing),
    capabilityPlugins: sorted(session.capabilityPlugins),
    capabilitySkills: sorted(session.capabilitySkills),
    cleanupFailures: session.cleanupFailures,
    costUsd: session.costUsd,
    failureProcessSources: formatCounts(session.failureProcessSourceCounts),
    failureProtocolStates: formatCounts(session.failureProtocolStateCounts),
    failures: session.failures,
    lastSeen: session.lastSeen,
    ...(session.maxDepth !== undefined ? { maxDepth: session.maxDepth } : {}),
    ...(modelBreakdown.length > 0 ? { modelBreakdown } : {}),
    outputBytes: session.outputBytes,
    parentSessionId: session.parentSessionId,
    ...(session.parentSessionSource !== undefined ? { parentSessionSource: session.parentSessionSource } : {}),
    preflightAuthModes: sorted(session.preflightAuthModes),
    preflightTransports: sorted(session.preflightTransports),
    ...(session.project !== undefined ? { project: session.project } : {}),
    reasoningEfforts: sorted(session.reasoningEfforts),
    sendInputCount: Math.max(session.explicitSendInputCount, session.observedSendInputCount),
    ...(session.serverRunId !== undefined ? { serverRunId: session.serverRunId } : {}),
    spawns: session.spawns,
    terminalCauses: [...session.terminalCauseCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `${key}=${String(count)}`),
    ...session.turnTokenTotals,
    turnUsageAvailability: formatCounts(session.turnUsageAvailabilityCounts),
    ...totals,
    transcriptRefReads: 0,
    truncatedOutputs: session.truncatedOutputs,
    turns: session.turns,
    verificationStatuses: sorted(session.verificationStatuses),
  };
}

function formatCounts(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${String(count)}`);
}

function hasTokenTotals(summary: Record<string, unknown>): boolean {
  return [
    summary.totalCachedInputTokens,
    summary.totalInputTokens,
    summary.totalOutputTokens,
    summary.totalReasoningOutputTokens,
    summary.totalTokens,
  ].some(value => asNumber(value) !== undefined);
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join('|') : 'none';
}

function maxDefined(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseReportArgs(argv: readonly string[]): SubagentTelemetryReportInput & { json: boolean } {
  let json = false;
  let limit = DEFAULT_LIMIT;
  let lookbackDays = DEFAULT_LOOKBACK_DAYS;
  let rootDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--limit') {
      limit = parsePositiveInt(argv[i + 1], DEFAULT_LIMIT);
      i += 1;
    } else if (arg === '--lookback-days') {
      lookbackDays = parsePositiveInt(argv[i + 1], DEFAULT_LOOKBACK_DAYS);
      i += 1;
    } else if (arg === '--root-dir') {
      rootDir = argv[i + 1];
      i += 1;
    }
  }

  return { json, limit, lookbackDays, ...(rootDir !== undefined ? { rootDir } : {}) };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`subagent_telemetry_invalid_option: ${name} must be a positive integer.`);
  }
  return value;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}

function tokenTotals(summary: Record<string, unknown>): TokenTotals {
  return {
    totalCachedInputTokens: asNumber(summary.totalCachedInputTokens) ?? 0,
    totalInputTokens: asNumber(summary.totalInputTokens) ?? 0,
    totalOutputTokens: asNumber(summary.totalOutputTokens) ?? 0,
    totalReasoningOutputTokens: asNumber(summary.totalReasoningOutputTokens) ?? 0,
    totalTokens: asNumber(summary.totalTokens) ?? 0,
  };
}

function turnTokenTotals(summary: Record<string, unknown>): TurnTokenTotals {
  return {
    turnCachedInputTokens: asNumber(summary.turnCachedInputTokens) ?? 0,
    turnInputTokens: asNumber(summary.turnInputTokens) ?? 0,
    turnOutputTokens: asNumber(summary.turnOutputTokens) ?? 0,
    turnReasoningOutputTokens: asNumber(summary.turnReasoningOutputTokens) ?? 0,
    turnTokens: asNumber(summary.turnTokens) ?? 0,
  };
}
