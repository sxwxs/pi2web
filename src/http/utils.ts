import type http from 'node:http';

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

export const isLoopbackHost = (value: string) => {
  try {
    return LOOPBACK_HOSTS.includes(new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
};

export const json = (res: http.ServerResponse, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
};

export async function readBinaryBody(req: http.IncomingMessage, maxBytes = 25 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request too large'), {code: 'REQUEST_TOO_LARGE'});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body as bytes so the size limit applies while streaming and multi-byte characters are never split across chunks. */
export async function readJsonBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024) {
  const raw = await readBinaryBody(req, maxBytes);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
}

/** Maps a thrown error's `code` to the HTTP status used by every REST endpoint. */
export function errorStatus(code: string | undefined) {
  if (code === 'WORKSPACE_PATH_OUTSIDE_ROOT') return 403;
  if (code === 'FILE_TOO_LARGE' || code === 'REQUEST_TOO_LARGE') return 413;
  if (code === 'VOICE_DISABLED' || code === 'VOICE_STT_DISABLED' || code === 'SOTTO_DISABLED' ||
      code === 'SOTTO_UNAVAILABLE' || code === 'MAIL_NOTIFICATIONS_DISABLED')
    return 503;
  if (code?.endsWith('NOT_FOUND')) return 404;
  return 400;
}
