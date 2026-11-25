import type { Role } from '../shared/types';
export interface VoiceSessionProps {
  bookingId:string;role:Role;ends:number|null;serverNow:number;
  request:<T>(path:string,data?:unknown)=>Promise<T>;
  onReady:()=>void;
}
