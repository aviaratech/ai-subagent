import { readLocalTelemetry } from './vendor/telemetry/index.js';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createSubagentTelemetry, type SubagentTelemetryEvent } from './subagentTelemetry.js';

function eventFor(eventType: SubagentTelemetryEvent['eventType']): SubagentTelemetryEvent {
  return {
    agentId: 'agent-1',
    agentType: 'builder',
    attributionSource: 'provider-event',
    capabilitiesUsed: ['spawn'],
    capabilityInspectionStatus: 'ok',
    capabilityMcpServers: [
      'example-memory@plugin:example-memory',
      'github@project',
      'example-workflow@plugin:example-workflow',
    ],
    capabilityMissing: [],
    capabilityPlugins: ['example-memory@project', 'github@user', 'example-workflow@project', 'superpowers@user'],
    capabilitySkills: [
      'memory-lifecycle@plugin:example-memory',
      'pr-handoff@plugin:example-workflow',
      'using-superpowers@plugin:superpowers',
    ],
    depth: 0,
    effectiveModelId: 'grok-4.5',
    effectiveProvider: 'xai',
    effectiveReasoningEffort: 'high',
    elapsedMs: 120,
    eventType,
    model: 'xai',
    modelId: 'grok-4.5',
    noNestedDelegation: true,
    parentSessionId: 'parent-session-1',
    parentSessionIdSource: 'fallback:server_run_id',
    project: 'worktree',
    requestedModelId: 'grok-4.5',
    requestedProvider: 'xai',
    requestedReasoningEffort: 'high',
    resolvedModelId: 'grok-4.5',
    resolvedProvider: 'xai',
    resolvedReasoningEffort: 'high',
    schemaVersion: 2,
    selectedSkillDigests: ['digest-using', 'digest-tdd'],
    selectedSkills: ['using-superpowers', 'test-driven-development'],
    serverRunId: 'server-run-1',
    status: 'ok',
    terminalOutcome: 'completed',
    transcriptRef: '/opaque/evidence/agent-1.log',
    verificationStatus: 'passed',
  };
}

void describe('subagentTelemetry', () => {
  void it('records local schema-v2 lifecycle events even when database environment is present', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ai-subagent-telemetry-'));
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://must-not-be-used.invalid/telemetry';
    try {
      const telemetry = createSubagentTelemetry({ rootDir });
      telemetry.recordEvent(eventFor('spawn'));
      telemetry.recordEvent({
        ...eventFor('turn_completed'),
        processCompletionMs: 80,
        processExitCode: 0,
        processFirstActivityMs: 20,
        processLastActivityMs: 60,
        processReceivedBytes: 17,
        processSignal: null,
        processStderrBytes: 12,
        processStdoutBytes: 5,
        structuredOutput: {
          lastEventKind: 'end',
          state: 'complete',
          terminalEventSeen: true,
          turnUsageReported: true,
          validEventCount: 2,
        },
        totalCachedInputTokens: 2,
        totalInputTokens: 5,
        totalOutputTokens: 7,
        totalReasoningOutputTokens: 3,
        totalTokens: 12,
        turnCachedInputTokens: 2,
        turnInputTokens: 5,
        turnOutputTokens: 7,
        turnReasoningOutputTokens: 3,
        turnTokens: 12,
        turnUsageReported: true,
      });
      await telemetry.close();

      const result = readLocalTelemetry({ rootDir });
      const eventRecords = result.records.filter(record => record.kind === 'event');
      assert.equal(eventRecords.length, 2);
      const serialized = JSON.stringify(eventRecords);
      assert.match(serialized, /"schemaVersion":2/u);
      assert.match(serialized, /"requestedProvider":"xai"/u);
      assert.match(serialized, /"resolvedModelId":"grok-4.5"/u);
      assert.match(serialized, /"effectiveReasoningEffort":"high"/u);
      assert.match(serialized, /"selectedSkillDigests":\["digest-using","digest-tdd"\]/u);
      assert.match(serialized, /"capabilityInspectionStatus":"ok"/u);
      assert.match(serialized, /"capabilityPlugins":\["example-memory@project","github@user"/u);
      assert.match(serialized, /"capabilityMcpServers":\["example-memory@plugin:example-memory","github@project"/u);
      assert.match(serialized, /"processLastActivityMs":60/u);
      assert.match(serialized, /"processStderrBytes":12/u);
      assert.match(serialized, /"processStdoutBytes":5/u);
      assert.match(
        serialized,
        /"structuredOutput":\{"lastEventKind":"end","state":"complete","terminalEventSeen":true,"turnUsageReported":true,"validEventCount":2\}/u,
      );
      assert.match(serialized, /"turnInputTokens":5/u);
      assert.match(serialized, /"turnUsageReported":true/u);
      assert.doesNotMatch(serialized, /"usageReported":/u);
      assert.match(serialized, /\/opaque\/evidence\/agent-1\.log/u);
      assert.doesNotMatch(serialized, /postgresql|must-not-be-used/u);

      const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      assert.equal(
        Object.values(packageJson.dependencies ?? {}).some(value => value.startsWith('workspace:')),
        false,
      );
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  void it('serializes native lifecycle diagnostics without administrative or secret fields', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ai-subagent-lifecycle-'));
    try {
      const telemetry = createSubagentTelemetry({ rootDir });
      telemetry.recordEvent({
        ...eventFor('turn_completed'),
        cleanupOutcome: 'not_required',
        costUsd: 1.23,
        resultBytes: 42,
        resultTruncated: false,
        terminalCause: 'completed',
        terminalOwner: 'provider',
      });
      await telemetry.close();

      const serialized = JSON.stringify(readLocalTelemetry({ rootDir }).records);
      assert.match(serialized, /"costUsd":1.23/u);
      assert.match(serialized, /"cleanupOutcome":"not_required"/u);
      assert.match(serialized, /"terminalOwner":"provider"/u);
      assert.match(serialized, /"terminalCause":"completed"/u);
      assert.doesNotMatch(
        serialized,
        /"(?:approval|authorization|credential|invocationPolicy|oauth|prompt|promptBody|proposal)":/u,
      );
      assert.doesNotMatch(serialized, /secret prompt body|secret result body|oauth-secret-marker|raw transcript body/u);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
