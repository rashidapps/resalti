// =====================================================================
//  الحالة + طبقة البيانات: الذاكرة ⇄ IndexedDB ⇄ Supabase
//  - الرسائل تُحفظ محلياً فوراً (IndexedDB) ثم تُرسل (صندوق الصادر) حتى لو انقطع الإنترنت
//  - المعرّف uuid يُولَّد في الجهاز، فإعادة الإرسال لا تُكرّر الرسالة أبداً
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import * as DB from './db.js';
import { uuid, isNetworkError } from './util.js';
import { syncPush } from './push.js';
import { cacheMedia, forgetUrls } from './media.js';

export const state = {
  me: null,
  convs: new Map(),
  profiles: new Map(),
  msgs: new Map(),
  hidden: new Set(),
  noMore: new Set(),
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  rt: 'idle',
  chatId: null,
  started: false,
  offlineMode: false,
};

// ---------- أحداث بسيطة بين الطبقات ----------
const listeners = {};
export const on = (name, fn) => {
  (listeners[name] ||= new Set()).add(fn);
  return () => listeners[name].delete(fn);
};
export const emit = (name, data) => (listeners[name] || []).forEach((f) => {
  try { f(data); } catch (e) { console.error(e); }
});

// ---------- أدوات ----------
const iso = (v) => (v ? new Date(v).toISOString() : null);

export function normMsg(m) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender_id: m.sender_id,
    kind: m.kind,
    body: m.body ?? null,
    media: Array.isArray(m.media) ? m.media : [],
    created_at: iso(m.created_at),
    delivered_at: iso(m.delivered_at),
    read_at: iso(m.read_at),
  };
}

const cmp = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);

export function getMsgs(conv) {
  let a = state.msgs.get(conv);
  if (!a) { a = []; state.msgs.set(conv, a); }
  return a;
}

function insertSorted(arr, m) {
  let i = arr.length;
  while (i > 0 && cmp(arr[i - 1], m) > 0) i--;
  arr.splice(i, 0, m);
}

/** يضع رسالة في الذاكرة (استبدال كامل إن وُجدت). يرجع 'add' | 'update' */
function putLocal(m) {
  const arr = getMsgs(m.conversation_id);
  const i = arr.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    if (arr[i].created_at !== m.created_at) { arr.splice(i, 1); insertSorted(arr, m); }
    else arr[i] = m;
    return 'update';
  }
  insertSorted(arr, m);
  return 'add';
}

export const hasMsg = (m) => getMsgs(m.conversation_id).some((x) => x.id === m.id);
export const visibleMsgs = (conv) => getMsgs(conv).filter((m) => !state.hidden.has(m.id));
export const otherIdOf = (c) => (c.user_a === state.me.id ? c.user_b : c.user_a);
export const otherProfile = (c) => state.profiles.get(otherIdOf(c)) || { id: otherIdOf(c), name: '', email: '' };

export function unreadOf(conv) {
  return getMsgs(conv).filter((m) => m.sender_id !== state.me.id && !m.read_at && !m.pending && !state.hidden.has(m.id)).length;
}
export function unreadTotal() {
  let n = 0;
  for (const c of state.convs.values()) if (c.status === 'accepted') n += unreadOf(c.id);
  return n;
}

export function previewOf(m) {
  if (!m) return '';
  if (m.kind === 'image') return (m.media || []).length > 1 ? `📷 ${(m.media || []).length} صور` : '📷 صورة';
  if (m.kind === 'video') return '🎬 فيديو';
  if (m.kind === 'audio') return '🎤 رسالة صوتية';
  return m.body || '';
}

function isTransient(e) {
  if (isNetworkError(e)) return true;
  const s = Number(e && (e.status || e.statusCode));
  const msg = String((e && e.message) || '').toLowerCase();
  return s >= 500 || s === 401 || s === 429 || msg.includes('jwt');
}

// ---------------------------------------------------------------------
// حفظ في IndexedDB (أخطاء الحفظ تظهر للمستخدم عبر حدث 'db-error')
// ---------------------------------------------------------------------
async function persistMsgs(list) {
  try {
    await DB.dbPut('messages', list);
  } catch (e) {
    console.error('IndexedDB write failed', e);
    emit('db-error', e);
  }
}

function ingest(list) {
  const added = [];
  for (const m of list) {
    const kind = putLocal(m);
    emit('msgs', { conv: m.conversation_id, type: kind, msg: m });
    if (kind === 'add') added.push(m);
  }
  persistMsgs(list);
  emit('convs');
  emit('badge');
  return added;
}

function removeLocalMsg(id) {
  for (const [conv, arr] of state.msgs) {
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) {
      const [m] = arr.splice(i, 1);
      DB.dbDel('messages', id).catch(() => {});
      emit('msgs', { conv, type: 'remove', msg: m });
      emit('convs');
      emit('badge');
      return;
    }
  }
}

function patchLocal(id, patch) {
  for (const arr of state.msgs.values()) {
    const m = arr.find((x) => x.id === id);
    if (m) {
      Object.assign(m, patch);
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete m[k];
      persistMsgs([m]);
      emit('msgs', { conv: m.conversation_id, type: 'update', msg: m });
      return m;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// تحميل الذاكرة المحلية عند الفتح
// ---------------------------------------------------------------------
async function loadCache() {
  state.convs.clear(); state.profiles.clear(); state.msgs.clear(); state.noMore.clear();
  const [convs, profiles, msgs, hidden] = await Promise.all([
    DB.dbAll('convs'), DB.dbAll('profiles'), DB.dbAll('messages'), DB.getMeta('hidden:' + state.me.id, []),
  ]);
  convs.forEach((c) => state.convs.set(c.id, c));
  profiles.forEach((p) => state.profiles.set(p.id, p));
  msgs.sort(cmp).forEach((m) => getMsgs(m.conversation_id).push(m));
  state.hidden = new Set(hidden || []);
}

// ---------------------------------------------------------------------
// الجلسة
// ---------------------------------------------------------------------
export async function startSession(user, { offline = false } = {}) {
  const cached = await DB.getMeta('me').catch(() => null);
  if (cached && cached.id !== user.id) await DB.clearAllUserData().catch(() => {});
  state.me = {
    id: user.id,
    email: user.email,
    name: (cached && cached.id === user.id && cached.name) || (user.user_metadata && user.user_metadata.name) || '',
    avatar_path: cached && cached.id === user.id ? cached.avatar_path || null : null,
  };
  await DB.setMeta('me', state.me);
  await loadCache();
  state.started = true;
  state.offlineMode = offline;
  emit('ready');
  if (!offline) await goOnline();
}

export async function goOnline() {
  if (!state.me) return;
  state.offlineMode = false;
  try {
    const p = await API.fetchProfile(state.me.id);
    if (p) {
      state.me = { ...state.me, name: p.name, avatar_path: p.avatar_path, email: p.email };
      await DB.setMeta('me', state.me);
      emit('me');
    }
  } catch (e) {
    if (!isNetworkError(e)) console.warn(e);
  }
  startRealtime();
  await syncAll();
  syncPush();
}

/** إعادة تحميل الذاكرة من IndexedDB (بعد استعادة نسخة احتياطية مثلاً) */
export async function reloadCache() {
  await loadCache();
  emit('convs');
  emit('badge');
}

export async function endSession() {
  API.unsubscribeRealtime();
  try { await DB.clearAllUserData(); await DB.dbDel('meta', ['me']); } catch (e) { console.warn(e); }
  forgetUrls();
  state.me = null; state.started = false; state.chatId = null;
  state.convs.clear(); state.profiles.clear(); state.msgs.clear(); state.hidden.clear(); state.noMore.clear();
  state.rt = 'idle';
  emit('ended');
}

export async function updateMe(patch) {
  state.me = { ...state.me, ...patch };
  await DB.setMeta('me', state.me);
  emit('me');
}

// ---------------------------------------------------------------------
// المزامنة
// ---------------------------------------------------------------------
let syncing = false;
let syncAgain = false;

export async function refreshConvs() {
  const rows = await API.fetchConversations();
  const ids = new Set(rows.map((r) => r.id));
  for (const id of [...state.convs.keys()]) if (!ids.has(id)) await dropConvLocal(id);
  const otherIds = [...new Set(rows.map(otherIdOf))];
  const profs = await API.fetchProfiles(otherIds);
  profs.forEach((p) => state.profiles.set(p.id, p));
  rows.forEach((c) => state.convs.set(c.id, c));
  await DB.dbPut('profiles', profs).catch(() => {});
  await DB.dbPut('convs', rows).catch(() => {});
  emit('convs');
  return rows;
}

async function dropConvLocal(id) {
  await DB.deleteConvLocal(id).catch(() => {});
  state.convs.delete(id);
  state.msgs.delete(id);
  emit('conv-removed', id);
  emit('convs');
  emit('badge');
}

export async function syncConv(convId) {
  const PAGE = 100;
  const rows = (await API.fetchMessages(convId, { limit: PAGE })).map(normMsg);
  if (rows.length < PAGE) state.noMore.add(convId);
  const serverIds = new Set(rows.map((r) => r.id));
  const oldest = rows.length >= PAGE ? rows[rows.length - 1].created_at : '';
  // رسائل حُذفت من الطرف الآخر أو من جهاز آخر أثناء غيابي
  const gone = getMsgs(convId).filter(
    (m) => !m.pending && !m.failed && !m.local_only && m.created_at >= oldest && !serverIds.has(m.id)
  );
  gone.forEach((m) => removeLocalMsg(m.id));
  const fresh = ingest(rows.sort(cmp));
  if (fresh.some((m) => m.sender_id !== state.me.id)) scheduleAck(convId);
  return rows.length;
}

export async function loadOlder(convId) {
  const arr = getMsgs(convId);
  const first = arr.find((m) => !m.pending);
  const before = first ? first.created_at : null;
  const rows = (await API.fetchMessages(convId, { before, limit: CONFIG.PAGE_SIZE })).map(normMsg);
  if (rows.length < CONFIG.PAGE_SIZE) state.noMore.add(convId);
  ingest(rows);
  return rows.length;
}

export async function syncAll() {
  if (syncing) { syncAgain = true; return; }
  if (!state.me || !navigator.onLine) return;
  syncing = true;
  try {
    const rows = await refreshConvs();
    const accepted = rows.filter((c) => c.status === 'accepted');
    for (const c of accepted) {
      try { await syncConv(c.id); } catch (e) { if (!isNetworkError(e)) console.warn('sync conv', e); }
    }
    await flushOutbox();
    for (const c of accepted) scheduleAck(c.id);
  } catch (e) {
    if (!isNetworkError(e)) console.warn('sync failed', e);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; setTimeout(syncAll, 50); }
  }
}

let refreshTimer = null;
export function refreshConvsSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const before = new Set([...state.convs.values()].filter((c) => c.status === 'accepted').map((c) => c.id));
      const rows = await refreshConvs();
      for (const c of rows) if (c.status === 'accepted' && !before.has(c.id)) await syncConv(c.id);
    } catch (e) { if (!isNetworkError(e)) console.warn(e); }
  }, 250);
}

// ---------------------------------------------------------------------
// الوقت الحقيقي
// ---------------------------------------------------------------------
let rtDownSince = 0;

export function startRealtime() {
  API.subscribeRealtime({
    onMessage: (p) => {
      if (p.eventType === 'DELETE') {
        if (p.old && p.old.id) removeLocalMsg(p.old.id);
        return;
      }
      const row = p.new;
      if (!row) return;
      if (!state.convs.has(row.conversation_id)) refreshConvsSoon();
      const m = normMsg(row);
      const isNew = !hasMsg(m);
      ingest([m]);
      if (isNew && m.sender_id !== state.me.id) {
        emit('incoming', m);
        scheduleAck(m.conversation_id);
      }
    },
    onConversation: () => refreshConvsSoon(),
    onProfile: (p) => {
      const row = p.new;
      if (!row) return;
      if (row.id === state.me.id) { updateMe({ name: row.name, avatar_path: row.avatar_path }); return; }
      if (state.profiles.has(row.id)) {
        state.profiles.set(row.id, { ...state.profiles.get(row.id), ...row });
        DB.dbPut('profiles', state.profiles.get(row.id)).catch(() => {});
        emit('convs');
        emit('profile', row.id);
      }
    },
    onStatus: (s) => {
      state.rt = s;
      emit('conn');
      if (s === 'SUBSCRIBED') {
        if (rtDownSince) { rtDownSince = 0; syncAll(); } // تعويض ما فات أثناء الانقطاع
      } else if (!rtDownSince) rtDownSince = Date.now();
    },
  });
}

export function ensureRealtime() {
  if (!state.me || state.offlineMode) return;
  if (state.rt !== 'SUBSCRIBED') startRealtime();
}

// ---------------------------------------------------------------------
// التسليم والقراءة
// ---------------------------------------------------------------------
const ackTimers = new Map();
export function scheduleAck(conv) {
  clearTimeout(ackTimers.get(conv));
  ackTimers.set(conv, setTimeout(() => ack(conv), 300));
}

async function ack(conv) {
  if (!state.me || state.offlineMode || !navigator.onLine || document.visibilityState !== 'visible') return;
  const mine = state.me.id;
  const unread = getMsgs(conv).filter((m) => m.sender_id !== mine && !m.read_at && !m.pending);
  if (!unread.length) return;
  const reading = state.chatId === conv;
  const targets = reading ? unread : unread.filter((m) => !m.delivered_at);
  if (!targets.length) return;
  try {
    if (reading) await API.markRead(conv); else await API.markDelivered(conv);
    const now = new Date().toISOString();
    for (const m of targets) {
      patchLocal(m.id, reading ? { read_at: now, delivered_at: m.delivered_at || now } : { delivered_at: now });
    }
    emit('convs');
    emit('badge');
  } catch (e) {
    if (!isNetworkError(e)) console.warn('ack failed', e);
  }
}

// ---------------------------------------------------------------------
// صندوق الصادر (الإرسال المضمون وعدم التكرار)
// ---------------------------------------------------------------------
let flushing = false;
let retryTimer = null;

function scheduleRetry(ms = 5000) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flushOutbox, ms);
}

export async function queueMessage({ conv, kind, body = null, media = [], files = [] }) {
  const id = uuid();
  const row = {
    id, conversation_id: conv, sender_id: state.me.id, kind, body, media,
    created_at: new Date().toISOString(),
  };
  const msg = { ...normMsg(row), pending: true };
  // الحفظ المحلي أولاً: لا تظهر الرسالة كـ"مُرسلة" إلا بعد نجاحه
  await DB.dbPut('outbox', { id, conversation_id: conv, row, files: files.map((f) => ({ ...f, done: false })), created_at: row.created_at, failed: false });
  await DB.dbPut('messages', msg);
  putLocal(msg);
  emit('msgs', { conv, type: 'add', msg });
  emit('convs');
  flushOutbox();
  return msg;
}

export async function flushOutbox() {
  if (flushing || !state.me || state.offlineMode) return;
  flushing = true;
  try {
    const items = (await DB.dbAll('outbox')).filter((o) => !o.failed).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    for (const it of items) {
      if (!navigator.onLine) break;
      try {
        for (const f of it.files || []) {
          if (f.done) continue;
          await API.uploadMedia(f.path, f.blob, f.type);
          f.done = true;
          cacheMedia(f.path, f.blob);
          await DB.dbPut('outbox', it);
        }
        await API.insertMessage(it.row);
        await DB.dbDel('outbox', it.id);
        patchLocal(it.id, { pending: undefined, failed: undefined, sent: true });
      } catch (e) {
        if (isTransient(e)) { scheduleRetry(); break; }
        it.failed = true;
        it.error = String((e && e.message) || e);
        await DB.dbPut('outbox', it).catch(() => {});
        patchLocal(it.id, { pending: undefined, failed: true, error: it.error });
      }
    }
  } finally {
    flushing = false;
  }
}

export async function retryFailed(id) {
  const it = await DB.dbGet('outbox', id);
  if (!it) return;
  it.failed = false;
  delete it.error;
  await DB.dbPut('outbox', it);
  patchLocal(id, { failed: undefined, error: undefined, pending: true });
  flushOutbox();
}

export async function discardPending(id) {
  await DB.dbDel('outbox', id);
  removeLocalMsg(id);
}

export async function pendingOutboxCount() {
  return (await DB.dbAll('outbox')).filter((o) => !o.failed).length;
}

// ---------------------------------------------------------------------
// حذف
// ---------------------------------------------------------------------
export async function deleteMyMessage(m) {
  if (m.pending || m.failed || m.local_only) {
    if (m.pending || m.failed) await DB.dbDel('outbox', m.id);
    removeLocalMsg(m.id);
    return;
  }
  await API.deleteMessage(m); // يُحذف عند الطرفين
  removeLocalMsg(m.id);
}

export async function hideForMe(m) {
  state.hidden.add(m.id);
  await DB.setMeta('hidden:' + state.me.id, [...state.hidden]);
  emit('msgs', { conv: m.conversation_id, type: 'remove', msg: m });
  emit('convs');
  emit('badge');
}

export async function deleteConversationEverywhere(convId) {
  await API.deleteConversation(convId);
  await dropConvLocal(convId);
}

// ---------------------------------------------------------------------
// طلبات المحادثة
// ---------------------------------------------------------------------
export async function sendChatRequest(targetId) {
  await API.requestChat(targetId);
  await refreshConvs();
  const c = [...state.convs.values()].find((x) => otherIdOf(x) === targetId);
  if (c && c.status === 'accepted') await syncConv(c.id);
}

export async function respondToRequest(convId, accept) {
  await API.respondChat(convId, accept);
  await refreshConvs();
  if (accept) await syncConv(convId);
}
