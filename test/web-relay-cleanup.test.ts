import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
// Only the relay-record cleanup, so the rest of the UI does not have to boot to exercise it.
const cleanupSource = source.slice(source.indexOf('  async function deleteRelayRecords('), source.indexOf('  function openPair('));

type Deletion = {backendId:string, url:string};

function load(respond:(deletion:Deletion) => void) {
  const calls:Deletion[] = [];
  const context:Record<string, unknown> = {
    requestBackend: async (backendId:string, url:string, options:{method?:string} = {}) => {
      expect(options.method).toBe('DELETE');
      const deletion = {backendId, url};
      calls.push(deletion);
      respond(deletion);
      return {deleted:true};
    },
  };
  runInNewContext(cleanupSource, context);
  return {deleteRelayRecords: context.deleteRelayRecords as (items:unknown[]) => Promise<any[]>, calls};
}

const fail = (message:string, extra:Record<string, unknown> = {}) => { throw Object.assign(Error(message), extra) };

describe('relay record cleanup', () => {
  it('deletes every record even when one of them fails, and reports only the failures', async () => {
    const {deleteRelayRecords, calls} = load(deletion => {
      if (deletion.backendId === 'down') fail('Backend「家里」未连接');
    });
    const failed = await deleteRelayRecords([
      {id:'lab', name:'Lab', relayVia:'home', relayHostId:'host-1'},
      {id:'nas', name:'NAS', relayVia:'down', relayHostId:'host-2'},
      {id:'pi', name:'Pi', relayVia:'home', relayHostId:'host-3'},
      // A direct Backend has no record on anyone, so it is skipped rather than requested for.
      {id:'home', name:'家里'},
    ]);
    expect(calls.map(call => call.url)).toEqual([
      '/api/v1/hosts/host-1', '/api/v1/hosts/host-2', '/api/v1/hosts/host-3',
    ]);
    expect(failed).toHaveLength(1);
    expect(failed[0].backend.id).toBe('nas');
    expect(failed[0].error.message).toBe('Backend「家里」未连接');
  });

  it('treats a record the relay no longer has as deleted, so a half-finished cascade can be retried', async () => {
    const {deleteRelayRecords} = load(() => fail('Relay host not found', {status:404, code:'HOST_NOT_FOUND'}));
    expect(await deleteRelayRecords([{id:'lab', name:'Lab', relayVia:'home', relayHostId:'host-1'}])).toEqual([]);
  });

  it('keeps reporting a relay that answers something other than a missing record', async () => {
    const {deleteRelayRecords} = load(() => fail('Invalid token', {status:401}));
    const failed = await deleteRelayRecords([{id:'lab', name:'Lab', relayVia:'home', relayHostId:'host-1'}]);
    expect(failed.map(entry => entry.error.message)).toEqual(['Invalid token']);
  });
});
