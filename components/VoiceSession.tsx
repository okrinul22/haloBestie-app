import React from 'react';
import { Text, View } from 'react-native';
import type { VoiceSessionProps } from './voice.types';
export default function VoiceSession(_props:VoiceSessionProps) {
  return <View><Text>Microphone calls currently run in the browser app. Open the Customer and Bestie web apps to use voice. This native build will not substitute text chat for a paid voice call.</Text></View>;
}
