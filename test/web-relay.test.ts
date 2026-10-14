import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');

describe('web relay connections',()=>{
  it('uses the relay backend address and token for browser-to-relay traffic',()=>{
    const start=source.indexOf('  const backendWire =');
    const end=source.indexOf('  async function apiB',start);
    const wire=runInNewContext(`${source.slice(start,end)}\nbackendWire(input)`,{
      input:{base:'http://target:11318',token:'',relayHostId:'host-1',relayVia:'relay'},
      backendOf:(id:string)=>id==='relay'?{base:'https://relay.example',token:'relay-token'}:undefined,
    });
    expect(JSON.parse(JSON.stringify(wire))).toEqual({prefix:'https://relay.example/api/v1/hosts/host-1',token:'relay-token'});
    expect(source).toContain("request(wire.prefix, wire.token, '/health')");
    expect(source).not.toContain("request(wire.prefix, '', '/health')");
    expect(source).toContain('if (!isRelay && !wire.token && authRequired)');
    expect(source).toContain('confirmSave && !isRelay && authRequired');
  });

  it('lists saved relay hosts in configuration rather than the add dialog',()=>{
    expect(html).toContain('id="relayHostList"');
    expect(html).toContain('中继节点保存的主机');
    expect(html).not.toContain('id="pairHost"');
    expect(source).toContain("await apiB(via.id,'/api/v1/hosts')");
  });
});
