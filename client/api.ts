import { Platform } from 'react-native';
import type { Role } from '../shared/types';
export const role:Role=process.env.EXPO_PUBLIC_APP_ROLE==='bestie'?'bestie':'customer';
export const API=process.env.EXPO_PUBLIC_API_URL||'http://localhost:3001';
let memoryToken:string|undefined;
let unauthorized:(()=>void)|undefined;
export function setSessionToken(token?:string){memoryToken=token;}
export function onUnauthorized(handler?:()=>void){unauthorized=handler;}
export class APIError extends Error {constructor(message:string,public status:number){super(message);}}
export async function request<T>(path:string,data?:unknown):Promise<T> {
  const endpoint=['/auth/login','/auth/register'].includes(path)?path:'/api'+path;
  const response=await fetch(API+endpoint,{method:data===undefined?'GET':'POST',credentials:'include',
    headers:{'Content-Type':'application/json','X-App-Role':role,'X-Client-Platform':Platform.OS==='web'?'web':'native',...(memoryToken?{Authorization:'Bearer '+memoryToken}:{})},
    body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  if(!response.ok){if(response.status===401&&!path.startsWith('/auth/')){memoryToken=undefined;unauthorized?.();}throw new APIError(result.error||'Request failed',response.status);}
  return result;
}
