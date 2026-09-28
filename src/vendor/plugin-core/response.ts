export interface ToolResponse {
  [key: string]: unknown;
  content: { text: string; type: 'text' }[];
}

export function textResponse(data: unknown): ToolResponse {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ text, type: 'text' as const }] };
}
