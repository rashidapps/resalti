// =====================================================================
//  نقطة التشغيل: التنقل، الجلسة، Service Worker، الاتصال/الانقطاع
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import * as DB from './db.js';
import { isNetworkError } from './util.js';
import { toast, arabicError } from './ui.js';
import { state, on, emit, startSession, goOnline, endSession, ensureRealtime, syncAll, flushOutbox, unreadTotal, previewOf, otherProfile } from './state.js';
import { nav } from './nav.js';
import { renderAuth } from './auth.js';
import { renderList, displayName } from './list.js';
import { renderChat } from './chat.js';
import { renderSettings } from './settings.js';

const SCREENS = ['boot', 'auth', 'list', 'chat', 'settings'];
let cleanup = null;
let recoveryMode = false;
let starting = false;
let loggingOut = false;

// ---------------------------------------------------------------------
// الشاشات والتنقل (مع زر الرجوع/السحب من الحافة في iOS)
// ---------------------------------------------------------------------
function show(name, render) {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  for (const s of SCREENS) document.getElementById('screen-' + s).classList.toggle('active', s === name);
  if (render) cleanup = render() || null;
}

function render(view) {
  if (!state.me) {
    const a = view && view.v === 'auth' ? view : {};
    return show('auth', () => renderAuth(a.mode || 'login', a.data || {}));
  }
  switch (view && view.v) {
    case 'chat':
      if (state.convs.has(view.c)) return show('chat', () => renderChat(view.c));
      return show('list', renderList);
    case 'settings': return show('settings', renderSettings);
    default: return show('list', renderList);
  }
}

function push(view) {
  try { history.pushState(view, ''); } catch { /* ignore */ }
  render(view);
}
function replace(view) {
  try { history.replaceState(view, ''); } catch { /* ignore */ }
  render(view);
}

nav.showAuth = (mode = 'login', data = {}) => replace({ v: 'auth', d: 0, mode, data });
nav.showList = () => {
  if (history.state && history.state.d > 0) { history.back(); return; }
  replace({ v: 'list', d: 0 });
};
nav.openChat = (c) => {
  if (history.state && history.state.v === 'chat') replace({ v: 'chat', d: 1, c });
  else push({ v: 'chat', d: 1, c });
};
nav.showSettings = () => push({ v: 'settings', d: 1 });
nav.back = () => {
  if (history.state && history.state.d > 0) history.back();
  else replace({ v: 'list', d: 0 });
};
nav.afterAuth = (user) => begin(user);

window.addEventListener('popstate', (e) => {
  const v = e.state;
  if (!state.me) return render({ v: 'auth', mode: 'login', data: {} });
  render(v && v.v !== 'auth' ? v : { v: 'list', d: 0 });
});

// ---------------------------------------------------------------------
// بدء الجلسة
// ---------------------------------------------------------------------
async function begin(user, { offline = false } = {}) {
  if (starting || (state.me && state.me.id === user.id && state.started)) return;
  starting = true;
  recoveryMode = false;
  try {
    const ready = new Promise((resolve) => {
      const off = on('ready', () => { off(); resolve(); });
      setTimeout(resolve, 8000);
    });
    const p = startSession(user, { offline });
    p.catch((e) => { if (!isNetworkError(e)) console.error(e); });
    await ready;
    replace({ v: 'list', d: 0 });
    const c = new URLSearchParams(location.search).get('c');
    if (c) {
      history.replaceState(history.state, '', location.pathname);
      if (state.convs.has(c)) nav.openChat(c);
    }
    DB.pruneMedia(CONFIG.MEDIA_CACHE_MB * 1024 * 1024);
  } catch (e) {
    toast(arabicError(e), { type: 'error' });
    nav.showAuth('login');
  } finally {
    starting = false;
  }
}

function handleAuthEvent(event, session) {
  // لا نستدعي Supabase مباشرة داخل هذه الدالة (قد يسبب تعليقاً)، لذلك نؤجّل
  setTimeout(async () => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      show('auth', () => renderAuth('recovery'));
    } else if (event === 'SIGNED_IN' && session && !recoveryMode) {
      if (!state.me || state.me.id !== session.user.id) begin(session.user);
    } else if (event === 'SIGNED_OUT' && state.me && !loggingOut) {
      await endSession();
      nav.showAuth('login', { notice: 'انتهت الجلسة. سجّل الدخول من جديد.' });
    }
  }, 0);
}

async function boot() {
  fitViewport();
  registerSW();

  if (!API.isConfigured()) { show('auth', () => renderAuth('setup')); return; }

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const hashErr = hash.get('error_description');
  if (hash.get('type') === 'recovery') recoveryMode = true;

  const cachedMe = await DB.getMeta('me').catch(() => null);
  try {
    await API.initClient();
  } catch (e) {
    if (cachedMe) return begin({ id: cachedMe.id, email: cachedMe.email, user_metadata: {} }, { offline: true });
    show('auth', () => renderAuth('login', { notice: arabicError(e) }));
    return;
  }
  API.auth.onChange(handleAuthEvent);

  let session = null;
  let sessErr = null;
  try { session = await API.auth.getSession(); } catch (e) { sessErr = e; }

  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  if (recoveryMode && session) { show('auth', () => renderAuth('recovery')); return; }
  if (session) return begin(session.user);
  if (cachedMe && (sessErr ? isNetworkError(sessErr) : !navigator.onLine)) {
    return begin({ id: cachedMe.id, email: cachedMe.email, user_metadata: {} }, { offline: true });
  }
  history.replaceState({ v: 'auth', d: 0 }, '');
  show('auth', () => renderAuth('login', { notice: hashErr ? 'الرابط غير صالح أو انتهت صلاحيته. أعد الطلب.' : '' }));
}

// ---------------------------------------------------------------------
// الاتصال بالإنترنت
// ---------------------------------------------------------------------
async function onOnline() {
  state.online = true;
  if (!state.me) return;
  if (state.offlineMode) {
    try {
      if (!window.supabase || !API.client()) await API.initClient();
      const s = await API.auth.getSession();
      if (!s) { await endSession(); return nav.showAuth('login'); }
      await goOnline();
    } catch (e) { console.warn(e); }
  } else {
    ensureRealtime();
    syncAll();
    flushOutbox();
  }
}
window.addEventListener('online', async () => { await onOnline(); emitConn(); });
window.addEventListener('offline', () => { state.online = false; emitConn(); });
function emitConn() { emit('conn'); }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me || state.offlineMode) return;
  ensureRealtime();
  syncAll();
  navigator.serviceWorker && navigator.serviceWorker.getRegistration().then((r) => r && r.update().catch(() => {}));
});

// ---------------------------------------------------------------------
// الشارة والتنبيهات داخل التطبيق
// ---------------------------------------------------------------------
on('badge', () => {
  const n = unreadTotal();
  document.title = n ? `(${n}) ${CONFIG.APP_NAME}` : CONFIG.APP_NAME;
  try { if (n && navigator.setAppBadge) navigator.setAppBadge(n); else if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch { /* ignore */ }
});

on('incoming', (m) => {
  if (document.visibilityState !== 'visible' || state.chatId === m.conversation_id) return;
  const c = state.convs.get(m.conversation_id);
  if (!c) return;
  toast(`${displayName(otherProfile(c))}: ${previewOf(m)}`, { ms: 4200, action: { label: 'فتح', onClick: () => nav.openChat(c.id) } });
});

on('db-error', () => toast('تعذّر الحفظ على هذا الجهاز. قد تكون المساحة ممتلئة', { type: 'error', ms: 6000 }));

// ---------------------------------------------------------------------
// مساحة العرض مع لوحة المفاتيح (iOS)
// ---------------------------------------------------------------------
function fitViewport() {
  const vv = window.visualViewport;
  const app = document.getElementById('app');
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', h + 'px');
    app.style.top = (vv ? vv.offsetTop : 0) + 'px';
    document.body.classList.toggle('kb-open', !!vv && window.innerHeight - vv.height > 120);
  };
  apply();
  if (vv) { vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply); }
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
}

// ---------------------------------------------------------------------
// Service Worker + التحديث
// ---------------------------------------------------------------------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // أول تثبيت: لا حاجة لإعادة التحميل
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open-chat' && e.data.conv && state.convs.has(e.data.conv)) nav.openChat(e.data.conv);
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast('يتوفر تحديث للتطبيق', { ms: 0, action: { label: 'تحديث الآن', onClick: () => w.postMessage({ type: 'SKIP_WAITING' }) } });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('SW registration failed', e));
}

window.addEventListener('unhandledrejection', (e) => console.error('unhandled', e.reason));

boot().catch((e) => {
  console.error(e);
  show('auth', () => renderAuth('login', { notice: arabicError(e) }));
});
