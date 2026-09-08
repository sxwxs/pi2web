import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const connectionSource=source.slice(source.indexOf('  const CONNECTIONS_KEY'),source.indexOf('  const state ='));

function loadStoredConnections(initial:Record<string,string>){
  const localStorage={...initial,getItem(key:string){return Object.prototype.hasOwnProperty.call(this,key)?String((this as Record<string,unknown>)[key]):null}};
  const connections=runInNewContext(`${connectionSource}\nloadStoredConnections()`,{localStorage,location:{origin:'http://127.0.0.1:11318'}});
  return {connections:JSON.parse(JSON.stringify(connections)),localStorage};
}

describe('stored backend connections',()=>{
  it('migrates legacy single-backend storage when the new key is absent',()=>{
    const {connections,localStorage}=loadStoredConnections({rpToken:'secret',rpBase:'http://localhost:11318',rpSessionKeyboardBindings:JSON.stringify([{agentId:'agent-a',slot:0}])});
    expect(connections).toEqual([{id:'bk-main',name:'本机',base:'http://localhost:11318',token:'secret',saved:true}]);
    expect(JSON.parse(localStorage.rpSessionKeyboardBindings)).toEqual([{agentId:'bk-main:agent-a',slot:0}]);
  });

  it('keeps an explicitly stored empty backend list authoritative',()=>{
    const {connections}=loadStoredConnections({rpConnections:'[]',rpToken:'legacy'});
    expect(connections).toEqual([]);
  });
});
