// Shared text and HTTP helpers for session naming and mail notifications.
export const endpoint = (base: string, path: string) =>
  `${base.replace(/\/$/, '')}${base.replace(/\/$/, '').endsWith('/v1') ? '' : '/v1'}${path}`;
export const authHeaders = (key?: string): Record<string, string> =>
  key ? {authorization: `Bearer ${key}`} : {};
export const deadline = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export function assistantText(message: unknown): string | undefined {
  if (typeof message === 'string') return message.trim() || undefined;
  if (!message || typeof message !== 'object') return;
  const value = message as any;
  if (value.role && value.role !== 'assistant') return;
  if (typeof value.content === 'string') return value.content.trim() || undefined;
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
      .trim();
    return text || undefined;
  }
}

export function prepareSummaryInput(text: string, maxChars = 32000): string {
  let cleaned = text
    .replace(/```[\s\S]*?```/g, ' [代码已省略] ')
    .replace(/<details[\s\S]*?<\/details>/gi, ' [详细内容已省略] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const head = Math.floor(maxChars * 0.375),
    tail = maxChars - head;
  cleaned = `${cleaned.slice(0, head)}\n\n[中间内容已省略]\n\n${cleaned.slice(-tail)}`;
  return cleaned;
}

export function clipSummaryField(text: string, maxChars: number): string {
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const head = Math.floor(maxChars * 0.375),
    tail = maxChars - head;
  return `${normalized.slice(0, head)}\n\n[中间内容已省略]\n\n${normalized.slice(-tail)}`;
}
