import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { Extension, Role, Service, Snapshot } from './shared/types';
import { PRICES } from './shared/types';

const role: Role = process.env.EXPO_PUBLIC_APP_ROLE === 'bestie' ? 'bestie' : 'customer';
const API = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const token = role === 'customer' ? process.env.EXPO_PUBLIC_CUSTOMER_TOKEN || 'demo-customer' : process.env.EXPO_PUBLIC_BESTIE_TOKEN || 'demo-bestie';
const money = (n: number) => 'Rp' + n.toLocaleString('id-ID');
const clock = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; };
async function request<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(API + '/api' + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type':'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if(!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function Button({ title, onPress, secondary, disabled }: { title:string; onPress:()=>void; secondary?:boolean; disabled?:boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{disabled:!!disabled}} disabled={disabled} onPress={onPress}
    style={({pressed}) => [styles.button, secondary && styles.secondary, (pressed || disabled) && {opacity:0.55}]}>
    <Text style={[styles.buttonText, secondary && {color:'#235953'}]}>{title}</Text>
  </Pressable>;
}
export default function App() {
  const [state,setState]=useState<Snapshot | null>(null);
  const [service,setService]=useState<Service>('text');
  const [minutes,setMinutes]=useState<10|30>(10);
  const [error,setError]=useState('');
  const [connection,setConnection]=useState('');
  const [busy,setBusy]=useState(false);
  const [body,setBody]=useState('');
  const [now,setNow]=useState(Date.now());
  const offset=useRef(0);
  const working=useRef(false);
  const pendingMessage=useRef<{id:string;body:string}|null>(null);
  const scroll=useRef<React.ComponentRef<typeof ScrollView>>(null);
  const mounted=useRef(true);
  async function refresh() {
    const result=await request<Snapshot>('/state');
    if(!mounted.current) return;
    offset.current=result.serverNow-Date.now();
    setState(result); setConnection('');
  }
  useEffect(() => {
    mounted.current=true;
    let polling=false;
    const poll=async () => {
      if(polling) return;
      polling=true;
      try {
        // The Bestie snapshot renews its heartbeat after checking for timeouts.
        await refresh();
      } catch { if(mounted.current) setConnection('Cannot reach the demo server. Retrying…'); }
      finally { polling=false; }
    };
    void poll();
    const timer=setInterval(() => void poll(),1500);
    const tick=setInterval(() => setNow(Date.now()),500);
    return () => { mounted.current=false; clearInterval(timer); clearInterval(tick); };
  },[]);
  async function act(fn:()=>Promise<unknown>) {
    if(working.current) return;
    working.current=true; setBusy(true); setError('');
    try { await fn(); await refresh(); }
    catch(e) { setError(e instanceof Error ? e.message : 'Please retry.'); }
    finally { working.current=false; setBusy(false); }
  }
  const b=state?.booking;
  const closed=!!b && ['ended','cancelled'].includes(b.status);
  const endpoint='/bookings/'+b?.id;
  const ready=role === 'customer' ? b?.customerReady : b?.bestieReady;
  const pending=state?.extensions.find(e=>e.status==='pending' || e.status==='failed');
  const serverNow=now+offset.current;
  async function payExtension(e:Extension,outcome:'success'|'failure') { await request(endpoint+'/extensions/'+e.id+'/pay',{outcome}); }
  async function send() {
    const clean=body.trim();
    if(!clean) return;
    if(!pendingMessage.current || pendingMessage.current.body!==clean) {
      // UUID generated locally makes a retry safe when a response is lost.
      const id='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return (c==='x'?r:(r&3|8)).toString(16);});
      pendingMessage.current={id,body:clean};
    }
    await request(endpoint+'/messages',pendingMessage.current);
    pendingMessage.current=null; setBody('');
  }
  return <SafeAreaView style={styles.safe}><StatusBar style="dark"/><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <View style={styles.header}><View><Text style={styles.logo}>halo<Text style={{color:'#2a8273'}}>bestie</Text><Text style={styles.logoDot}> ✳</Text></Text><Text style={styles.caption}>A little space to feel heard.</Text></View><View style={styles.role}><Text style={styles.roleText}>{role === 'customer' ? 'CUSTOMER' : 'BESTIE'}</Text></View></View>
    <View style={styles.banner}><Text style={styles.bannerText}>DEMO ONLY · No real charges · Text conversations only</Text></View>
    {connection ? <Text accessibilityRole="alert" style={styles.error}>{connection} Check {API}.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!state ? <View style={styles.card}><ActivityIndicator color="#277c6e"/><Text style={styles.muted}>Connecting to your space…</Text></View> : <>
      <View style={styles.intro}><Text style={styles.eyebrow}>{role === 'customer' ? 'YOUR SPACE, YOUR PACE' : 'LISTENER WORKSPACE'}</Text><Text style={styles.title}>{role === 'customer' ? 'Someone to talk to.\nA moment for you.' : 'Be here for\nsomeone today.'}</Text><Text style={styles.description}>{role === 'customer' ? 'You can stay anonymous. Your Bestie sees only your nickname: Moonlight.' : 'One person. Your full attention. Go online when you’re ready to listen.'}</Text></View>
      {role === 'bestie' && <View style={styles.card}><View style={styles.row}><View style={styles.grow}><Text style={styles.cardTitle}>{state.online ? 'You’re available' : 'You’re offline'}</Text><Text style={styles.muted}>{state.online ? 'Keep this app open to stay connected.' : 'Go online to accept a session.'}</Text></View><Text style={styles.pill}>{state.online?'ONLINE':'OFFLINE'}</Text></View><Button title={state.online?'Go offline':'Go online'} disabled={busy || !!b && ['connecting','active'].includes(b.status)} onPress={()=>void act(()=>request('/availability',{online:!state.online}))}/></View>}
      {role === 'customer' && (!b || closed) && <View style={styles.card}>
        <Text style={styles.cardTitle}>Choose your space</Text><View style={styles.row}>{(['text','voice'] as Service[]).map(s=><Pressable accessibilityRole="radio" accessibilityState={{checked:service===s}} key={s} onPress={()=>setService(s)} style={[styles.choice,service===s&&styles.selected]}><Text style={styles.choiceTitle}>{s==='text'?'✎  Text chat':'◉  Voice booking'}</Text><Text style={styles.muted}>{s==='text'?'Find your words':'Preview only'}</Text></Pressable>)}</View>
        {service==='voice'&&<Text style={styles.note}>Voice booking is a placeholder. Live audio is not included; the demo uses text chat.</Text>}
        <Text style={styles.label}>How much time would you like?</Text><View style={styles.row}>{([10,30] as const).map(m=><Pressable key={m} accessibilityRole="radio" accessibilityState={{checked:minutes===m}} onPress={()=>setMinutes(m)} style={[styles.choice,minutes===m&&styles.selected]}><Text style={styles.choiceTitle}>{m} minutes</Text><Text style={styles.muted}>{money(PRICES[service][m])}</Text></Pressable>)}</View>
        <Text style={styles.note}>{state.online?'A Bestie is online. Acceptance is still required.':'No Bestie online. You can test the 30-second refund flow.'}</Text><Button title={'Continue · '+money(PRICES[service][minutes])} disabled={busy} onPress={()=>void act(()=>request('/bookings',{service,minutes}))}/>
        <Text style={styles.footnote}>No acceptance in 30 seconds? Full simulated refund. Customer disconnects do not pause an active session.</Text>
      </View>}
      {b && <View style={styles.card}>
        <View style={styles.row}><Text style={[styles.cardTitle,styles.grow]}>{b.status==='unpaid'?'Your booking':b.status==='matching'?'Finding your Bestie':b.status==='connecting'?'A little hello':b.status==='active'?'Your shared space':b.status==='cancelled'?'Booking cancelled':'Session complete'}</Text><Text style={styles.pill}>{b.status.toUpperCase()}</Text></View>
        <Text style={styles.muted}>{b.service==='voice'?'Voice preview (text only)':'Text chat'} · {b.minutes} minutes · {money(b.price)}{role==='bestie'?' · '+b.nickname:''}</Text>
        {b.status==='unpaid' && role==='customer' && <><Text style={styles.note}>Demo payment — no real charge. Choose an outcome to test checkout.</Text>{b.payment==='failed'&&<Text style={styles.error}>Payment failed. You have not been charged. Retry below.</Text>}<Button title={'Simulate successful payment · '+money(b.price)} disabled={busy} onPress={()=>void act(()=>request(endpoint+'/pay',{outcome:'success'}))}/><Button title="Simulate failed payment" secondary disabled={busy} onPress={()=>void act(()=>request(endpoint+'/pay',{outcome:'failure'}))}/></>}
        {b.status==='matching'&&<><Text style={styles.timer}>{clock((b.deadline||serverNow)-serverNow)}</Text><Text style={styles.muted}>{role==='customer'?'Payment confirmed (demo). Waiting for a Bestie to accept.':'Moonlight is waiting for a listener.'}</Text>{role==='bestie'&&<Button title="Accept session" disabled={busy||!state.online} onPress={()=>void act(()=>request(endpoint+'/accept',{}))}/>}</>}
        {b.status==='connecting'&&<><Text style={styles.note}>Both participants must be ready before paid time starts. Connection window: {clock((b.deadline||serverNow)-serverNow)}.</Text><Text style={styles.muted}>Customer {b.customerReady?'ready':'waiting'} · Bestie {b.bestieReady?'ready':'waiting'}</Text><Button title={ready?'You’re ready · waiting for the other person':'I’m ready to start'} disabled={busy||!!ready} onPress={()=>void act(()=>request(endpoint+'/ready',{}))}/></>}
        {role==='customer'&&['unpaid','matching'].includes(b.status)&&<Button title="Cancel booking" secondary disabled={busy} onPress={()=>void act(()=>request(endpoint+'/cancel',{}))}/>}
        {b.status==='active'&&<><View style={styles.timerBox}><Text style={styles.eyebrow}>TIME TOGETHER</Text><Text style={styles.timer}>{clock((b.ends||serverNow)-serverNow)}</Text><Text style={styles.muted}>Server-controlled · closes automatically</Text></View>{b.service==='voice'&&<Text style={styles.note}>Live voice is not connected. Use text below to demonstrate the session.</Text>}</>}
        {(b.status==='active'||closed)&&<><ScrollView ref={scroll} style={styles.messages} onContentSizeChange={()=>scroll.current?.scrollToEnd({animated:true})} contentContainerStyle={{padding:12,gap:10}}>
          {!state.messages.length&&<Text style={styles.empty}>{closed?'No messages in this session.':'Take your time. A simple hello is enough.'}</Text>}
          {state.messages.map(m=><View key={m.id} style={[styles.bubble,m.role===role?styles.ownBubble:styles.otherBubble]}><Text style={styles.sender}>{m.role==='bestie'?'Bestie':b.nickname}</Text><Text style={styles.messageText}>{m.body}</Text></View>)}
        </ScrollView>{b.status==='active'&&<View style={styles.composer}><TextInput accessibilityLabel="Message" placeholder="Write what’s on your mind…" value={body} onChangeText={setBody} maxLength={2000} style={styles.input} multiline/><Button title="Send" disabled={busy||!body.trim()||serverNow>=(b.ends||0)} onPress={()=>void act(send)}/></View>}</>}
        {b.status==='active'&&role==='customer'&&!pending&&<Button title={'Add 10 minutes · '+money(PRICES[b.service][10])+' (demo)'} secondary disabled={busy||!state.online} onPress={()=>void act(()=>request(endpoint+'/extensions',{}))}/>}
        {role==='customer'&&pending&&<View style={styles.extension}><Text style={styles.cardTitle}>10 more minutes · {money(pending.price)}</Text><Text style={styles.note}>Demo payment — no real charge. If the session has ended, a successful late payment is refunded.</Text>{pending.status==='failed'&&<Text style={styles.error}>Extension payment failed. No time was added.</Text>}<Button title="Simulate extension success" disabled={busy} onPress={()=>void act(()=>payExtension(pending,'success'))}/><Button title="Simulate extension failure" secondary disabled={busy} onPress={()=>void act(()=>payExtension(pending,'failure'))}/></View>}
        {state.extensions.filter(e=>e.status==='applied'||e.status==='simulated_refunded').map(e=><Text key={e.id} style={styles.note}>{e.status==='applied'?'+10 minutes added':'Late extension refunded (demo)'} · {money(e.price)}</Text>)}
        {closed&&<><Text style={styles.note}>{b.reason||'Your time together has ended. Thank you for showing up.'}</Text>{b.refund>0&&<Text style={styles.refund}>Simulated refund complete · {money(b.refund)}{b.payment==='paid'?' (unused session time)':''}</Text>}</>}
      </View>}
      {role==='bestie'&&(!b||closed)&&<View style={styles.card}><Text style={styles.cardTitle}>Ready when they are</Text><Text style={styles.description}>Waiting bookings appear here automatically. Open the Customer app to try the complete flow.</Text></View>}
      <Text style={styles.footer}>A one-day HaloBestie prototype. Seeded identities only. Not a production service or emergency support.</Text>
    </>}
    {busy&&<Text style={styles.muted}>Saving…</Text>}
  </ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({
  safe:{flex:1,backgroundColor:'#f3f7f5'},page:{padding:24,paddingTop:Platform.OS==='web'?36:16,maxWidth:700,width:'100%',alignSelf:'center',gap:20,paddingBottom:60},
  header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},logo:{fontSize:29,fontWeight:'800',letterSpacing:-1.2,color:'#183d37'},logoDot:{color:'#db936b'},caption:{fontSize:13,color:'#647872',marginTop:3},role:{backgroundColor:'#e1ece6',paddingVertical:8,paddingHorizontal:12,borderRadius:20},roleText:{fontSize:11,fontWeight:'800',letterSpacing:1,color:'#285b4b'},
  banner:{padding:12,borderRadius:12,backgroundColor:'#fff0d9'},bannerText:{fontSize:12,color:'#74582c',textAlign:'center',fontWeight:'600'},intro:{paddingVertical:12,gap:13},eyebrow:{fontSize:11,letterSpacing:2,fontWeight:'700',color:'#467b6c'},title:{fontSize:38,lineHeight:44,fontWeight:'700',letterSpacing:-1.4,color:'#183d37'},description:{fontSize:16,lineHeight:25,color:'#62766e'},
  card:{backgroundColor:'#ffffff',padding:24,borderRadius:24,gap:16,borderWidth:1,borderColor:'#e0e9e3'},cardTitle:{fontSize:20,fontWeight:'700',color:'#24483e'},row:{flexDirection:'row',gap:12,alignItems:'center'},grow:{flex:1},muted:{fontSize:14,lineHeight:21,color:'#62766e'},choice:{flex:1,borderWidth:1,borderColor:'#dfe7e1',borderRadius:16,padding:16,gap:7},selected:{backgroundColor:'#edf6f0',borderColor:'#438573',borderWidth:2,padding:15},choiceTitle:{fontSize:16,fontWeight:'600',color:'#24483e'},label:{fontSize:14,fontWeight:'600',color:'#466255'},
  button:{backgroundColor:'#276e5e',paddingVertical:14,paddingHorizontal:18,borderRadius:13,alignItems:'center',justifyContent:'center'},secondary:{backgroundColor:'#eaf2ed'},buttonText:{color:'#fff',fontWeight:'700',fontSize:14,textAlign:'center'},note:{fontSize:14,lineHeight:22,color:'#62766e'},footnote:{fontSize:12,lineHeight:19,color:'#72867c'},error:{padding:12,borderRadius:10,backgroundColor:'#fff0ef',color:'#a03b38',fontSize:14,lineHeight:21},pill:{backgroundColor:'#edf4ef',fontSize:10,color:'#386554',padding:8,borderRadius:10,fontWeight:'700',letterSpacing:0.5},timer:{fontSize:42,fontWeight:'600',color:'#225f51',fontVariant:['tabular-nums'],textAlign:'center',letterSpacing:2},timerBox:{padding:20,borderRadius:18,backgroundColor:'#edf6f0',alignItems:'center',gap:7},
  messages:{height:280,backgroundColor:'#f5f8f6',borderRadius:16},bubble:{maxWidth:'85%',padding:13,borderRadius:14,gap:5},ownBubble:{alignSelf:'flex-end',backgroundColor:'#dbeee3'},otherBubble:{alignSelf:'flex-start',backgroundColor:'#e8ecea'},sender:{fontSize:11,fontWeight:'700',color:'#416957'},messageText:{fontSize:15,lineHeight:22,color:'#24483e'},empty:{textAlign:'center',fontSize:14,lineHeight:22,color:'#7b8d81',paddingVertical:32},composer:{gap:10},input:{borderWidth:1,borderColor:'#d8e3da',borderRadius:13,padding:14,minHeight:52,fontSize:15,color:'#24483e',maxHeight:130},extension:{borderTopWidth:1,borderTopColor:'#e5ece7',paddingTop:16,gap:12},refund:{color:'#276e5e',fontSize:15,fontWeight:'700'},footer:{fontSize:12,lineHeight:20,color:'#7a8b81',textAlign:'center'}
});
