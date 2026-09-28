/**
 * Agent session API for bidirectional agent communication.
 *
 * This module provides the API for creating persistent agent sessions that
 * support multiple message exchanges. Context arrays from higher layers are
 * concatenated with base content at session creation time.
 *
 * @example
 * ```typescript
 * import { createSession } from 'ai-subagent/internal';
 *
 * const session = createSession({
 *   model: 'gpt',
 *   projectRoot: '/path/to/repo',
 *   role: 'builder',
 *   context: [{ heading: 'Instructions', body: '...' }],
 *   responseSentinel: '---END_RESPONSE---',
 * });
 *
 * const response = await session.send('Hello');
 * await session.dispose();
 * ```
 *
 * @module api/session
 */

import type { AgentSession, AgentSessionOptions } from './types.js';

import { getLensPrompt } from '../lenses/index.js';
import { AGENT_MODEL_CLAUDE, AGENT_MODEL_GPT, AGENT_MODEL_XAI } from '../shared/agentConstants.js';
import { buildAgentContext } from '../shared/context.js';
import { resolveModel } from '../targets/registry.js';
import { ClaudePrintSession } from './sessions/ClaudePrintSession.js';
import { CliAgentSession } from './sessions/CliAgentSession.js';
import { GptExecSession } from './sessions/GptExecSession.js';
import { GrokAcpSession } from './sessions/GrokAcpSession.js';

/**
 * Create an agent session for bidirectional communication.
 */
export function createSession(options: AgentSessionOptions): AgentSession {
  const {
    behavior,
    context = [],
    env,
    envMode,
    idleTimeoutMs,
    lens,
    logger,
    maxTurnMs,
    mcpConfig,
    model,
    modelId,
    onActivity,
    onProcessOutcome,
    onTokenUsage,
    outputPrefix,
    projectRoot,
    reasoning,
    responseSentinel,
    role,
    runtimeMode,
    sessionId,
    strictMcpConfig,
    superpowersSkillReferences,
    transcriptLabel,
    transcriptPath,
  } = options;

  const lensName = typeof lens === 'string' ? lens.trim() : '';
  const lensPrompt = lensName.length > 0 ? getLensPrompt({ lens: lensName, projectRoot }) : null;
  const runtimeContextSections = [
    ...(lensPrompt !== null ? [{ body: lensPrompt, heading: `Lens: ${lensName}` }] : []),
    ...context,
  ];
  const contextPrompt = buildAgentContext({
    context: runtimeContextSections,
    projectRoot,
    ...(role !== undefined ? { role } : {}),
  });

  const agent = model;
  const requestedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId.trim() : undefined;
  const resolvedModel = requestedModelId === undefined ? undefined : resolveModel(requestedModelId);
  if (resolvedModel !== undefined && resolvedModel.model.backend !== agent) {
    throw new Error(`Model "${resolvedModel.requested}" does not match session agent "${agent}".`);
  }
  const canonicalModelId = resolvedModel?.resolvedId;
  const resolvedEnv = resolvedModel?.model.env;
  const sessionEnv =
    env === undefined && resolvedEnv === undefined
      ? undefined
      : {
          ...(env ?? {}),
          ...(resolvedEnv ?? {}),
        };

  const sessionOptions = {
    agent,
    ...(behavior !== undefined ? { behavior } : {}),
    contextPrompt,
    projectRoot,
    responseSentinel,
    ...(sessionEnv !== undefined ? { env: sessionEnv } : {}),
    ...(envMode !== undefined ? { envMode } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(maxTurnMs !== undefined ? { maxTurnMs } : {}),
    ...(mcpConfig !== undefined ? { mcpConfig } : {}),
    ...(canonicalModelId !== undefined ? { modelId: canonicalModelId } : {}),
    ...(onActivity !== undefined ? { onActivity } : {}),
    ...(onProcessOutcome !== undefined ? { onProcessOutcome } : {}),
    ...(onTokenUsage !== undefined ? { onTokenUsage } : {}),
    ...(outputPrefix !== undefined ? { outputPrefix } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(requestedModelId !== undefined ? { requestedModelId } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(runtimeMode !== undefined ? { runtimeMode } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(strictMcpConfig !== undefined ? { strictMcpConfig } : {}),
    ...(superpowersSkillReferences !== undefined ? { superpowersSkillReferences } : {}),
    ...(transcriptLabel !== undefined ? { transcriptLabel } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  };

  const command = resolvedModel?.model.command;
  if (command === 'codex' || (command === undefined && agent === AGENT_MODEL_GPT)) {
    return new GptExecSession(sessionOptions);
  }

  if (command === 'claude' || (command === undefined && agent === AGENT_MODEL_CLAUDE)) {
    return new ClaudePrintSession(sessionOptions);
  }

  if (command === 'grok' || (command === undefined && agent === AGENT_MODEL_XAI)) {
    return new GrokAcpSession(sessionOptions);
  }

  return new CliAgentSession(sessionOptions);
}
