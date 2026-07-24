#!/usr/bin/env node
import {RemotePiServer} from './server.js';
import {VoiceManager,type VoiceConfig} from './voice.js';
import {MailNotifier} from './mail-notifier.js';
import pkg from '../package.json' with {type:'json'};

const args=process.argv.slice(2);
const value=(name:string,fallback:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]??fallback:fallback};
const envSecret=(flag:string)=>{const name=value(flag,'').trim();if(!name)return undefined;const result=process.env[name];if(!result){console.error(`${flag} references missing environment variable ${name}`);process.exit(1)}return result};
if(args.includes('--help')||args.includes('-h')){
  console.log(`remote-pi ${pkg.version}\n\nUsage: remote-pi [options]\n\nOptions:\n  --host <address>                    Listen address (default: 127.0.0.1)\n  --port <number>                     Listen port (default: 11318)\n  --data-dir <path>                   Metadata directory (default: ~/.pi/remote-pi)\n  --maildispatch-endpoint <url>       MailDispatch message API endpoint\n  --maildispatch-api-key-env <name>   Environment variable containing the MailDispatch API key\n  --maildispatch-notify-to <email>    Email address notified when an Agent task settles\n  --maildispatch-sender-id <id>       Optional MailDispatch sender ID\n  --voice-base-url <url>              OpenAI-compatible TTS endpoint, e.g. Speaches or openai-edge-tts\n  --voice-stt-model <id>              Optional speech-to-text model ID; omit for TTS-only mode\n  --voice-tts-model <id>              Text-to-speech model ID\n  --voice-tts-voice <id>              TTS voice ID\n  --voice-tts-format <pcm|mp3>         TTS response format (default: pcm)\n  --voice-api-key-env <name>          Environment variable containing the speech API key\n  --voice-summary-base-url <url>      OpenAI-compatible summary LLM endpoint\n  --voice-summary-model <id>          Summary LLM model ID\n  --voice-summary-api-key-env <name>  Environment variable containing the summary API key\n  --voice-language <tag>              Spoken summary language (default: zh-CN)\n  --rotate-access-token               Generate a new pairing code and exit\n  --version                           Print version\n  -h, --help                          Show help\n\nMail notifications require endpoint, API-key environment variable, and recipient. Voice is disabled unless --voice-base-url is set. The Web UI is served at the same address. Its pairing code must be entered manually; the browser asks before saving it locally.`);
  process.exit(0);
}
if(args.includes('--version')||args.includes('-v')){console.log(pkg.version);process.exit(0)}
const host=value('--host','127.0.0.1'),port=Number(value('--port','11318'));
if(!Number.isInteger(port)||port<0||port>65535){console.error('Invalid --port');process.exit(1)}
const voiceBaseUrl=value('--voice-base-url','');let voice:VoiceManager|undefined;
if(voiceBaseUrl){
  const required=(name:string)=>{const result=value(name,'').trim();if(!result){console.error(`${name} is required when voice is enabled`);process.exit(1)}return result};
  const ttsFormat=value('--voice-tts-format','pcm').trim();if(ttsFormat!=='pcm'&&ttsFormat!=='mp3'){console.error('--voice-tts-format must be pcm or mp3');process.exit(1)}
  const config:VoiceConfig={speechBaseUrl:voiceBaseUrl,sttModel:value('--voice-stt-model','').trim()||undefined,ttsModel:required('--voice-tts-model'),ttsVoice:required('--voice-tts-voice'),ttsFormat,speechApiKey:envSecret('--voice-api-key-env'),summaryBaseUrl:required('--voice-summary-base-url'),summaryModel:required('--voice-summary-model'),summaryApiKey:envSecret('--voice-summary-api-key-env'),language:value('--voice-language','zh-CN')};
  voice=new VoiceManager(config);
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
const server=new RemotePiServer({host,port,dataDir:value('--data-dir',process.env.PI_REMOTE_DIR??`${process.env.HOME??'.'}/.pi/remote-pi`),voice,mailNotifier});
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
