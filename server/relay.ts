import {createHash,createHmac} from 'node:crypto';
import type {VoiceConfiguration} from '../shared/types';
export function relayConfiguration(userId:string,bookingId:string,env:Record<string,string|undefined>=process.env,now=Date.now()):VoiceConfiguration {
  const urls:string[]=(env.TURN_URLS??'').split(',').map((v:string)=>v.trim()).filter(Boolean);
  if(!urls.length&&!env.TURN_SECRET)return {iceServers:[],relayConfigured:false,iceTransportPolicy:'all'};
  if(!urls.length||!env.TURN_SECRET||urls.some(url=>!/^turns?:[^\s]+$/.test(url)))throw new Error('Set valid TURN_URLS and TURN_SECRET together');
  const expires=Math.floor(now/1000)+7200;
  const anonymous=createHash('sha256').update(userId+':'+bookingId).digest('hex').slice(0,16);
  const username=expires+':'+anonymous;
  const credential=createHmac('sha1',env.TURN_SECRET).update(username).digest('base64');
  return {iceServers:[{urls,username,credential}],relayConfigured:true,iceTransportPolicy:env.VOICE_FORCE_RELAY==='true'?'relay':'all'};
}
