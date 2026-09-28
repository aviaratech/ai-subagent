export interface EventInsertData {
  errorMessage?: string;
  eventType?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  plugin?: string;
  sessionId: string;
  source: string;
  status: 'error' | 'ok';
  toolName?: string;
  toolUseId?: string;
}

export interface SessionUpsertData {
  host?: string;
  metadata?: Record<string, unknown>;
  sessionId: string;
}
