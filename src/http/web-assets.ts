import type http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {json} from './utils.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web'),
  require = createRequire(import.meta.url);
const markedBrowser = path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js');
const webFiles: Record<string, {file: string; type: string}> = {
  '/': {file: 'index.html', type: 'text/html; charset=utf-8'},
  '/index.html': {file: 'index.html', type: 'text/html; charset=utf-8'},
  '/app.js': {file: 'app.js', type: 'text/javascript; charset=utf-8'},
  '/backend-state.js': {file: 'backend-state.js', type: 'text/javascript; charset=utf-8'},
  '/hid-keyboard.js': {file: 'hid-keyboard.js', type: 'text/javascript; charset=utf-8'},
  '/activity-view.js': {file: 'activity-view.js', type: 'text/javascript; charset=utf-8'},
  '/collab': {file: 'collab.html', type: 'text/html; charset=utf-8'},
  '/collab.html': {file: 'collab.html', type: 'text/html; charset=utf-8'},
  '/collab.js': {file: 'collab.js', type: 'text/javascript; charset=utf-8'},
  '/styles.css': {file: 'styles.css', type: 'text/css; charset=utf-8'},
  '/icon.svg': {file: 'icon.svg', type: 'image/svg+xml'},
  '/favicon.ico': {file: 'icon.svg', type: 'image/svg+xml'},
  '/vendor/xterm.js': {file: require.resolve('@xterm/xterm'), type: 'text/javascript; charset=utf-8'},
  '/vendor/xterm.css': {file: require.resolve('@xterm/xterm/css/xterm.css'), type: 'text/css; charset=utf-8'},
  '/vendor/addon-fit.js': {file: require.resolve('@xterm/addon-fit'), type: 'text/javascript; charset=utf-8'},
  '/vendor/marked.js': {file: markedBrowser, type: 'text/javascript; charset=utf-8'},
  '/vendor/dompurify.js': {
    file: require.resolve('dompurify/purify.min.js'),
    type: 'text/javascript; charset=utf-8'
  }
};

/** Serves a bundled Web UI or vendor file. Returns false when `pathname` is not a static asset. */
export async function serveWebAsset(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: {noAuth: boolean}
) {
  const asset = webFiles[pathname];
  if (!asset) return false;
  try {
    const content = await readFile(path.isAbsolute(asset.file) ? asset.file : path.join(webRoot, asset.file)),
      etag = `"${createHash('sha256').update(content).digest('base64url')}"`,
      ifNoneMatch = String(req.headers['if-none-match'] ?? '')
        .split(',')
        .map(value => value.trim().replace(/^W\//, ''));
    res.setHeader('content-type', asset.type);
    res.setHeader('cache-control', pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache');
    res.setHeader('etag', etag);
    res.setHeader('x-content-type-options', 'nosniff');
    if (options.noAuth && asset.type.startsWith('text/html'))
      res.setHeader('content-security-policy', "frame-ancestors 'self'");
    if (ifNoneMatch.includes(etag) || ifNoneMatch.includes('*')) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    res.statusCode = 200;
    res.end(content);
  } catch {
    json(res, 500, {
      error: {
        code: 'WEB_UI_UNAVAILABLE',
        message: 'Web UI files are missing. Reinstall the pi2web package.'
      }
    });
  }
  return true;
}
