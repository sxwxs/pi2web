#!/usr/bin/env node
import path from 'node:path';
import {homedir} from 'node:os';
import {RemotePiServer} from './server.js';
import {VoiceManager,type VoiceConfig} from './voice.js';
import {SessionNamer,DEFAULT_SESSION_NAMER} from './session-namer.js';
import {MailNotifier} from './mail-notifier.js';
import pkg from '../package.json' with {type:'json'};

const args=process.argv.slice(2);
const value=(name:string,fallback:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]??fallback:fallback};
const envSecret=(flag:string)=>{const name=value(flag,'').trim();if(!name)return undefined;const result=process.env[name];if(!result){console.error(`${flag} references missing environment variable ${name}`);process.exit(1)}return result};
if(args.includes('--help')||args.includes('-h')){
  console.log(`pi2web ${pkg.version}\n\nUsage: pi2web [options]\n\nOptions:\n  --host <address>                    Listen address (default: 127.0.0.1)\n  --port <number>                     Listen port (default: 11318)\n  --data-dir <path>                   Metadata directory (default: ~/.pi/remote-pi)\n  --maildispatch-endpoint <url>       MailDispatch message API endpoint\n  --maildispatch-api-key-env <name>   Environment variable containing the MailDispatch API key\n  --maildispatch-notify-to <email>    Email address notified when an Agent task settles\n  --maildispatch-sender-id <id>       Optional MailDispatch sender ID\n  --voice-base-url <url>              OpenAI-compatible TTS endpoint, e.g. Speaches or openai-edge-tts\n  --voice-stt-model <id>              Optional speech-to-text model ID; omit for TTS-only mode\n  --voice-tts-model <id>              Text-to-speech model ID\n  --voice-tts-voice <id>              TTS voice ID\n  --voice-tts-format <pcm|mp3>         TTS response format (default: pcm)\n  --voice-api-key-env <name>          Environment variable containing the speech API key\n  --voice-summary-base-url <url>      OpenAI-compatible summary LLM endpoint\n  --voice-summary-model <id>          Summary LLM model ID\n  --voice-summary-api-key-env <name>  Environment variable containing the summary API key\n  --voice-language <tag>              Spoken summary language (default: zh-CN)\n  --voice-request-timeout <ms>        Speech and summary request timeout (default: 120000)\n  --session-naming <on|off>           Automatic session naming (default: on)\n  --session-name-base-url <url>       OpenAI-compatible naming LLM endpoint (default: ${DEFAULT_SESSION_NAMER.baseUrl})\n  --session-name-model <id>           Naming LLM model ID (default: ${DEFAULT_SESSION_NAMER.model})\n  --session-name-api-key-env <name>   Environment variable containing the naming API key (default: none)\n  --session-name-language <tag>       Session name language (default: zh-CN)\n  --session-name-request-timeout <ms> Naming request timeout (default: 60000)\n  --session-name-max-output-tokens <n> Naming output token budget (default: ${DEFAULT_SESSION_NAMER.maxOutputTokens})\n  --rotate-access-token               Generate a new pairing code and exit
  --set-access-token <token>          Set a specific pairing code and exit
  --set-access-token-env <name>       Set the pairing code from an environment variable and exit
  --no-auth                           Disable token auth (loopback bind only; for trusted local/tunnel setups)\n  --version                           Print version\n  -h, --help                          Show help\n\nMail notifications require endpoint, API-key environment variable, and recipient. Voice is disabled unless --voice-base-url is set. Automatic session naming is independent of voice and on by default; disable it with --session-naming off. The Web UI is served at the same address. Its pairing code must be entered manually; the browser asks before saving it locally.`);
  process.exit(0);
}
if(args.includes('--version')||args.includes('-v')){console.log(pkg.version);process.exit(0)}
const host=value('--host','127.0.0.1'),port=Number(value('--port','11318'));
if(!Number.isInteger(port)||port<0||port>65535){console.error('Invalid --port');process.exit(1)}
const noAuth=args.includes('--no-auth');
if(noAuth&&!['127.0.0.1','::1','localhost'].includes(host.trim())){console.error('--no-auth requires --host 127.0.0.1, ::1 or localhost; a pairing code is required for any other bind address');process.exit(1)}
const voiceBaseUrl=value('--voice-base-url','');let voice:VoiceManager|undefined;
if(voiceBaseUrl){
  const required=(name:string)=>{const result=value(name,'').trim();if(!result){console.error(`${name} is required when voice is enabled`);process.exit(1)}return result};
  const ttsFormat=value('--voice-tts-format','pcm').trim();if(ttsFormat!=='pcm'&&ttsFormat!=='mp3'){console.error('--voice-tts-format must be pcm or mp3');process.exit(1)}
  const requestTimeoutMs=Number(value('--voice-request-timeout','120000'));if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1000){console.error('--voice-request-timeout must be an integer of at least 1000 milliseconds');process.exit(1)}
  const config:VoiceConfig={speechBaseUrl:voiceBaseUrl,sttModel:value('--voice-stt-model','').trim()||undefined,ttsModel:required('--voice-tts-model'),ttsVoice:required('--voice-tts-voice'),ttsFormat,speechApiKey:envSecret('--voice-api-key-env'),summaryBaseUrl:required('--voice-summary-base-url'),summaryModel:required('--voice-summary-model'),summaryApiKey:envSecret('--voice-summary-api-key-env'),language:value('--voice-language','zh-CN'),requestTimeoutMs};
  voice=new VoiceManager(config);
}
const namingMode=value('--session-naming','on').trim().toLowerCase();
if(!['on','off'].includes(namingMode)){console.error('--session-naming must be on or off');process.exit(1)}
let sessionNamer:SessionNamer|undefined;
if(namingMode==='on'){
  const namingTimeoutMs=Number(value('--session-name-request-timeout',String(DEFAULT_SESSION_NAMER.requestTimeoutMs)));
  if(!Number.isInteger(namingTimeoutMs)||namingTimeoutMs<1000){console.error('--session-name-request-timeout must be an integer of at least 1000 milliseconds');process.exit(1)}
  const namingMaxTokens=Number(value('--session-name-max-output-tokens',String(DEFAULT_SESSION_NAMER.maxOutputTokens)));
  if(!Number.isInteger(namingMaxTokens)||namingMaxTokens<16){console.error('--session-name-max-output-tokens must be an integer of at least 16');process.exit(1)}
  sessionNamer=new SessionNamer({
    baseUrl:value('--session-name-base-url',DEFAULT_SESSION_NAMER.baseUrl).trim()||DEFAULT_SESSION_NAMER.baseUrl,
    model:value('--session-name-model',DEFAULT_SESSION_NAMER.model).trim()||DEFAULT_SESSION_NAMER.model,
    apiKey:envSecret('--session-name-api-key-env'),
    language:value('--session-name-language',DEFAULT_SESSION_NAMER.language),
    requestTimeoutMs:namingTimeoutMs,
    maxOutputTokens:namingMaxTokens
  });
}
const mailEndpoint=value('--maildispatch-endpoint','').trim(),mailKeyEnv=value('--maildispatch-api-key-env','').trim(),mailRecipient=value('--maildispatch-notify-to','').trim();
const mailParts=[mailEndpoint,mailKeyEnv,mailRecipient].filter(Boolean).length;
if(mailParts>0&&mailParts<3){console.error('--maildispatch-endpoint, --maildispatch-api-key-env, and --maildispatch-notify-to must be configured together');process.exit(1)}
let mailNotifier:MailNotifier|undefined;
if(mailParts===3){
  let endpoint:URL;try{endpoint=new URL(mailEndpoint)}catch{console.error('--maildispatch-endpoint must be a valid URL');process.exit(1)}
  if(!['http:','https:'].includes(endpoint.protocol)){console.error('--maildispatch-endpoint must use http or https');process.exit(1)}
  mailNotifier=new MailNotifier({endpoint:endpoint.toString(),apiKey:envSecret('--maildispatch-api-key-env')!,recipient:mailRecipient,senderId:value('--maildispatch-sender-id','').trim()||undefined});
}
const server=new RemotePiServer({host,port,noAuth,dataDir:value('--data-dir',process.env.PI_REMOTE_DIR??path.join(homedir(),'.pi','remote-pi')),voice,sessionNamer,mailNotifier});
if(args.includes('--rotate-access-token')){await server.auth.init();console.log(await server.auth.rotate());process.exit(0)}
if(args.includes('--set-access-token')||args.includes('--set-access-token-env')){
  const fromEnv=args.includes('--set-access-token-env'),flag=fromEnv?'--set-access-token-env':'--set-access-token';
  let token=value(flag,'');
  if(!token){console.error(`${flag} requires a value`);process.exit(1)}
  if(fromEnv){const name=token;token=process.env[name]??'';if(!token){console.error(`${flag} references missing or empty environment variable ${name}`);process.exit(1)}}
  await server.auth.init();
  try{await server.auth.setToken(token);console.log('Pairing code updated. Use it to pair Web UI clients.')}catch(error){console.error((error as Error).message);process.exit(1)}
  process.exit(0)
}
if(args.includes('--print-access-token')){console.error('The pairing code is only shown on first startup or rotation.');process.exit(1)}
try{
  await server.start();
  const address=server.address();
  console.log(`Remote Pi is ready: http://${host}:${address?.port ?? port}`);
  console.log(noAuth ? 'Auth is disabled. Anyone who can reach this address can control the agents.' : 'Open this URL and enter the pairing code manually.');
}catch(error){console.error(`Failed to start Remote Pi: ${(error as Error).message}`);process.exit(1)}
const shutdown=async()=>{await server.stop();process.exit(0)};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
