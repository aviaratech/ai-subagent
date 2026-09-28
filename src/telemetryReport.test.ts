import { createLocalJsonlTelemetrySink } from './vendor/telemetry/index.js';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  formatSubagentTelemetryReport,
  querySubagentTelemetryReport,
  type SubagentTelemetrySessionSummary,
} from './telemetryReport.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');

void describe('querySubagentTelemetryReport', () => {
  void it('groups bounded local events without reading opaque transcript references', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ai-subagent-report-'));
    try {
      const sink = createLocalJsonlTelemetrySink({ now: () => NOW, rootDir });
      await recordEvent({
        eventType: 'spawn',
        inputSummary: {
          agentId: 'agent-1',
          agentType: 'builder',
          childDepth: 1,
          depth: 0,
          model: 'xai',
          modelId: 'grok-4.5',
          parentSessionIdSource: 'env:CODEX_THREAD_ID',
          project: 'ai',
          reasoningEffort: 'high',
          serverRunId: 'server-run-1',
        },
        sink,
      });
      await recordEvent({
        eventType: 'preflight',
        inputSummary: {
          agentId: 'agent-1',
          capabilityInspectionStatus: 'ok',
          capabilityMcpServers: [
            'example-memory@plugin:example-memory',
            'github@configToml',
            'example-workflow@plugin:example-workflow',
          ],
          capabilityMissing: ['mcp:github'],
          capabilityPlugins: ['example-memory@user', 'github@user', 'example-workflow@user', 'superpowers@user'],
          capabilitySkills: [
            'memory-lifecycle@plugin:example-memory',
            'pr-handoff@plugin:example-workflow',
            'using-superpowers@plugin:superpowers',
          ],
          preflightAuthMode: 'host-subscription',
          preflightTransport: 'grok-build',
        },
        sink,
      });
      await recordEvent({
        eventType: 'turn_completed',
        inputSummary: {
          agentId: 'agent-1',
          capabilitiesUsed: ['spawn'],
          cleanupOutcome: 'not_required',
          outputBytes: 2_048,
          outputTruncated: true,
          terminalCause: 'completed',
          terminalOwner: 'provider',
          totalCachedInputTokens: 2,
          totalInputTokens: 5,
          totalOutputTokens: 7,
          totalReasoningOutputTokens: 3,
          totalTokens: 12,
          transcriptRef: '/opaque/evidence/agent-1.log',
          turnCachedInputTokens: 2,
          turnInputTokens: 5,
          turnOutputTokens: 7,
          turnReasoningOutputTokens: 3,
          turnTokens: 12,
          turnUsageReported: true,
          verificationStatus: 'passed',
        },
        sink,
      });
      await recordEvent({
        eventType: 'turn_failed',
        inputSummary: {
          agentId: 'agent-2',
          cleanupOutcome: 'not_required',
          processCompletionMs: 80,
          processExitCode: 1,
          processFirstActivityMs: 20,
          processLastActivityMs: 60,
          processReceivedBytes: 17,
          processSignal: null,
          processStderrBytes: 12,
          processStdoutBytes: 5,
          structuredOutput: {
            lastEventKind: 'tool_use',
            state: 'incomplete',
            terminalEventSeen: false,
            turnUsageReported: false,
            validEventCount: 3,
          },
          terminalCause: 'grok_terminal_failure',
          terminalOwner: 'provider',
          transcriptRef: '/opaque/evidence/agent-2.log',
          turnUsageReported: false,
        },
        sink,
        status: 'error',
      });
      await recordEvent({
        eventType: 'turn_failed',
        inputSummary: {
          agentId: 'agent-3',
          cleanupOutcome: 'not_required',
          processCompletionMs: 40,
          processExitCode: 1,
          processReceivedBytes: 9,
          processSignal: null,
          processStderrBytes: 9,
          processStdoutBytes: 0,
          structuredOutput: {
            lastEventKind: 'text',
            state: 'malformed',
            terminalEventSeen: false,
            turnUsageReported: false,
            validEventCount: 1,
          },
          terminalCause: 'malformed_output',
          terminalOwner: 'adapter',
          transcriptRef: '/opaque/evidence/agent-3.log',
          usageReported: true,
        },
        sink,
        status: 'error',
      });
      await recordEvent({
        errorMessage: 'budget_exceeded: max_lifecycle_calls',
        eventType: 'budget_rejected',
        inputSummary: { agentId: 'agent-1', limitName: 'max_lifecycle_calls' },
        sink,
        status: 'error',
      });
      await sink.close();

      const result = querySubagentTelemetryReport({ limit: 5, lookbackDays: 7, now: () => NOW, rootDir });
      assert.deepStrictEqual(result.storageDiagnostics, {
        malformedLineCount: 0,
        oversizedLineCount: 0,
        rejectedRecordCount: 0,
      });
      assert.equal(result.sessions.length, 1);
      const session = result.sessions.at(0);
      assert.ok(session);
      assert.equal(session.agents, 3);
      assert.equal(session.spawns, 1);
      assert.equal(session.turns, 3);
      assert.equal(session.budgetRejections, 1);
      assert.deepStrictEqual(session.capabilitiesUsed, ['spawn']);
      assert.deepStrictEqual(session.capabilityInspectionStatuses, ['ok']);
      assert.deepStrictEqual(session.capabilityMcpServers, [
        'example-memory@plugin:example-memory',
        'example-workflow@plugin:example-workflow',
        'github@configToml',
      ]);
      assert.deepStrictEqual(session.capabilityPlugins, [
        'example-memory@user',
        'example-workflow@user',
        'github@user',
        'superpowers@user',
      ]);
      assert.deepStrictEqual(session.capabilitySkills, [
        'memory-lifecycle@plugin:example-memory',
        'pr-handoff@plugin:example-workflow',
        'using-superpowers@plugin:superpowers',
      ]);
      assert.deepStrictEqual(session.capabilityMissing, ['mcp:github']);
      assert.equal(session.cleanupFailures, 0);
      assert.deepStrictEqual(session.terminalCauses, [
        'adapter/malformed_output=1',
        'provider/completed=1',
        'provider/grok_terminal_failure=1',
      ]);
      assert.deepStrictEqual(session.failureProcessSources, ['mixed=1', 'stderr=1']);
      assert.deepStrictEqual(session.failureProtocolStates, ['incomplete=1', 'malformed=1']);
      assert.deepStrictEqual(session.turnUsageAvailability, ['reported=1', 'unknown=1', 'unreported=1']);
      assert.equal(session.turnCachedInputTokens, 2);
      assert.equal(session.turnInputTokens, 5);
      assert.equal(session.turnOutputTokens, 7);
      assert.equal(session.turnReasoningOutputTokens, 3);
      assert.equal(session.turnTokens, 12);
      assert.equal(session.totalTokens, 12);
      assert.equal(session.transcriptRefReads, 0);
      assert.equal(session.modelBreakdown, 'xai/grok-4.5=1');
      assert.deepStrictEqual(session.preflightAuthModes, ['host-subscription']);
      assert.deepStrictEqual(session.preflightTransports, ['grok-build']);
      assert.deepStrictEqual(session.verificationStatuses, ['passed']);
      const recentEvent = result.recentEvents.find(event => event.eventType === 'budget_rejected');
      assert.ok(recentEvent);
      assert.equal(recentEvent.errorMessage, 'budget_exceeded: max_lifecycle_calls');
      const providerFailure = result.recentEvents.find(
        event => event.inputSummary.terminalCause === 'grok_terminal_failure',
      );
      assert.ok(providerFailure);
      assert.deepStrictEqual(
        {
          completionMs: providerFailure.inputSummary.processCompletionMs,
          exitCode: providerFailure.inputSummary.processExitCode,
          firstActivityMs: providerFailure.inputSummary.processFirstActivityMs,
          lastActivityMs: providerFailure.inputSummary.processLastActivityMs,
          receivedBytes: providerFailure.inputSummary.processReceivedBytes,
          signal: providerFailure.inputSummary.processSignal,
          stderrBytes: providerFailure.inputSummary.processStderrBytes,
          stdoutBytes: providerFailure.inputSummary.processStdoutBytes,
          structuredOutput: providerFailure.inputSummary.structuredOutput,
        },
        {
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
        },
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});

void describe('package telemetry report command', () => {
  void it('exposes a workspace-runnable telemetry-report script', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.equal(packageJson.scripts?.['telemetry-report'], 'node dist/cli.js telemetry-report');
  });
});

void describe('formatSubagentTelemetryReport', () => {
  void it('renders a compact local operator summary and storage diagnostics', () => {
    const output = formatSubagentTelemetryReport({
      lookbackDays: 7,
      recentEvents: [
        {
          createdAt: NOW.toISOString(),
          errorMessage: 'budget_exceeded: max_lifecycle_calls',
          eventType: 'budget_rejected',
          inputSummary: { agentId: 'agent-1', limitName: 'max_lifecycle_calls' },
          parentSessionId: 'parent-session-1',
          status: 'error',
          toolName: 'send_input',
        },
      ],
      sessions: [summaryFixture()],
      storageDiagnostics: { malformedLineCount: 1, oversizedLineCount: 2, rejectedRecordCount: 3 },
    });

    assert.match(output, /ai-subagent telemetry report \(last 7 days\)/u);
    assert.match(output, /parent-session-1 project=ai source=env:CODEX_THREAD_ID/u);
    assert.match(output, /tokens=in:5 cached:2 out:7 reasoning:3 total:12/u);
    assert.match(output, /turn_tokens=in:5 cached:2 out:7 reasoning:3 total:12/u);
    assert.match(output, /turn_usage=reported=1/u);
    assert.match(output, /failure_sources=mixed=1/u);
    assert.match(output, /failure_protocol=incomplete=1/u);
    assert.match(output, /terminal=provider\/completed=1/u);
    assert.match(output, /capability_inspection=ok missing=mcp:github/u);
    assert.match(
      output,
      /mcp=example-memory@plugin:example-memory\|github@configToml\|example-workflow@plugin:example-workflow/u,
    );
    assert.match(output, /plugins=example-memory@user\|github@user\|example-workflow@user\|superpowers@user/u);
    assert.match(
      output,
      /skills=memory-lifecycle@plugin:example-memory\|pr-handoff@plugin:example-workflow\|using-superpowers@plugin:superpowers/u,
    );
    assert.match(output, /transcript_ref_reads:0/u);
    assert.match(output, /storage=malformed:1 oversized:2 rejected:3/u);
    assert.match(output, /Recent budget\/failure events:/u);
  });
});

async function recordEvent(input: {
  errorMessage?: string;
  eventType: string;
  inputSummary: Record<string, unknown>;
  sink: ReturnType<typeof createLocalJsonlTelemetrySink>;
  status?: 'error' | 'ok';
}): Promise<void> {
  await input.sink.recordEvent({
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    eventType: input.eventType,
    inputSummary: input.inputSummary,
    plugin: 'ai-subagent',
    sessionId: 'parent-session-1',
    source: 'orchestrator',
    status: input.status ?? 'ok',
    toolName: input.eventType === 'budget_rejected' ? 'send_input' : input.eventType,
  });
}

function summaryFixture(): SubagentTelemetrySessionSummary {
  return {
    agents: 1,
    budgetRejections: 1,
    capabilitiesUsed: ['spawn'],
    capabilityInspectionStatuses: ['ok'],
    capabilityMcpServers: [
      'example-memory@plugin:example-memory',
      'github@configToml',
      'example-workflow@plugin:example-workflow',
    ],
    capabilityMissing: ['mcp:github'],
    capabilityPlugins: ['example-memory@user', 'github@user', 'example-workflow@user', 'superpowers@user'],
    capabilitySkills: [
      'memory-lifecycle@plugin:example-memory',
      'pr-handoff@plugin:example-workflow',
      'using-superpowers@plugin:superpowers',
    ],
    cleanupFailures: 0,
    costUsd: 0,
    failureProcessSources: ['mixed=1'],
    failureProtocolStates: ['incomplete=1'],
    failures: 0,
    lastSeen: NOW.toISOString(),
    maxDepth: 1,
    modelBreakdown: 'xai/grok-4.5=1',
    outputBytes: 2_048,
    parentSessionId: 'parent-session-1',
    parentSessionSource: 'env:CODEX_THREAD_ID',
    preflightAuthModes: ['host-subscription'],
    preflightTransports: ['grok-build'],
    project: 'ai',
    reasoningEfforts: ['high'],
    sendInputCount: 0,
    serverRunId: 'server-run-1',
    spawns: 1,
    terminalCauses: ['provider/completed=1'],
    totalCachedInputTokens: 2,
    totalInputTokens: 5,
    totalOutputTokens: 7,
    totalReasoningOutputTokens: 3,
    totalTokens: 12,
    transcriptRefReads: 0,
    truncatedOutputs: 1,
    turnCachedInputTokens: 2,
    turnInputTokens: 5,
    turnOutputTokens: 7,
    turnReasoningOutputTokens: 3,
    turns: 1,
    turnTokens: 12,
    turnUsageAvailability: ['reported=1'],
    verificationStatuses: ['passed'],
  };
}
