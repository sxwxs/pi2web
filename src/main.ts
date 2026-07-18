#!/usr/bin/env node
import {RemotePiServer} from './server.js';
const args=process.argv.slice(2);const value=(name:string, fallback:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]??fallback:fallback};
const server=new RemotePiServer({host:value('--host','127.0.0.1'),port:Number(value('--port','8787')),dataDir:value('--data-dir',process.env.PI_REMOTE_DIR??`${process.env.HOME??'.'}/.pi/remote-pi`)});
if(args.includes('--rotate-access-token')){await server.auth.init();console.log(await server.auth.rotate());process.exit(0)}
if(args.includes('--print-access-token')){console.error('The access token is only shown on first startup or rotation.');process.exit(1)}
await server.start();console.log(`Remote Pi listening on http://${value('--host','127.0.0.1')}:${server.address()?.port}`);
const shutdown=async()=>{await server.stop();process.exit(0)};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
