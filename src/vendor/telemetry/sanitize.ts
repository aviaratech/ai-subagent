/**
 * Redaction utilities for telemetry data.
 *
 * Redaction-first: only allowlisted fields survive.
 * This is the boundary between tool internals and stored telemetry.
 */

/**
 * Strip all fields not in the allowlist.
 * Returns a new object containing only allowlisted keys with their values.
 */
export function sanitize(data: Record<string, unknown>, allowlist: ReadonlySet<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (allowlist.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|authorization|body|content|credential|oauth|password|prompt|raw[_-]?transcript|secret)/iu;
const TOKEN_KEY_PATTERN = /token/iu;

/** Remove secret-bearing fields recursively at the storage boundary. */
export function sanitizeTelemetryData(data: Record<string, unknown>): Record<string, unknown> {
  return sanitizeTelemetryObject(data, 0);
}

function isSensitiveTelemetryKey(key: string, value: unknown): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }
  return TOKEN_KEY_PATTERN.test(key) && typeof value !== 'number';
}

function sanitizeTelemetryObject(data: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= 16) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveTelemetryKey(key, value)) {
      continue;
    }
    result[key] = sanitizeTelemetryValue(value, depth + 1);
  }
  return result;
}

function sanitizeTelemetryValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeTelemetryValue(item, depth));
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeTelemetryObject(value as Record<string, unknown>, depth);
  }
  return value;
}

/** Default max length for truncated error messages. */
const DEFAULT_MAX_LEN = 512;

/**
 * Truncate an error message for storage.
 * Returns the original string if within the limit, or a truncated version with an ellipsis indicator.
 */
export function truncateError(msg: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (msg.length <= maxLen) return msg;
  return `${msg.slice(0, maxLen - 3)}...`;
}
