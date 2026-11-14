// =====================================================================
//  طبقة الاتصال بـ Supabase — كل ما يخص السيرفر في ملف واحد
// =====================================================================
import { CONFIG } from './config.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

let sb = null;
let channel = null;

export const isConfigured = () => !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
export const client = () => sb;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error('failed to load ' + src));
    };
    document.head.append(s);
  });
}

/** يحمّل مكتبة supabase-js: نسخة محلية vendor/supabase.js إن وُجدت، وإلا من CDN (يخزّنها Service Worker) */
export async function initClient() {
  if (!window.supabase) {
    try {
      await loadScript('vendor/supabase.js');
    } catch {
      /* لا توجد نسخة محلية — طبيعي */
    }
  }
  if (!window.supabase) await loadScript(CDN);
  if (!window.supabase) throw new Error('تعذّر تحميل مكتبة الاتصال. تحقق من الإنترنت وأعد المحاولة');
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // implicit: روابط التأكيد/الاستعادة تعمل حتى لو فُتحت في Safari بدل التطبيق المثبّت
      flowType: 'implicit',
    },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return sb;
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// المصادقة
// ---------------------------------------------------------------------
export const auth = {
  async signUp(email, password, name) {
    const redirectTo = location.origin + location.pathname;
    const res = await sb.auth.signUp({
      email,
      password,
      options: { data: { name }, emailRedirectTo: redirectTo },
    });
    if (res.error) throw res.error;
    const user = res.data.user;
    // عند تفعيل تأكيد البريد: البريد المسجّل مسبقاً يُرجع مستخدماً بلا identities
    if (user && Array.isArray(user.identities) && user.identities.length === 0) {
      const e = new Error('user_already_exists');
      e.code = 'user_already_exists';
      throw e;
    }
    return { user, session: res.data.session };
  },
  async signIn(email, password) {
    return unwrap(await sb.auth.signInWithPassword({ email, password }));
  },
  async signOut() {
    const { error } = await sb.auth.signOut();
    if (error && !/session/i.test(error.message || '')) throw error;
  },
  async resend(email) {
    return unwrap(
      await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: location.origin + location.pathname } })
    );
  },
  async resetPassword(email) {
    return unwrap(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
  },
  async updatePassword(newPassword) {
    return unwrap(await sb.auth.updateUser({ password: newPassword }));
  },
  /** التحقق من كلمة المرور الحالية بعميل مؤقت لا يلمس الجلسة الحالية */
  async verifyPassword(email, password) {
    const tmp = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await tmp.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return true;
  },
  async getSession() {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  onChange(cb) {
    return sb.auth.onAuthStateChange((event, session) => cb(event, session));
  },
};

// ---------------------------------------------------------------------
// الملفات الشخصية
// ---------------------------------------------------------------------
export async function fetchProfile(id) {
  return unwrap(await sb.from('profiles').select('*').eq('id', id).maybeSingle());
}

export async function fetchProfiles(ids) {
  if (!ids.length) return [];
  return unwrap(await sb.from('profiles').select('*').in('id', ids));
}

export async function updateMyProfile(id, patch) {
  const clean = {};
  if ('name' in patch) clean.name = patch.name;
  if ('avatar_path' in patch) clean.avatar_path = patch.avatar_path;
  return unwrap(await sb.from('profiles').update(clean).eq('id', id).select().single());
}

export async function uploadAvatar(userId, blob, oldPath) {
  const path = `${userId}/${Date.now().toString(36)}.jpg`;
  const up = await sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
  if (up.error) throw up.error;
  const profile = await updateMyProfile(userId, { avatar_path: path });
  if (oldPath) await sb.storage.from('avatars').remove([oldPath]).catch(() => {});
  return profile;
}

export function avatarPublicUrl(path) {
  return sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------------
// المحادثات
// ---------------------------------------------------------------------
export async function fetchConversations() {
  return unwrap(await sb.from('conversations').select('*').order('created_at', { ascending: false }));
}

export async function findUserByEmail(email) {
  const rows = unwrap(await sb.rpc('find_user_by_email', { p_email: email }));
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function requestChat(targetId) {
  return unwrap(await sb.rpc('request_chat', { p_target: targetId }));
}

export async function respondChat(convId, accept) {
  unwrap(await sb.rpc('respond_chat', { p_conv: convId, p_accept: accept }));
}

/** حذف المحادثة للطرفين: حذف الملفات من التخزين أولاً ثم صف المحادثة (والرسائل تُحذف تلقائياً) */
export async function deleteConversation(convId) {
  await removeConvFiles(convId);
  unwrap(await sb.from('conversations').delete().eq('id', convId));
}

export async function removeConvFiles(convId) {
  try {
    for (let guard = 0; guard < 20; guard++) {
      const { data, error } = await sb.storage.from('media').list(convId, { limit: 100 });
      if (error || !data || !data.length) break;
      const { error: rmErr } = await sb.storage.from('media').remove(data.map((f) => `${convId}/${f.name}`));
      if (rmErr) break;
      if (data.length < 100) break;
    }
  } catch (e) {
    console.warn('تعذّر تنظيف ملفات المحادثة', e);
  }
}

// ---------------------------------------------------------------------
// الرسائل
// ---------------------------------------------------------------------
export async function fetchMessages(convId, { before = null, limit = 100 } = {}) {
  let q = sb
    .from('messages')
    .select('*')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) q = q.lt('created_at', before);
  return unwrap(await q);
}

/** يُرجع true عند النجاح أو إن كانت الرسالة موجودة مسبقاً (لا تكرار عند إعادة المحاولة) */
export async function insertMessage(row) {
  const { error } = await sb.from('messages').insert(row);
  if (!error) return true;
  if (error.code === '23505') return true; // نفس المعرّف أُرسل سابقاً
  throw error;
}

export async function deleteMessage(msg) {
  const paths = (msg.media || []).map((m) => m.path).filter(Boolean);
  if (paths.length) await sb.storage.from('media').remove(paths).catch(() => {});
  unwrap(await sb.from('messages').delete().eq('id', msg.id));
}

export const markDelivered = async (convId) => unwrap(await sb.rpc('mark_delivered', { p_conv: convId }));
export const markRead = async (convId) => unwrap(await sb.rpc('mark_read', { p_conv: convId }));

// ---------------------------------------------------------------------
// الوسائط
// ---------------------------------------------------------------------
export async function uploadMedia(path, blob, contentType) {
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType, upsert: false, cacheControl: '3600' });
  if (!error) return true;
  const msg = String(error.message || '').toLowerCase();
  if (error.statusCode === '409' || error.status === 409 || msg.includes('already exists') || msg.includes('duplicate')) return true;
  throw error;
}

export async function downloadMedia(path) {
  const { data, error } = await sb.storage.from('media').download(path);
  if (error) throw error;
  return data;
}

export async function signedUrl(path, seconds = 3600) {
  const { data, error } = await sb.storage.from('media').createSignedUrl(path, seconds);
  if (error) throw error;
  return data.signedUrl;
}

// ---------------------------------------------------------------------
// الإشعارات
// ---------------------------------------------------------------------
export async function savePushSubscription(sub) {
  const j = sub.toJSON();
  unwrap(
    await sb.rpc('save_push_subscription', {
      p_endpoint: j.endpoint,
      p_p256dh: j.keys.p256dh,
      p_auth: j.keys.auth,
      p_ua: navigator.userAgent,
    })
  );
}

export async function removePushSubscription(endpoint) {
  unwrap(await sb.from('push_subscriptions').delete().eq('endpoint', endpoint));
}

// ---------------------------------------------------------------------
// الوقت الحقيقي
// ---------------------------------------------------------------------
export function subscribeRealtime({ onMessage, onConversation, onProfile, onStatus }) {
  unsubscribeRealtime();
  channel = sb
    .channel('app-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => onMessage(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, (p) => onConversation(p))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p) => onProfile(p))
    .subscribe((status) => onStatus && onStatus(status));
}

export function unsubscribeRealtime() {
  if (channel) {
    try {
      sb.removeChannel(channel);
    } catch {
      /* ignore */
    }
    channel = null;
  }
}

// ---------------------------------------------------------------------
// حذف الحساب
// ---------------------------------------------------------------------
export async function deleteAccountOnServer() {
  unwrap(await sb.rpc('delete_my_account'));
}

export async function removeAvatarFiles(userId) {
  try {
    const { data } = await sb.storage.from('avatars').list(userId, { limit: 100 });
    if (data && data.length) await sb.storage.from('avatars').remove(data.map((f) => `${userId}/${f.name}`));
  } catch (e) {
    console.warn(e);
  }
}
