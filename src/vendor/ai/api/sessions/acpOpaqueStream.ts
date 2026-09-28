import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';

const MAX_FRAME_BYTES = 16_000_000;
const MAX_PROVIDER_ERROR_MESSAGE_BYTES = 65_536;
const MAX_PERMISSION_OPTIONS = 16;
const MAX_PERMISSION_TOKEN_BYTES = 256;
const boundedOpaqueTokenSchema = z
  .string()
  .min(1)
  .refine(value => Buffer.byteLength(value, 'utf8') <= MAX_PERMISSION_TOKEN_BYTES);

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const requestSchema = z
  .object({
    id: jsonRpcIdSchema,
    jsonrpc: z.literal('2.0'),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();
const notificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();
const resultSchema = z
  .object({
    id: jsonRpcIdSchema,
    jsonrpc: z.literal('2.0'),
    result: z.unknown(),
  })
  .strict();
const errorSchema = z
  .object({
    error: z
      .object({
        code: z.number(),
        data: z.unknown().optional(),
        message: z.string(),
      })
      .strict(),
    id: jsonRpcIdSchema,
    jsonrpc: z.literal('2.0'),
  })
  .strict();
const envelopeSchema = z.union([requestSchema, notificationSchema, resultSchema, errorSchema]);

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ text: z.string(), type: z.literal('text') }).loose(),
  z.object({ data: z.string(), mimeType: z.string(), type: z.literal('image') }).loose(),
  z.object({ data: z.string(), mimeType: z.string(), type: z.literal('audio') }).loose(),
  z.object({ name: z.string(), type: z.literal('resource_link'), uri: z.string() }).loose(),
  z
    .object({
      resource: z.union([
        z.object({ text: z.string(), uri: z.string() }).loose(),
        z.object({ blob: z.string(), uri: z.string() }).loose(),
      ]),
      type: z.literal('resource'),
    })
    .loose(),
]);
const contentUpdateSchema = z
  .object({
    content: contentBlockSchema,
    sessionUpdate: z.enum(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']),
  })
  .loose();
const toolCallSchema = z
  .object({
    sessionUpdate: z.literal('tool_call'),
    title: z.string(),
    toolCallId: z.string(),
  })
  .loose();
const toolCallUpdateSchema = z
  .object({
    sessionUpdate: z.literal('tool_call_update'),
    toolCallId: z.string(),
  })
  .loose();
const planUpdateContentSchema = z.discriminatedUnion('type', [
  z.object({ entries: z.array(z.unknown()), planId: z.string(), type: z.literal('items') }).loose(),
  z.object({ planId: z.string(), type: z.literal('file'), uri: z.string() }).loose(),
  z.object({ content: z.string(), planId: z.string(), type: z.literal('markdown') }).loose(),
]);
const otherUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  z.object({ entries: z.array(z.unknown()), sessionUpdate: z.literal('plan') }).loose(),
  z.object({ plan: planUpdateContentSchema, sessionUpdate: z.literal('plan_update') }).loose(),
  z.object({ planId: z.string(), sessionUpdate: z.literal('plan_removed') }).loose(),
  z
    .object({
      availableCommands: z.array(z.unknown()),
      sessionUpdate: z.literal('available_commands_update'),
    })
    .loose(),
  z.object({ currentModeId: z.string(), sessionUpdate: z.literal('current_mode_update') }).loose(),
  z
    .object({
      configOptions: z.array(z.unknown()),
      sessionUpdate: z.literal('config_option_update'),
    })
    .loose(),
  z
    .object({
      sessionUpdate: z.literal('session_info_update'),
      title: z.string().nullable().optional(),
      updatedAt: z.string().nullable().optional(),
    })
    .loose(),
  z
    .object({
      sessionUpdate: z.literal('usage_update'),
      size: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
    })
    .loose(),
]);
const sessionUpdateSchema = z
  .object({
    sessionId: z.string(),
    update: z.union([contentUpdateSchema, toolCallSchema, toolCallUpdateSchema, otherUpdateSchema]),
  })
  .loose();
const permissionRequestSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            kind: z.enum(['allow_always', 'allow_once', 'reject_always', 'reject_once']),
            optionId: boundedOpaqueTokenSchema,
          })
          .loose(),
      )
      .max(MAX_PERMISSION_OPTIONS),
    sessionId: boundedOpaqueTokenSchema,
    toolCall: z
      .object({
        toolCallId: boundedOpaqueTokenSchema,
      })
      .loose(),
  })
  .loose();

interface CodecState {
  pendingRequestIds: Set<string>;
}

interface EncodedLine {
  rawLine: Uint8Array;
  state: CodecState;
}

type ParsedEnvelope = z.infer<typeof envelopeSchema>;

export class AcpOpaqueProtocolError extends Error {
  constructor() {
    super('grok_acp_protocol_malformed');
    this.name = 'AcpOpaqueProtocolError';
  }
}

/**
 * Builds an ACP SDK Stream while keeping malformed provider frames opaque.
 *
 * The SDK's stable `ndJsonStream()` logs malformed raw lines to global
 * console output. This codec performs only NDJSON framing and narrow envelope
 * validation before handing valid messages to the SDK. The SDK still owns
 * JSON-RPC ids, request routing, ACP method dispatch, and cancellation.
 *
 * Session updates are validated against their ACP discriminator and required
 * fields, then reduced to typed observations. Provider-controlled non-text
 * payloads never enter the SDK's eager notification parser or application logs.
 */
export function createOpaqueAcpStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): acp.Stream {
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const state: CodecState = { pendingRequestIds: new Set<string>() };
  const readable = new ReadableStream<acp.AnyMessage>({
    cancel(reason) {
      cancelled = true;
      return inputReader?.cancel(reason);
    },
    async start(controller) {
      const reader = input.getReader();
      inputReader = reader;
      let pending = Buffer.alloc(0);
      try {
        for (;;) {
          const next = await reader.read();
          if (cancelled) {
            return;
          }
          if (next.done) {
            break;
          }
          if (next.value.byteLength === 0) {
            continue;
          }
          pending = Buffer.concat([pending, Buffer.from(next.value)]);
          if (pending.byteLength > MAX_FRAME_BYTES && !pending.includes(0x0a)) {
            throw new AcpOpaqueProtocolError();
          }
          let newline = pending.indexOf(0x0a);
          while (newline >= 0) {
            const line = pending.subarray(0, newline);
            pending = pending.subarray(newline + 1);
            enqueueLine(controller, { rawLine: line, state });
            newline = pending.indexOf(0x0a);
          }
        }
        if (pending.byteLength > 0) {
          enqueueLine(controller, { rawLine: pending, state });
        }
        controller.close();
      } catch {
        if (!cancelled) {
          controller.error(new AcpOpaqueProtocolError());
        }
      } finally {
        if (inputReader === reader) {
          inputReader = undefined;
        }
        reader.releaseLock();
      }
    },
  });
  const encoder = new TextEncoder();
  const writable = new WritableStream<acp.AnyMessage>({
    async write(message) {
      const writer = output.getWriter();
      try {
        if ('method' in message && 'id' in message) {
          state.pendingRequestIds.add(jsonRpcIdKey(message.id));
        }
        await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
      } finally {
        writer.releaseLock();
      }
    },
  });
  return { readable, writable };
}

function correlateResponse(envelope: ParsedEnvelope, state: CodecState): acp.AnyMessage {
  if ('method' in envelope) {
    throw new AcpOpaqueProtocolError();
  }
  if (!state.pendingRequestIds.delete(jsonRpcIdKey(envelope.id))) {
    throw new AcpOpaqueProtocolError();
  }
  if ('error' in envelope) {
    const providerStatus = providerHttpStatus(envelope.error);
    return {
      error: {
        code: envelope.error.code,
        ...(providerStatus === undefined ? {} : { data: { httpStatus: providerStatus } }),
        message:
          providerStatus === undefined
            ? 'Provider ACP request failed.'
            : `Provider ACP request failed with HTTP ${String(providerStatus)}.`,
      },
      id: envelope.id,
      jsonrpc: '2.0',
    };
  }
  return envelope;
}

function decodeEnvelope(rawLine: Uint8Array): ParsedEnvelope | undefined {
  const line =
    rawLine.byteLength > 0 && rawLine.at(-1) === 0x0d ? rawLine.subarray(0, rawLine.byteLength - 1) : rawLine;
  if (line.byteLength === 0) {
    return undefined;
  }
  if (line.byteLength > MAX_FRAME_BYTES) {
    throw new AcpOpaqueProtocolError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
  } catch {
    throw new AcpOpaqueProtocolError();
  }
  const envelope = envelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    throw new AcpOpaqueProtocolError();
  }
  return envelope.data;
}

function enqueueLine(controller: ReadableStreamDefaultController<acp.AnyMessage>, encoded: EncodedLine): void {
  const envelope = decodeEnvelope(encoded.rawLine);
  if (envelope === undefined) {
    return;
  }
  if (!('method' in envelope)) {
    controller.enqueue(correlateResponse(envelope, encoded.state));
    return;
  }
  if ('id' in envelope) {
    if (envelope.method !== 'session/request_permission') {
      throw new AcpOpaqueProtocolError();
    }
    controller.enqueue(sanitizePermissionRequest(envelope));
    return;
  }
  if (envelope.method.startsWith('_')) {
    return;
  }
  if (envelope.method !== 'session/update') {
    throw new AcpOpaqueProtocolError();
  }
  controller.enqueue(sanitizeSessionNotification(envelope.params));
}

function isSupportedProviderStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value === 401 || value === 402 || value === 403 || value === 429 || (value >= 500 && value <= 599))
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonRpcIdKey(id: null | number | string): string {
  return `${typeof id}:${String(id)}`;
}

function providerHttpStatus(error: z.infer<typeof errorSchema>['error']): number | undefined {
  if (isUnknownRecord(error.data)) {
    for (const key of ['http_status', 'httpStatus', 'status', 'statusCode']) {
      const candidate = error.data[key];
      if (isSupportedProviderStatus(candidate)) {
        return candidate;
      }
    }
  }
  if (Buffer.byteLength(error.message, 'utf8') > MAX_PROVIDER_ERROR_MESSAGE_BYTES) {
    return undefined;
  }
  const statusMatch = /(?:http_status|status(?: code)?|HTTP)\D{0,16}(401|402|403|429|5\d{2})/iu.exec(error.message);
  return statusMatch?.[1] === undefined ? undefined : Number(statusMatch[1]);
}

function sanitizePermissionRequest(envelope: z.infer<typeof requestSchema>): acp.AnyMessage {
  const parsed = permissionRequestSchema.safeParse(envelope.params);
  if (!parsed.success) {
    throw new AcpOpaqueProtocolError();
  }
  return {
    id: envelope.id,
    jsonrpc: '2.0',
    method: 'session/request_permission',
    params: {
      options: parsed.data.options.map(option => ({
        kind: option.kind,
        name: option.kind,
        optionId: option.optionId,
      })),
      sessionId: parsed.data.sessionId,
      toolCall: {
        toolCallId: 'redacted',
      },
    },
  };
}

function sanitizeSessionNotification(params: unknown): acp.AnyMessage {
  const parsed = sessionUpdateSchema.safeParse(params);
  if (!parsed.success) {
    throw new AcpOpaqueProtocolError();
  }
  const { sessionId, update } = parsed.data;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          content: { text: update.content.text, type: 'text' },
          sessionUpdate: 'agent_message_chunk',
        },
      },
    };
  }
  if (update.sessionUpdate === 'tool_call') {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          title: 'Tool activity',
          toolCallId: 'redacted',
        },
      },
    };
  }
  if (update.sessionUpdate === 'tool_call_update') {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'redacted',
        },
      },
    };
  }
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        content: { text: '', type: 'text' },
        sessionUpdate: 'agent_thought_chunk',
      },
    },
  };
}
