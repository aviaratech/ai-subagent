#!/usr/bin/env node
import { startSubagentMcpStdio } from './mcp-server.js';
import { runSubagentTelemetryReportCli } from './telemetryReport.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'telemetry-report') {
    await runSubagentTelemetryReportCli(args);
    return;
  }
  await startSubagentMcpStdio();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[ai-subagent] fatal: ${message}\n`);
  process.exitCode = 1;
});
