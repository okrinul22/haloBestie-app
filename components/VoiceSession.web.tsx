import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { VoiceSessionProps } from './voice.types';
import type { VoicePoll, VoiceSignal } from '../shared/types';
const uuid=()=>crypto.randomUUID();
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export default function VoiceSession({bookingId,role,ends,serverNow,request,onReady}:VoiceSessionProps) {
  const [status,setStatus]=useState('Microphone not connected');
  const [enabled,setEnabled]=useState(false);
  const [muted,setMuted]=useState(false);
  const [error,setError]=useState('');
  const [starting,setStarting]=useState(false);
  const [playBlocked,setPlayBlocked]=useState(false);
  const peer=useRef<RTCPeerConnection|null>(null);
  const stream=useRef<MediaStream|null>(null);
  const audio=useRef<HTMLAudioElement|null>(null);
  const call=useRef<string|null>(null);
  const cursor=useRef(0);
  const pendingIce=useRef<RTCIceCandidateInit[]>([]);
  const outbound=useRef<RTCIceCandidateInit[]>([]);
  const published=useRef(false);
  const alive=useRef(true);
  const busy=useRef(false);
  const connecting=useRef(false);
  const callbacks=useRef({request,onReady});callbacks.current={request,onReady};
  const base='/bookings/'+bookingId;
  const expired=ends!==null&&serverNow>=ends;
  const deadline=useRef(ends);deadline.current=ends;
  const serverOffset=useRef(serverNow-Date.now());serverOffset.current=serverNow-Date.now();

  function stopPeer() {
    if(peer.current) {peer.current.onconnectionstatechange=null;peer.current.ontrack=null;peer.current.onicecandidate=null;peer.current.close();peer.current=null;}
    if(audio.current){audio.current.pause();audio.current.srcObject=null;}
    pendingIce.current=[];outbound.current=[];published.current=false;
  }
  function stopAll() {stopPeer();stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;}
  function valid() {return alive.current&&(deadline.current===null||Date.now()+serverOffset.current<deadline.current);}
  async function send(signal:VoiceSignal) {
    let last:unknown;
    for(let i=0;i<3;i++) {
      if(!valid()) throw new Error('Session time has ended');
      try {await callbacks.current.request(base+'/voice/signals',signal);return;}catch(e){last=e;if(i<2)await delay(300);}
    }
    throw last;
  }
  async function sendIce(candidate:RTCIceCandidateInit) {
    if(!call.current||!valid())return;
    await send({id:uuid(),callId:call.current,kind:'ice',payload:{candidate:candidate.candidate!,sdpMid:candidate.sdpMid??null,sdpMLineIndex:candidate.sdpMLineIndex??null,usernameFragment:candidate.usernameFragment}});
  }
  async function flushOutbound() {published.current=true;for(const candidate of outbound.current.splice(0)) await sendIce(candidate);}
  async function flushRemote(pc:RTCPeerConnection) {if(pc.remoteDescription)for(const candidate of pendingIce.current.splice(0))await pc.addIceCandidate(candidate);}
  function createPeer() {
    stopPeer();
    const pc=new RTCPeerConnection({iceServers:[]});peer.current=pc;
    stream.current!.getTracks().forEach(track=>pc.addTrack(track,stream.current!));
    pc.onicecandidate=event=>{
      if(!event.candidate)return;
      const candidate=event.candidate.toJSON();
      if(!published.current)outbound.current.push(candidate);
      else void sendIce(candidate).catch(()=>{if(alive.current)setError('Connection negotiation failed. Try reconnecting.');});
    };
    pc.ontrack=event=>{
      const remote=event.streams[0]??new MediaStream([event.track]);
      if(!audio.current)audio.current=new Audio();
      audio.current.autoplay=true;audio.current.srcObject=remote;
      void audio.current.play().catch(()=>{if(alive.current)setPlayBlocked(true);});
    };
    pc.onconnectionstatechange=()=>{
      if(peer.current!==pc||!valid())return;
      if(pc.connectionState==='connected') {
        setStatus('Voice connected');setError('');
        void callbacks.current.request(base+'/voice/presence',{callId:call.current,connected:true})
          .then(()=>callbacks.current.request(base+'/ready',{})).then(()=>callbacks.current.onReady())
          .catch(e=>{if(alive.current)setError(e instanceof Error?e.message:'Unable to start session');});
      } else if(['disconnected','failed'].includes(pc.connectionState)) {
        setStatus('Voice disconnected');
        void callbacks.current.request(base+'/voice/presence',{callId:call.current,connected:false}).catch(()=>{});
        setError('The voice connection was lost. Reconnect on both apps within 60 seconds.');
      } else setStatus('Connecting voice…');
    };
    return pc;
  }
  async function start() {
    if(connecting.current||!valid())return;
    connecting.current=true;setStarting(true);setError('');
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access requires localhost or HTTPS in a supported browser.');
      if(!stream.current)stream.current=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      if(!valid()){stopAll();return;}
      stream.current.getAudioTracks().forEach(track=>{track.enabled=!muted;});
      cursor.current=0;setEnabled(true);setStatus('Waiting for the other microphone…');
      if(role==='customer') {
        const pc=createPeer();call.current=uuid();
        const offer=await pc.createOffer();await pc.setLocalDescription(offer);
        await send({id:uuid(),callId:call.current,kind:'offer',payload:{type:'offer',sdp:offer.sdp!}});
        await flushOutbound();
      } else {stopPeer();call.current=null;}
    } catch(e) {stopAll();setEnabled(false);if(alive.current)setError(e instanceof Error?e.message:'Allow microphone access to join the voice session.');}
    finally {connecting.current=false;if(alive.current)setStarting(false);}
  }
  useEffect(()=>{
    alive.current=true;
    return ()=>{alive.current=false;stopAll();};
  },[bookingId]);
  useEffect(()=>{
    if(expired){stopAll();setEnabled(false);setStatus('Session time ended · microphone disconnected');}
  },[expired]);
  useEffect(()=>{
    if(!enabled||expired)return;
    let cancelled=false;
    const poll=async()=>{
      if(busy.current||!valid())return;busy.current=true;
      try {
        const result=await callbacks.current.request<VoicePoll>(base+'/voice/signals?after='+cursor.current);
        if(cancelled||!valid())return;
        for(const signal of result.signals) {
          if(signal.kind==='offer'&&role==='bestie') {
            if(call.current!==signal.callId) {
              call.current=signal.callId;const pc=createPeer();
              await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
              const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
              await send({id:uuid(),callId:signal.callId,kind:'answer',payload:{type:'answer',sdp:answer.sdp!}});
              await flushOutbound();await flushRemote(pc);
            }
          } else if(signal.callId===call.current&&signal.kind==='answer'&&role==='customer'&&peer.current&&!peer.current.remoteDescription) {
            await peer.current.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);await flushRemote(peer.current);
          } else if(signal.callId===call.current&&signal.kind==='ice') {
            const candidate=signal.payload as RTCIceCandidateInit;
            if(peer.current?.remoteDescription)await peer.current.addIceCandidate(candidate);else pendingIce.current.push(candidate);
          }
        }
        cursor.current=result.cursor;
      } catch(e) {if(!cancelled&&alive.current)setError(e instanceof Error?e.message:'Voice signaling unavailable.');}
      finally {busy.current=false;}
    };
    void poll();const interval=setInterval(()=>void poll(),700);
    const presence=setInterval(()=>{
      if(valid()&&peer.current?.connectionState==='connected')void callbacks.current.request(base+'/voice/presence',{callId:call.current,connected:true}).catch(()=>{});
    },2000);
    return ()=>{cancelled=true;clearInterval(interval);clearInterval(presence);};
  },[enabled,expired]);
  function toggleMute() {const value=!muted;stream.current?.getAudioTracks().forEach(track=>{track.enabled=!value;});setMuted(value);}
  return <View style={styles.card}>
    <Text style={styles.title}>Voice session</Text><Text accessibilityLiveRegion="polite" style={styles.text}>{status}</Text>
    <Text style={styles.text}>Allow microphone access on both apps. The paid timer starts when both voice connections are ready.</Text>
    {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Pressable accessibilityRole="button" disabled={starting||expired} onPress={()=>void start()} style={styles.button}><Text style={styles.buttonText}>{starting?'Opening microphone…':enabled?'Reconnect voice':'Connect microphone'}</Text></Pressable>
    {enabled&&<Pressable accessibilityRole="button" onPress={toggleMute} style={styles.secondary}><Text style={styles.text}>{muted?'Unmute microphone':'Mute microphone'}</Text></Pressable>}
    {playBlocked&&<Pressable accessibilityRole="button" style={styles.secondary} onPress={()=>void audio.current?.play().then(()=>setPlayBlocked(false)).catch(()=>setError('Your browser blocked audio. Allow sound for this site.'))}><Text style={styles.text}>Enable speaker audio</Text></Pressable>}
  </View>;
}
const styles=StyleSheet.create({card:{padding:18,borderRadius:16,backgroundColor:'#edf6f0',gap:12},title:{fontSize:20,fontWeight:'700',color:'#24483e'},text:{fontSize:14,lineHeight:22,color:'#355e50'},error:{fontSize:14,color:'#a03b38'},button:{backgroundColor:'#276e5e',padding:14,borderRadius:12,alignItems:'center'},buttonText:{color:'#fff',fontWeight:'700',fontSize:15},secondary:{padding:12,borderRadius:12,backgroundColor:'#dceae1',alignItems:'center'}});
