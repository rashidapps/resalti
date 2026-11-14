// =====================================================================
//  شاشة قائمة المحادثات + الطلبات + إضافة شخص
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import { el, fmtListTime } from './util.js';
import { icon } from './icons.js';
import { avatarEl, toast, confirmDialog, promptDialog, actionSheet, arabicError, longPress } from './ui.js';
import { state, on, visibleMsgs, otherProfile, otherIdOf, unreadOf, previewOf, sendChatRequest, respondToRequest, deleteConversationEverywhere } from './state.js';
import { pushStatus, enablePush } from './push.js';
import { nav } from './nav.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const displayName = (p) => (p && (p.name || p.email)) || 'مستخدم';

export async function addPerson() {
  if (!navigator.onLine) return toast('تحتاج إلى اتصال بالإنترنت لإضافة شخص', { type: 'error' });
  const r = await promptDialog({
    title: 'إضافة شخص',
    message: 'اكتب البريد الإلكتروني الذي سجّل به الشخص في التطبيق.',
    fields: [{ name: 'email', type: 'email', placeholder: 'name@example.com', dir: 'ltr', autocomplete: 'off' }],
    confirmText: 'بحث',
  });
  if (!r) return;
  const email = r.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return toast('البريد الإلكتروني غير صالح', { type: 'error' });
  if (email === (state.me.email || '').toLowerCase()) return toast('هذا بريدك أنت', { type: 'error' });
  try {
    const u = await API.findUserByEmail(email);
    if (!u) return toast('لا يوجد مستخدم مؤكَّد بهذا البريد. تأكد أنه أنشأ حساباً وأكّد بريده', { type: 'error', ms: 5200 });
    const existing = [...state.convs.values()].find((c) => otherIdOf(c) === u.id);
    if (existing) {
      if (existing.status === 'accepted') { nav.openChat(existing.id); return; }
      if (existing.requested_by === state.me.id) return toast('أرسلت له طلباً من قبل وهو بانتظار القبول');
    }
    const ok = await confirmDialog({
      title: 'إرسال طلب محادثة',
      message: `سيصل الطلب إلى ${u.name || email}، وتبدأ المحادثة بعد قبوله.`,
      confirmText: 'إرسال الطلب',
    });
    if (!ok) return;
    await sendChatRequest(u.id);
    toast('تم إرسال الطلب', { type: 'success' });
  } catch (e) {
    toast(arabicError(e), { type: 'error', ms: 5000 });
  }
}

export async function confirmDeleteConversation(c) {
  const p = otherProfile(c);
  const ok = await confirmDialog({
    title: 'حذف المحادثة',
    message: `ستُحذف المحادثة مع ${displayName(p)} بكل رسائلها وملفاتها من عندك ومن عنده، ولا يمكن التراجع.`,
    confirmText: 'حذف نهائياً',
    danger: true,
  });
  if (!ok) return false;
  if (!navigator.onLine) { toast('تحتاج إلى اتصال بالإنترنت لحذف المحادثة', { type: 'error' }); return false; }
  try {
    await deleteConversationEverywhere(c.id);
    toast('تم حذف المحادثة', { type: 'success' });
    return true;
  } catch (e) {
    toast(arabicError(e), { type: 'error' });
    return false;
  }
}

export function renderList() {
  const host = document.getElementById('screen-list');
  host.replaceChildren();

  const conn = el('div', { class: 'conn-bar', hidden: true });
  const body = el('div', { class: 'scroll' });
  const meBtn = el('button', { class: 'icon-btn', 'aria-label': 'الإعدادات', onclick: () => nav.showSettings() });
  host.append(
    el('div', { class: 'bar' },
      el('h1', {}, CONFIG.APP_NAME),
      el('button', { class: 'icon-btn', 'aria-label': 'إضافة شخص', onclick: addPerson, html: icon('userPlus', 24) }),
      meBtn
    ),
    conn,
    body
  );

  function paintConn() {
    let t = '';
    if (!navigator.onLine || !state.online) t = 'لا يوجد اتصال — ستُرسل رسائلك عند عودة الإنترنت';
    else if (state.offlineMode) t = 'وضع عدم الاتصال';
    conn.textContent = t;
    conn.hidden = !t;
  }

  function banner(titleText, text, actions) {
    return el('div', { class: 'banner' },
      el('span', { html: icon('bell', 22) }),
      el('div', { class: 'grow' }, el('b', {}, titleText), text, actions ? el('div', { style: 'margin-top:8px;display:flex;gap:8px' }, ...actions) : null)
    );
  }

  function paint() {
    paintConn();
    meBtn.replaceChildren(avatarEl(state.me, 34));
    body.replaceChildren();

    // ---- لافتة الإشعارات / التثبيت ----
    const ps = pushStatus();
    if (ps.needsInstall && ls.get('hideInstall') !== '1') {
      body.append(banner('ثبّت التطبيق لتصلك الإشعارات', 'اضغط زر المشاركة في Safari ثم «إضافة إلى الشاشة الرئيسية».', [
        el('button', { class: 'btn ghost small', onclick: () => { ls.set('hideInstall', '1'); paint(); } }, 'إخفاء'),
      ]));
    } else if (ps.supported && ps.configured && ps.permission === 'default' && !ps.needsInstall && ls.get('hidePush') !== '1') {
      body.append(banner('فعّل الإشعارات', 'لتصلك الرسائل الجديدة حتى والتطبيق مغلق.', [
        el('button', { class: 'btn primary small', onclick: async () => {
          try { await enablePush(); toast('تم تفعيل الإشعارات', { type: 'success' }); } catch (e) { toast(pushError(e), { type: 'error', ms: 5000 }); }
          paint();
        } }, 'تفعيل'),
        el('button', { class: 'btn ghost small', onclick: () => { ls.set('hidePush', '1'); paint(); } }, 'لاحقاً'),
      ]));
    }

    const all = [...state.convs.values()];
    const incoming = all.filter((c) => c.status === 'pending' && c.requested_by !== state.me.id);
    const outgoing = all.filter((c) => c.status === 'pending' && c.requested_by === state.me.id);
    const accepted = all.filter((c) => c.status === 'accepted');

    const lastOf = (c) => { const v = visibleMsgs(c.id); return v[v.length - 1] || null; };
    accepted.sort((a, b) => {
      const la = lastOf(a), lb = lastOf(b);
      return String((lb && lb.created_at) || b.created_at).localeCompare(String((la && la.created_at) || a.created_at));
    });

    if (incoming.length) {
      body.append(el('div', { class: 'section-title' }, 'طلبات محادثة واردة'));
      for (const c of incoming) {
        const p = otherProfile(c);
        body.append(el('div', { class: 'row' },
          avatarEl(p, 46),
          el('div', { class: 'row-main' }, el('div', { class: 'row-name' }, displayName(p)), el('div', { class: 'row-sub' }, 'يريد التواصل معك')),
          el('div', { class: 'row-actions' },
            el('button', { class: 'btn primary small', onclick: (e) => respond(e, c, true) }, 'قبول'),
            el('button', { class: 'btn ghost small', onclick: (e) => respond(e, c, false) }, 'رفض')
          )
        ));
      }
    }

    if (accepted.length) {
      body.append(el('div', { class: 'section-title' }, 'المحادثات'));
      for (const c of accepted) {
        const p = otherProfile(c);
        const last = lastOf(c);
        const unread = unreadOf(c.id);
        const row = el('button', { class: 'row', onclick: () => nav.openChat(c.id), 'data-conv': c.id },
          avatarEl(p, 52),
          el('div', { class: 'row-main' },
            el('div', { class: 'row-top' }, el('div', { class: 'row-name' }, displayName(p)), el('div', { class: 'row-time' }, last ? fmtListTime(last.created_at) : '')),
            el('div', { class: 'row-sub' },
              el('span', { class: 'txt' }, last ? ((last.sender_id === state.me.id ? 'أنت: ' : '') + previewOf(last)) : 'ابدأ المحادثة'),
              unread ? el('span', { class: 'badge' }, String(unread)) : null
            )
          )
        );
        longPress(row, () => actionSheet({
          title: displayName(p),
          actions: [{ label: 'حذف المحادثة', icon: 'trash', danger: true, onSelect: () => confirmDeleteConversation(c) }],
        }));
        body.append(row);
      }
    }

    if (outgoing.length) {
      body.append(el('div', { class: 'section-title' }, 'طلبات أرسلتها'));
      for (const c of outgoing) {
        const p = otherProfile(c);
        body.append(el('div', { class: 'row' },
          avatarEl(p, 46),
          el('div', { class: 'row-main' }, el('div', { class: 'row-name' }, displayName(p)), el('div', { class: 'row-sub' }, 'بانتظار القبول')),
          el('button', { class: 'btn ghost small', onclick: (e) => respond(e, c, false, true) }, 'إلغاء')
        ));
      }
    }

    if (!incoming.length && !accepted.length && !outgoing.length) {
      body.append(el('div', { class: 'empty' },
        el('span', { html: icon('userPlus', 54) }),
        el('h3', {}, 'لا توجد محادثات بعد'),
        el('div', {}, 'أضف شخصاً بالبريد الإلكتروني الذي سجّل به، وبعد أن يقبل طلبك تبدآن المحادثة.'),
        el('button', { class: 'btn primary', onclick: addPerson }, 'إضافة شخص')
      ));
    }
  }

  async function respond(e, c, accept, cancel = false) {
    const btn = e.currentTarget;
    if (!navigator.onLine) return toast('تحتاج إلى اتصال بالإنترنت', { type: 'error' });
    btn.disabled = true;
    try {
      if (cancel) await deleteConversationEverywhere(c.id);
      else await respondToRequest(c.id, accept);
      if (accept) nav.openChat(c.id);
    } catch (err) {
      btn.disabled = false;
      toast(arabicError(err), { type: 'error' });
    }
  }

  paint();
  const offs = ['convs', 'conn', 'badge', 'me', 'profile'].map((n) => on(n, paint));
  return () => offs.forEach((f) => f());
}

export function pushError(e) {
  switch (e && e.code) {
    case 'push_unsupported': return 'هذا الجهاز أو المتصفح لا يدعم الإشعارات';
    case 'push_needs_install': return 'على iPhone يجب أولاً إضافة التطبيق إلى الشاشة الرئيسية وفتحه من هناك';
    case 'push_not_configured': return 'الإشعارات غير مُعدّة بعد (مفتاح VAPID غير موجود في config.js)';
    case 'push_denied': return 'تم رفض إذن الإشعارات. فعّله من إعدادات iPhone ← الإشعارات ← رسائلي';
    default: return arabicError(e);
  }
}

