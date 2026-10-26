import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {PROTOCOL_VERSION} from '../src/ws/agent-socket.js';

describe('protocol version', () => {
  it('is the same in the Web UI and the server', () => {
    const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    // The Web UI refuses a backend whose version differs, so a mismatch means it cannot connect at all.
    expect(Number(/const PROTOCOL_VERSION = (\d+);/.exec(source)?.[1])).toBe(PROTOCOL_VERSION);
  });
});
