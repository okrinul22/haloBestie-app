import React,{useEffect,useState} from 'react';
import {ActivityIndicator,Pressable,SafeAreaView,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {onUnauthorized,request,role,setSessionToken} from '../client/api';
interface User{id:string;email:string;role:string;nickname:string;approved:number}
export default function AuthGate({children}:{children:(user:User,logout:()=>Promise<void>)=>React.ReactNode}) {
  const [user,setUser]=useState<User|null>(null);const [loading,setLoading]=useState(true);const [register,setRegister]=useState(false);
  const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [nickname,setNickname]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  useEffect(()=>{let mounted=true;onUnauthorized(()=>{setUser(null);setPassword('');});request<{user:User}>('/auth/me').then(result=>{if(mounted)setUser(result.user);}).catch(()=>{}).finally(()=>{if(mounted)setLoading(false);});return()=>{mounted=false;onUnauthorized(undefined);};},[]);
  async function submit(){if(busy)return;setBusy(true);setError('');setNotice('');try{
    if(register){await request('/auth/register',{email,password,nickname,role});setRegister(false);setNotice(role==='bestie'?'Your account is awaiting Bestie approval. You can sign in after approval.':'Account created. Sign in to start your session.');setPassword('');}
    else{const result=await request<{user:User;token?:string}>('/auth/login',{email,password,role});setSessionToken(result.token);setUser(result.user);setPassword('');}
  }catch(e){setError(e instanceof Error?e.message:'Unable to sign in');}finally{setBusy(false);}}
  async function logout(){try{await request('/auth/logout',{});}finally{setSessionToken();setUser(null);setPassword('');}}
  if(loading)return <SafeAreaView style={styles.safe}><ActivityIndicator style={{marginTop:80}} color="#276e5e"/></SafeAreaView>;
  if(user)return <>{children(user,logout)}</>;
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled"><Text style={styles.logo}>halobestie</Text><Text style={styles.title}>{register?'Create your account':'Welcome back'}</Text><Text style={styles.text}>{role==='customer'?'Your account is private. Besties see only your nickname.':'Sign in to your approved listener account.'}</Text><View style={styles.card}>
    {register&&<><Text style={styles.label}>Nickname</Text><TextInput accessibilityLabel="Account nickname" value={nickname} onChangeText={setNickname} maxLength={24} style={styles.input}/></>}
    <Text style={styles.label}>Email</Text><TextInput accessibilityLabel="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" style={styles.input}/>
    <Text style={styles.label}>Password{register?' · at least 12 characters':''}</Text><TextInput accessibilityLabel="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete={register?'new-password':'current-password'} style={styles.input}/>
    {!!error&&<Text accessibilityRole="alert" style={styles.error}>{error}</Text>}{!!notice&&<Text style={styles.text}>{notice}</Text>}
    <Pressable accessibilityRole="button" disabled={busy||!email||!password||(register&&(!nickname||password.length<12))} onPress={()=>void submit()} style={styles.button}><Text style={styles.white}>{busy?'Please wait…':register?'Create account':'Sign in'}</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={()=>{setRegister(!register);setError('');setNotice('');}}><Text style={styles.link}>{register?'Already have an account? Sign in':'Create a '+(role==='bestie'?'Bestie':'customer')+' account'}</Text></Pressable>
  </View></ScrollView></SafeAreaView>;
}
const styles=StyleSheet.create({safe:{flex:1,backgroundColor:'#f3f7f5'},page:{width:'100%',maxWidth:500,alignSelf:'center',padding:24,paddingTop:60,gap:18},logo:{fontSize:30,fontWeight:'800',color:'#276e5e'},title:{fontSize:34,fontWeight:'700',color:'#24483e'},text:{fontSize:16,lineHeight:24,color:'#466255'},card:{padding:24,borderRadius:20,backgroundColor:'#fff',gap:14},label:{fontSize:14,fontWeight:'600',color:'#24483e'},input:{borderWidth:1,borderColor:'#d8e3da',padding:14,borderRadius:12,fontSize:16},button:{padding:16,borderRadius:12,backgroundColor:'#276e5e',alignItems:'center'},white:{color:'#fff',fontSize:16,fontWeight:'700'},error:{fontSize:14,color:'#a03b38'},link:{fontSize:14,color:'#276e5e',textAlign:'center',paddingTop:8}});
