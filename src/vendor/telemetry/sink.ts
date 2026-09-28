import type { EventInsertData, SessionUpsertData } from './types.js';

export interface TelemetrySink {
  close(): Promise<void>;
  recordEvent(data: EventInsertData): Promise<void>;
  upsertSession(data: SessionUpsertData): Promise<void>;
}

const NOOP_TELEMETRY_SINK: TelemetrySink = Object.freeze({
  close: () => Promise.resolve(),
  recordEvent: () => Promise.resolve(),
  upsertSession: () => Promise.resolve(),
});

export function createNoopTelemetrySink(): TelemetrySink {
  return NOOP_TELEMETRY_SINK;
}
