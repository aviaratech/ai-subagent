import type { EventInsertData, SessionUpsertData } from './types.js';

import { constants, type Dirent, promises as fs, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TelemetrySink } from './sink.js';

import { sanitizeTelemetryData } from './sanitize.js';

export const DEFAULT_LOCAL_TELEMETRY_RETENTION_DAYS = 14;
export const DEFAULT_LOCAL_TELEMETRY_MAX_RECORD_BYTES = 64 * 1024;
export const LOCAL_TELEMETRY_SCHEMA_VERSION = 1;

export interface LocalJsonlTelemetrySinkOptions {
  maxRecordBytes?: number;
  now?: () => Date;
  retentionDays?: number;
  rootDir?: string;
}

export type LocalTelemetryRecord =
  | {
      data: Record<string, unknown>;
      kind: 'event';
      recordedAt: string;
      schemaVersion: typeof LOCAL_TELEMETRY_SCHEMA_VERSION;
    }
  | {
      data: Record<string, unknown>;
      kind: 'session';
      recordedAt: string;
      schemaVersion: typeof LOCAL_TELEMETRY_SCHEMA_VERSION;
    }
  | {
      data: { code: 'record_oversize_rejected'; originalKind: 'event' | 'session' };
      kind: 'diagnostic';
      recordedAt: string;
      schemaVersion: typeof LOCAL_TELEMETRY_SCHEMA_VERSION;
    };

export function createLocalJsonlTelemetrySink(options: LocalJsonlTelemetrySinkOptions = {}): TelemetrySink {
  const maxRecordBytes = readPositiveInteger(
    options.maxRecordBytes ?? DEFAULT_LOCAL_TELEMETRY_MAX_RECORD_BYTES,
    'maxRecordBytes',
  );
  const retentionDays = readPositiveInteger(
    options.retentionDays ?? DEFAULT_LOCAL_TELEMETRY_RETENTION_DAYS,
    'retentionDays',
  );
  const rootDir = resolve(options.rootDir ?? defaultLocalTelemetryRoot());
  const now = options.now ?? (() => new Date());
  let closed = false;
  let tail = Promise.resolve();
  let initialization: Promise<void> | undefined;
  const ensuredSegments = new Set<string>();

  const enqueue = (kind: 'event' | 'session', data: EventInsertData | SessionUpsertData): Promise<void> => {
    if (closed) {
      return Promise.reject(new Error('local_telemetry_closed: telemetry sink is already closed.'));
    }
    const operation = tail.then(async () => {
      initialization ??= initializeLocalRoot({ now, retentionDays, rootDir });
      await initialization;
      const current = readValidDate(now());
      const segmentPath = join(rootDir, `${utcDateSegment(current)}.jsonl`);
      if (!ensuredSegments.has(segmentPath)) {
        await ensureDailySegment(segmentPath);
        ensuredSegments.add(segmentPath);
      }
      const record = createRecord({ data, kind, recordedAt: current });
      const encoded = encodeBoundedRecord(record, maxRecordBytes);
      await appendOneLine(segmentPath, encoded);
    });
    tail = operation.catch(() => undefined);
    return operation;
  };

  return {
    async close(): Promise<void> {
      closed = true;
      await tail;
    },
    recordEvent: data => enqueue('event', data),
    upsertSession: data => enqueue('session', data),
  };
}

export function defaultLocalTelemetryRoot(): string {
  return join(homedir(), '.local', 'share', 'ai-subagent', 'telemetry');
}

async function appendOneLine(segmentPath: string, encoded: string): Promise<void> {
  const handle = await fs.open(segmentPath, constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY);
  try {
    assertSafeSegment(await handle.stat());
    const result = await handle.write(encoded, null, 'utf8');
    if (result.bytesWritten !== Buffer.byteLength(encoded, 'utf8')) {
      throw new Error('local_telemetry_short_write: telemetry line was not written completely.');
    }
  } finally {
    await handle.close();
  }
}

function assertSafeSegment(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('local_telemetry_invalid_file: telemetry segment must be a regular, non-symlink file.');
  }
}

function createRecord(input: {
  data: EventInsertData | SessionUpsertData;
  kind: 'event' | 'session';
  recordedAt: Date;
}): LocalTelemetryRecord {
  return {
    data: sanitizeTelemetryData({ ...input.data }),
    kind: input.kind,
    recordedAt: input.recordedAt.toISOString(),
    schemaVersion: LOCAL_TELEMETRY_SCHEMA_VERSION,
  };
}

function dateSegmentTimestamp(name: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/u.exec(name);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return timestamp;
}

function encodeBoundedRecord(record: LocalTelemetryRecord, maxRecordBytes: number): string {
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') <= maxRecordBytes) {
    return encoded;
  }
  const diagnostic: LocalTelemetryRecord = {
    data: { code: 'record_oversize_rejected', originalKind: record.kind === 'session' ? 'session' : 'event' },
    kind: 'diagnostic',
    recordedAt: record.recordedAt,
    schemaVersion: LOCAL_TELEMETRY_SCHEMA_VERSION,
  };
  const bounded = `${JSON.stringify(diagnostic)}\n`;
  if (Buffer.byteLength(bounded, 'utf8') > maxRecordBytes) {
    throw new Error('local_telemetry_record_limit: maxRecordBytes is too small for a diagnostic record.');
  }
  return bounded;
}

async function ensureDailySegment(segmentPath: string): Promise<void> {
  try {
    const handle = await fs.open(
      segmentPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    await handle.close();
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
  const stat = await fs.lstat(segmentPath);
  assertSafeSegment(stat);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('local_telemetry_insecure_file: telemetry segment must be owner-only (0600).');
  }
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === expectedCode
  );
}

async function initializeLocalRoot(input: { now: () => Date; retentionDays: number; rootDir: string }): Promise<void> {
  await fs.mkdir(input.rootDir, { mode: 0o700, recursive: true });
  const stat = await fs.lstat(input.rootDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('local_telemetry_invalid_root: telemetry root must be a regular, non-symlink directory.');
  }
  await fs.chmod(input.rootDir, 0o700);
  await pruneExpiredSegments({
    currentDate: readValidDate(input.now()),
    retentionDays: input.retentionDays,
    rootDir: input.rootDir,
  });
}

async function pruneExpiredSegments(input: {
  currentDate: Date;
  retentionDays: number;
  rootDir: string;
}): Promise<void> {
  const cutoff = utcDayStart(input.currentDate) - (input.retentionDays - 1) * 24 * 60 * 60 * 1000;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(input.rootDir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  await Promise.all(
    entries.map(async entry => {
      const timestamp = dateSegmentTimestamp(entry.name);
      if (timestamp === undefined || timestamp >= cutoff || !entry.isFile()) {
        return;
      }
      await fs.unlink(join(input.rootDir, entry.name));
    }),
  );
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`local_telemetry_invalid_option: ${name} must be a positive integer.`);
  }
  return value;
}

function readValidDate(date: Date): Date {
  if (!Number.isFinite(date.getTime())) {
    throw new Error('local_telemetry_invalid_clock: now() returned an invalid date.');
  }
  return date;
}

function utcDateSegment(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
