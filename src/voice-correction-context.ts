import type {TimelineEntry} from './timeline.js';

export const VOICE_CORRECTION_CONTEXT_LIMITS = {
  firstUserMessage: 2000,
  latestUserMessage: 2000,
  latestAssistantMessage: 4000
} as const;
export type VoiceCorrectionContext = Partial<Record<keyof typeof VOICE_CORRECTION_CONTEXT_LIMITS, string>>;

const clip = (text: string, limit: number) => {
  text = text.trim();
  if (text.length <= limit) return text;
  const marker = '\n[中间内容已截断]\n',
    available = limit - marker.length;
  const head = Math.ceil(available * 0.6);
  return text.slice(0, head) + marker + text.slice(-(available - head));
};

/** Rebuild from the three allowed text fields; never forward a raw context object or message metadata. */
export function boundedVoiceCorrectionContext(value: unknown): VoiceCorrectionContext {
  const context: VoiceCorrectionContext = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return context;
  for (const key of Object.keys(VOICE_CORRECTION_CONTEXT_LIMITS) as (keyof VoiceCorrectionContext)[]) {
    const text = (value as Record<string, unknown>)[key];
    if (typeof text !== 'string' || !text.trim()) continue;
    context[key] = clip(text, VOICE_CORRECTION_CONTEXT_LIMITS[key]);
  }
  return context;
}

/** Current-branch human/assistant message text only. No tools, thinking, logs, summaries or images. */
export function voiceCorrectionContext(entries: readonly TimelineEntry[]): VoiceCorrectionContext {
  let firstUserMessage: string | undefined,
    latestUserMessage: string | undefined,
    latestAssistantMessage: string | undefined;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message as any;
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    if (message.role === 'assistant' && ['toolUse', 'error', 'aborted'].includes(message.stopReason))
      continue;
    const text = (
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
              .map((part: any) => part.text)
              .join('\n')
          : ''
    ).trim();
    if (!text) continue;
    if (message.role === 'user') {
      firstUserMessage ??= text;
      latestUserMessage = text;
    } else latestAssistantMessage = text;
  }
  return boundedVoiceCorrectionContext({
    firstUserMessage,
    latestUserMessage: latestUserMessage === firstUserMessage ? undefined : latestUserMessage,
    latestAssistantMessage
  });
}
