import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';

for (const [file, functionName] of [
  ['app.js', 'backendRequiresAuth'],
  ['collab.js', 'requiresAuth']
] as const) {
  describe(`${file} health check`, () => {
    const source = readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    const start = source.indexOf('  async function request(');
    const end = source.indexOf(
      file === 'app.js' ? '  async function requestBackend(' : '  const post =',
      start
    );
    const snippet = source.slice(start, end);
    const check = (fetch: typeof globalThis.fetch) =>
      new Function('fetch', `${snippet}\nreturn ${functionName};`)(fetch) as (
        base: string
      ) => Promise<boolean>;
    const response = (status: number, data?: object) =>
      ({ok: status >= 200 && status < 300, status, json: async () => data}) as Response;

    it('asks for a code only when auth is required', async () => {
      expect(
        await check(vi.fn().mockResolvedValue(response(200, {data: {authRequired: false}})))('http://host')
      ).toBe(false);
      expect(
        await check(vi.fn().mockResolvedValue(response(200, {data: {authRequired: true}})))('http://host')
      ).toBe(true);
      expect(
        await check(vi.fn().mockResolvedValue(response(401, {error: {message: 'Unauthorized'}})))(
          'http://host'
        )
      ).toBe(true);
    });

    it.each([
      [403, '拒绝访问'],
      [404, '/health'],
      [500, 'server error']
    ])('reports HTTP %i instead of asking for a code', async (status, message) => {
      await expect(
        check(vi.fn().mockResolvedValue(response(status, {error: {message: 'server error'}})))('http://host')
      ).rejects.toThrow(message);
    });

    it('reports fetch failures as connectivity or CORS errors', async () => {
      await expect(
        check(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))('http://host')
      ).rejects.toThrow('CORS');
    });
  });
}
