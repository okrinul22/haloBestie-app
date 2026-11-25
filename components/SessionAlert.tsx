import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
export interface SessionNotice {key:string;title:string;message:string}
export default function SessionAlert({notice,onClose}:{notice:SessionNotice|undefined;onClose:()=>void}) {
  return <Modal visible={!!notice} transparent animationType="fade" onRequestClose={onClose}><View style={styles.backdrop}><View accessibilityRole="alert" style={styles.card}><Text style={styles.title}>{notice?.title}</Text><Text style={styles.message}>{notice?.message}</Text><Pressable accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>OK, understood</Text></Pressable></View></View></Modal>;
}
const styles=StyleSheet.create({backdrop:{flex:1,backgroundColor:'rgba(15,40,31,0.5)',justifyContent:'center',alignItems:'center',padding:24},card:{width:'100%',maxWidth:420,padding:24,borderRadius:22,backgroundColor:'#fff',gap:18},title:{fontSize:22,fontWeight:'700',color:'#24483e'},message:{fontSize:16,lineHeight:25,color:'#466255'},button:{backgroundColor:'#276e5e',padding:15,borderRadius:12,alignItems:'center'},buttonText:{fontSize:15,fontWeight:'700',color:'#fff'}});
