import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { onUnauthorized, request, role, setSessionToken } from '../client/api';

interface User { id: string; email: string; role: string; nickname: string; approved: number }
type Field = 'nickname' | 'email' | 'password';
type FieldErrors = Partial<Record<Field, string>>;
// Lightweight feedback only; the API still performs authoritative email validation.
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export default function AuthGate({ children }: { children: (user: User, logout: () => Promise<void>) => React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const working = useRef(false);
  const nicknameInput = useRef<React.ComponentRef<typeof TextInput>>(null);
  const emailInput = useRef<React.ComponentRef<typeof TextInput>>(null);
  const passwordInput = useRef<React.ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    let mounted = true;
    onUnauthorized(() => { setUser(null); setPassword(''); });
    request<{ user: User }>('/auth/me')
      .then(result => { if (mounted) setUser(result.user); })
      .catch(() => {})
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; onUnauthorized(undefined); };
  }, []);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const name = nickname.trim();
    if (register) {
      if (!name) errors.nickname = 'Please enter a nickname.';
      else if (name.length < 2 || name.length > 24) errors.nickname = 'Nickname must contain 2–24 characters.';
      else if (!/^[\p{L}\p{N} _-]+$/u.test(name)) errors.nickname = 'Use letters, numbers, spaces, underscores or hyphens.';
    }
    if (!email.trim()) errors.email = 'Please enter your email address.';
    else if (email.trim().length > 254 || !emailPattern.test(email.trim())) errors.email = 'Please enter a valid email address.';
    if (!password) errors.password = 'Please enter a password.';
    else if (register && password.length < 12) errors.password = `Use at least 12 characters. Add ${12 - password.length} more.`;
    else if (password.length > 128) errors.password = 'Password must not exceed 128 characters.';
    return errors;
  }

  function edit(field: Field, value: string) {
    if (field === 'nickname') setNickname(value);
    else if (field === 'email') setEmail(value);
    else setPassword(value);
    setFieldErrors(errors => ({ ...errors, [field]: undefined }));
    setError('');
  }

  async function submit() {
    if (working.current) return;
    const errors = validate();
    setFieldErrors(errors); setError(''); setNotice('');
    if (Object.keys(errors).length) {
      setError(register ? 'Please complete the highlighted fields, then press Create account again.' : 'Please enter your email and password, then press Sign in again.');
      if (errors.nickname) nicknameInput.current?.focus();
      else if (errors.email) emailInput.current?.focus();
      else passwordInput.current?.focus();
      return;
    }
    working.current = true; setBusy(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (register) {
        await request('/auth/register', { email: normalizedEmail, password, nickname: nickname.trim(), role });
        setEmail(normalizedEmail); setRegister(false); setFieldErrors({});
        setNotice(role === 'bestie'
          ? 'Account created. Your Bestie account is awaiting approval. You can sign in after approval.'
          : 'Account created. Sign in to start your session.');
        setPassword('');
      } else {
        const result = await request<{ user: User; token?: string }>('/auth/login', { email: normalizedEmail, password, role });
        setSessionToken(result.token); setUser(result.user); setPassword('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to complete your request. Please try again.');
    } finally { working.current = false; setBusy(false); }
  }

  async function logout() {
    try { await request('/auth/logout', {}); }
    finally { setSessionToken(); setUser(null); setPassword(''); setFieldErrors({}); }
  }

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 80 }} color="#276e5e" /></SafeAreaView>;
  if (user) return <>{children(user, logout)}</>;

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
    <Text style={styles.logo}>halobestie</Text>
    <Text style={styles.title}>{register ? 'Create your account' : 'Welcome back'}</Text>
    <Text style={styles.text}>{role === 'customer' ? 'Your account is private. Besties see only your nickname.' : 'Sign in to your approved listener account.'}</Text>
    <View style={styles.card}>
      {register && <View style={styles.field}>
        <Text style={styles.label}>Nickname *</Text>
        <TextInput ref={nicknameInput} accessibilityLabel="Account nickname" accessibilityHint={fieldErrors.nickname || 'Required. Use 2–24 characters.'} value={nickname} onChangeText={value => edit('nickname', value)} editable={!busy} maxLength={24} placeholder="Choose your nickname" returnKeyType="next" onSubmitEditing={() => emailInput.current?.focus()} style={[styles.input, !!fieldErrors.nickname && styles.invalid]} />
        <Text style={styles.hint}>Required · 2–24 characters. Avoid personal contact details.</Text>
        {!!fieldErrors.nickname && <Text accessibilityRole="alert" style={styles.error}>{fieldErrors.nickname}</Text>}
      </View>}
      <View style={styles.field}>
        <Text style={styles.label}>Email *</Text>
        <TextInput ref={emailInput} accessibilityLabel="Email" accessibilityHint={fieldErrors.email} value={email} onChangeText={value => edit('email', value)} editable={!busy} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="you@example.com" returnKeyType="next" onSubmitEditing={() => passwordInput.current?.focus()} style={[styles.input, !!fieldErrors.email && styles.invalid]} />
        {!!fieldErrors.email && <Text accessibilityRole="alert" style={styles.error}>{fieldErrors.email}</Text>}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Password *{register ? ' · at least 12 characters' : ''}</Text>
        <TextInput ref={passwordInput} accessibilityLabel="Password" accessibilityHint={fieldErrors.password || (register ? 'Required. At least 12 characters.' : 'Enter your password.')} value={password} onChangeText={value => edit('password', value)} editable={!busy} secureTextEntry autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'Create a password (12+ characters)' : 'Enter your password'} returnKeyType="go" onSubmitEditing={() => void submit()} style={[styles.input, !!fieldErrors.password && styles.invalid]} />
        {register && <Text style={styles.hint}>{password.length} characters entered · minimum 12</Text>}
        {!!fieldErrors.password && <Text accessibilityRole="alert" style={styles.error}>{fieldErrors.password}</Text>}
      </View>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!!notice && <Text accessibilityLiveRegion="polite" style={styles.text}>{notice}</Text>}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => void submit()} style={({ pressed }) => [styles.button, (busy || pressed) && styles.buttonBusy]}>
        <Text style={styles.white}>{busy ? (register ? 'Creating account…' : 'Signing in…') : register ? 'Create account' : 'Sign in'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setRegister(!register); setError(''); setNotice(''); setFieldErrors({}); }}>
        <Text style={styles.link}>{register ? 'Already have an account? Sign in' : 'Create a ' + (role === 'bestie' ? 'Bestie' : 'customer') + ' account'}</Text>
      </Pressable>
    </View>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f3f7f5' }, page: { width: '100%', maxWidth: 500, alignSelf: 'center', padding: 24, paddingTop: 60, gap: 18 },
  logo: { fontSize: 30, fontWeight: '800', color: '#276e5e' }, title: { fontSize: 34, fontWeight: '700', color: '#24483e' }, text: { fontSize: 16, lineHeight: 24, color: '#466255' },
  card: { padding: 24, borderRadius: 20, backgroundColor: '#fff', gap: 16 }, field: { gap: 8 }, label: { fontSize: 14, fontWeight: '600', color: '#24483e' },
  input: { borderWidth: 1, borderColor: '#d8e3da', padding: 14, borderRadius: 12, fontSize: 16 }, invalid: { borderColor: '#b84040', backgroundColor: '#fffafa' },
  hint: { fontSize: 13, lineHeight: 19, color: '#62766e' }, button: { padding: 16, borderRadius: 12, backgroundColor: '#276e5e', alignItems: 'center' }, buttonBusy: { opacity: 0.65 },
  white: { color: '#fff', fontSize: 16, fontWeight: '700' }, error: { fontSize: 14, lineHeight: 21, color: '#a03b38' }, link: { fontSize: 14, color: '#276e5e', textAlign: 'center', paddingTop: 8 }
});
