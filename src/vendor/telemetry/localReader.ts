import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_LOCAL_TELEMETRY_MAX_RECORD_BYTES,
  DEFAULT_LOCAL_TELEMETRY_RETENTION_DAYS,
  defaultLocalTelemetryRoot,
  LOCAL_TELEMETRY_SCHEMA_VERSION,
  type LocalTelemetryRecord,
} from './localJsonl.js';

const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface LocalTelemetryReadResult {
  malformedLineCount: number;
  oversizedLineCount: number;
  records: LocalTelemetryRecord[];
  rejectedRecordCount: number;
}

export interface ReadLocalTelemetryOptions {
  maxLineBytes?: number;
  maxRecords?: number;
  maxTotalBytes?: number;
  now?: () => Date;
  retentionDays?: number;
  rootDir?: string;
}

export function readLocalTelemetry(options: ReadLocalTelemetryOptions = {}): LocalTelemetryReadResult {
  const rootDir = resolve(options.rootDir ?? defaultLocalTelemetryRoot());
  const result: LocalTelemetryReadResult = {
    malformedLineCount: 0,
    oversizedLineCount: 0,
    records: [],
    rejectedRecordCount: 0,
  };
  let rootStat;
  try {
    rootStat = lstatSync(rootDir);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return result;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('local_telemetry_invalid_root: telemetry root must be a regular, non-symlink directory.');
  }

  const maxLineBytes = readPositiveInteger(
    options.maxLineBytes ?? DEFAULT_LOCAL_TELEMETRY_MAX_RECORD_BYTES,
    'maxLineBytes',
  );
  const maxRecords = readPositiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, 'maxRecords');
  let remainingBytes = readPositiveInteger(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
  const retentionDays = readPositiveInteger(
    options.retentionDays ?? DEFAULT_LOCAL_TELEMETRY_RETENTION_DAYS,
    'retentionDays',
  );
  const current = options.now?.() ?? new Date();
  const cutoff =
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()) -
    (retentionDays - 1) * 24 * 60 * 60 * 1000;
  const files = readdirSync(rootDir)
    .filter(name => {
      const timestamp = dateSegmentTimestamp(name);
      return timestamp !== undefined && timestamp >= cutoff;
    })
    .sort()
    .reverse();
  const groups: LocalTelemetryRecord[][] = [];

  for (const name of files) {
    if (remainingBytes <= 0 || result.records.length >= maxRecords) {
      break;
    }
    const path = join(rootDir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('local_telemetry_invalid_file: telemetry segment must be a regular, non-symlink file.');
    }
    const length = Math.min(stat.size, remainingBytes);
    const { partial, text } = readTail({ fileSize: stat.size, maxBytes: length, path });
    remainingBytes -= length;
    const lines = text.split('\n');
    if (partial) {
      lines.shift();
    }
    const group: LocalTelemetryRecord[] = [];
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        result.oversizedLineCount += 1;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isLocalTelemetryRecord(parsed)) {
          result.malformedLineCount += 1;
          continue;
        }
        if (parsed.kind === 'diagnostic') {
          result.rejectedRecordCount += 1;
        }
        group.push(parsed);
      } catch {
        result.malformedLineCount += 1;
      }
    }
    groups.push(group);
    result.records.push(...group);
  }

  result.records = groups.reverse().flat().slice(-maxRecords);
  return result;
}

function dateSegmentTimestamp(name: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/u.exec(name);
  if (match === null) {
    return undefined;
  }
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? timestamp : undefined;
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

function isLocalTelemetryRecord(value: unknown): value is LocalTelemetryRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('schemaVersion' in value) || value.schemaVersion !== LOCAL_TELEMETRY_SCHEMA_VERSION) {
    return false;
  }
  if (!('recordedAt' in value) || typeof value.recordedAt !== 'string') {
    return false;
  }
  if (!('kind' in value) || (value.kind !== 'event' && value.kind !== 'session' && value.kind !== 'diagnostic')) {
    return false;
  }
  return 'data' in value && typeof value.data === 'object' && value.data !== null;
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`local_telemetry_invalid_option: ${name} must be a positive integer.`);
  }
  return value;
}

function readTail(input: { fileSize: number; maxBytes: number; path: string }): { partial: boolean; text: string } {
  const start = Math.max(0, input.fileSize - input.maxBytes);
  const buffer = Buffer.alloc(input.fileSize - start);
  const descriptor = openSync(input.path, 'r');
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return { partial: start > 0, text: buffer.subarray(0, offset).toString('utf8') };
  } finally {
    closeSync(descriptor);
  }
}
