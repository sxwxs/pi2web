#!/usr/bin/env node
import {RemotePiServer} from './server.js';
import pkg from '../package.json' with {type:'json'};

const args=process.argv.slice(2);
const value=(name:string,fallback:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]??fallback:fallback};
if(args.includes('--help')||args.includes('-h')){
  console.log(`remote-pi ${pkg.version}\n\nUsage: remote-pi [options]\n\nOptions:\n  --host <address>          Listen address (default: 127.0.0.1)\n  --port <number>           Listen port (default: 8787)\n  --data-dir <path>         Metadata directory (default: ~/.pi/remote-pi)\n  --rotate-access-token     Generate a new pairing code and exit\n  --version                 Print version\n  -h, --help                Show help\n\nThe Web UI is served at the same address. Its pairing code must be entered manually; the browser asks before saving it locally.`);
  process.exit(0);
}
if(args.includes('--version')||args.includes('-v')){console.log(pkg.version);process.exit(0)}
const host=value('--host','127.0.0.1'),port=Number(value('--port','8787'));
if(!Number.isInteger(port)||port<0||port>65535){console.error('Invalid --port');process.exit(1)}
const server=new RemotePiServer({host,port,dataDir:value('--data-dir',process.env.PI_REMOTE_DIR??`${process.env.HOME??'.'}/.pi/remote-pi`)});
if(args.includes('--rotate-access-token')){await server.auth.init();console.log(await server.auth.rotate());process.exit(0)}
if(args.includes('--print-access-token')){console.error('The pairing code is only shown on first startup or rotation.');process.exit(1)}
try{
  await server.start();
  const address=server.address();
  console.log(`Remote Pi is ready: http://${host}:${address?.port ?? port}`);
  console.log('Open this URL and enter the pairing code manually.');
}catch(error){console.error(`Failed to start Remote Pi: ${(error as Error).message}`);process.exit(1)}
const shutdown=async()=>{await server.stop();process.exit(0)};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
