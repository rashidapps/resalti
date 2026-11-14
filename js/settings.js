// =====================================================================
//  الإعدادات: الملف الشخصي، الإشعارات، كلمة المرور، النسخ الاحتياطي، الحذف، الخروج
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import { el, shareOrDownload } from './util.js';
import { icon } from './icons.js';
import { avatarEl, toast, confirmDialog, promptDialog, arabicError } from './ui.js';
import { state, on, endSession, updateMe, reloadCache, otherProfile, pendingOutboxCount } from './state.js';
import { makeAvatarBlob } from './media.js';
import { backupToBlob, backupFileName, buildCSV, validateBackup, importBackup } from './backup.js';
import { pushStatus, enablePush, disablePush, currentSubscription } from './push.js';
import { displayName, confirmDeleteConversation, pushError } from './list.js';
import { nav } from './nav.js';

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const needNet = () => {
  if (navigator.onLine) return false;
  toast('هذا الإجراء يحتاج إلى اتصال بالإنترنت', { type: 'error' });
  return true;
};

export async function logout() {
  let msg = 'سيُحذف ما هو محفوظ من المحادثات على هذا الجهاز، وتعود إليك عند تسجيل الدخول من جديد.';
  const pending = await pendingOutboxCount().catch(() => 0);
  if (pending) msg = `⚠️ لديك ${pending} رسالة لم تُرسل بعد وستضيع إن خرجت الآن.\n\n` + msg;
  const ok = await confirmDialog({ title: 'تسجيل الخروج', message: msg, confirmText: 'خروج', danger: !!pending });
  if (!ok) return;
  try { await disablePush(); } catch { /* ignore */ }
  try { await API.auth.signOut(); } catch (e) { console.warn(e); }
  await endSession();
  nav.showAuth('login');
}

export function renderSettings() {
  const host = document.getElementById('screen-settings');
  host.replaceChildren();
  const body = el('div', { class: 'scroll' });
  host.append(
    el('div', { class: 'bar' },
      el('button', { class: 'icon-btn', 'aria-label': 'رجوع', onclick: () => nav.back(), html: icon('back', 24) }),
      el('h1', {}, 'الإعدادات')
    ),
    body
  );

  const fileAvatar = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: onAvatar });
  const fileImport = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: onImport });
  host.append(fileAvatar, fileImport);

  const item = (iconName, title, sub, onclick, cls = '') =>
    el('button', { class: `item ${cls}`, onclick },
      el('span', { html: icon(iconName, 22) }),
      el('span', { class: 'grow' }, title, sub ? el('small', {}, sub) : null)
    );

  async function onAvatar(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || needNet()) return;
    try {
      const blob = await makeAvatarBlob(f);
      const p = await API.uploadAvatar(state.me.id, blob, state.me.avatar_path);
      await updateMe({ avatar_path: p.avatar_path });
      toast('تم تحديث الصورة', { type: 'success' });
    } catch (err) {
      toast(arabicError(err), { type: 'error' });
    }
  }

  async function editName() {
    if (needNet()) return;
    const r = await promptDialog({ title: 'تعديل الاسم', fields: [{ name: 'name', value: state.me.name, placeholder: 'اسمك', autocomplete: 'name' }] });
    if (!r) return;
    const name = r.name.trim();
    if (!name) return toast('الاسم لا يمكن أن يكون فارغاً', { type: 'error' });
    if (name.length > 60) return toast('الاسم طويل (60 حرفاً كحد أقصى)', { type: 'error' });
    try {
      const p = await API.updateMyProfile(state.me.id, { name });
      await updateMe({ name: p.name });
      toast('تم حفظ الاسم', { type: 'success' });
    } catch (err) {
      toast(arabicError(err), { type: 'error' });
    }
  }

  async function changePassword() {
    if (needNet()) return;
    const r = await promptDialog({
      title: 'تغيير كلمة المرور',
      fields: [
        { name: 'cur', type: 'password', placeholder: 'كلمة المرور الحالية', autocomplete: 'current-password', dir: 'ltr' },
        { name: 'n1', type: 'password', placeholder: 'الجديدة (8 أحرف على الأقل)', autocomplete: 'new-password', dir: 'ltr' },
        { name: 'n2', type: 'password', placeholder: 'أعد كتابة الجديدة', autocomplete: 'new-password', dir: 'ltr' },
      ],
    });
    if (!r) return;
    if (r.n1.length < 8) return toast('كلمة المرور الجديدة قصيرة (8 أحرف على الأقل)', { type: 'error' });
    if (r.n1 !== r.n2) return toast('كلمتا المرور الجديدتان غير متطابقتين', { type: 'error' });
    try {
      await API.auth.verifyPassword(state.me.email, r.cur);
    } catch (err) {
      return toast('كلمة المرور الحالية غير صحيحة', { type: 'error' });
    }
    try {
      await API.auth.updatePassword(r.n1);
      toast('تم تغيير كلمة المرور', { type: 'success' });
    } catch (err) {
      toast(arabicError(err), { type: 'error' });
    }
  }

  // ---------- الإشعارات ----------
  const pushItemHost = el('div', {});
  async function paintPush() {
    const st = pushStatus();
    pushItemHost.replaceChildren();
    if (!st.supported) {
      pushItemHost.append(item('bell', 'الإشعارات', st.needsInstall ? 'أضف التطبيق إلى الشاشة الرئيسية ثم افتحه منها أولاً' : 'غير مدعومة في هذا المتصفح', () => toast(st.needsInstall ? 'على iPhone: زر المشاركة ← إضافة إلى الشاشة الرئيسية' : 'غير مدعومة هنا', { ms: 4500 })));
      return;
    }
    if (st.needsInstall) {
      pushItemHost.append(item('bell', 'الإشعارات', 'تعمل بعد إضافة التطبيق إلى الشاشة الرئيسية (iOS 16.4+)', () => toast('زر المشاركة ← إضافة إلى الشاشة الرئيسية، ثم افتح التطبيق من الأيقونة', { ms: 5000 })));
      return;
    }
    const sub = await currentSubscription().catch(() => null);
    const on_ = st.permission === 'granted' && !!sub;
    pushItemHost.append(item('bell', on_ ? 'إيقاف الإشعارات على هذا الجهاز' : 'تفعيل الإشعارات', on_ ? 'مفعّلة' : st.configured ? 'لتصلك الرسائل والتطبيق مغلق' : 'غير مُعدّة بعد (VAPID)', async () => {
      try {
        if (on_) { await disablePush(); toast('تم إيقاف الإشعارات'); }
        else { await enablePush(); toast('تم تفعيل الإشعارات', { type: 'success' }); }
      } catch (e) {
        toast(pushError(e), { type: 'error', ms: 5200 });
      }
      paintPush();
    }));
  }

  // ---------- النسخ الاحتياطي ----------
  async function exportJSON() {
    try {
      const { blob, backup } = await backupToBlob(state.me);
      const r = await shareOrDownload(blob, backupFileName('backup') + '.json', 'application/json');
      if (r !== 'cancelled') {
        ls.set('lastBackup:' + state.me.id, new Date().toISOString());
        toast(`تم تصدير ${backup.counts.messages} رسالة. احفظها في تطبيق «الملفات»`, { type: 'success', ms: 4500 });
        paintBackupInfo();
      }
    } catch (e) {
      toast('فشل التصدير: ' + arabicError(e), { type: 'error' });
    }
  }

  async function exportCSV() {
    try {
      const { blob, rowCount } = await buildCSV(state.me);
      if (!rowCount) return toast('لا توجد رسائل لتصديرها');
      const r = await shareOrDownload(blob, backupFileName('messages') + '.csv', 'text/csv');
      if (r !== 'cancelled') toast(`تم تصدير ${rowCount} رسالة`, { type: 'success' });
    } catch (e) {
      toast('فشل التصدير: ' + arabicError(e), { type: 'error' });
    }
  }

  async function onImport(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 100 * 1024 * 1024) return toast('الملف كبير جداً', { type: 'error' });
      const v = await validateBackup(await f.text(), state.me.id);
      if (!v.ok) return toast(v.error, { type: 'error', ms: 5500 });
      const ok = await confirmDialog({
        title: 'استعادة النسخة الاحتياطية',
        message: `النسخة تحتوي على ${v.summary.messages} رسالة في ${v.summary.conversations} محادثة (بتاريخ ${new Date(v.summary.exportedAt).toLocaleDateString('ar')}).\n\nستُضاف الرسائل المفقودة إلى هذا الجهاز فقط، ولا يُستبدل ولا يُحذف أي شيء موجود. لا يتم رفع شيء إلى الإنترنت.`,
        confirmText: 'استعادة',
      });
      if (!ok) return;
      const res = await importBackup(v.backup);
      await reloadCache();
      toast(`أُضيفت ${res.added} رسالة` + (res.skippedNoConv ? ` (تم تخطي ${res.skippedNoConv} لمحادثات غير موجودة)` : ''), { type: 'success', ms: 5000 });
    } catch (err) {
      toast('فشلت الاستعادة: ' + arabicError(err), { type: 'error' });
    }
  }

  const backupInfo = el('small', {});
  function paintBackupInfo() {
    const t = ls.get('lastBackup:' + state.me.id);
    backupInfo.textContent = t ? `آخر نسخة: ${new Date(t).toLocaleString('ar')}` : 'لم تُصدّر نسخة بعد';
  }

  // ---------- حذف الحساب ----------
  async function deleteAccount() {
    if (needNet()) return;
    const ok = await confirmDialog({
      title: 'حذف الحساب نهائياً',
      message: 'سيُحذف حسابك وكل رسائلك وملفاتك من الخادم، وتُحذف المحادثات لدى الطرف الآخر أيضاً. لا يمكن التراجع.',
      confirmText: 'متابعة',
      danger: true,
    });
    if (!ok) return;
    const r = await promptDialog({
      title: 'تأكيد أخير',
      message: 'اكتب كلمة «حذف» للتأكيد.',
      fields: [{ name: 'w', placeholder: 'حذف' }],
      confirmText: 'حذف حسابي',
    });
    if (!r || r.w.trim() !== 'حذف') return r && toast('لم يتم الحذف: الكلمة غير مطابقة');
    try {
      for (const c of state.convs.values()) await API.removeConvFiles(c.id);
      await API.removeAvatarFiles(state.me.id);
      await API.deleteAccountOnServer();
      try { await disablePush(); } catch { /* ignore */ }
      try { await API.auth.signOut(); } catch { /* الحساب حُذف: قد يفشل */ }
      await endSession();
      nav.showAuth('login', { notice: 'تم حذف حسابك.' });
    } catch (e) {
      toast('تعذّر حذف الحساب: ' + arabicError(e), { type: 'error', ms: 5500 });
    }
  }

  // ---------- التحديثات ----------
  const verEl = el('div', { class: 'version' }, '');
  async function paintVersion() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const w = reg && (reg.active || reg.waiting);
      if (!w) return;
      const ch = new MessageChannel();
      navigator.serviceWorker.addEventListener('message', function h(e) {
        if (e.data && e.data.type === 'VERSION') { verEl.textContent = `${CONFIG.APP_NAME} — الإصدار ${e.data.version}`; navigator.serviceWorker.removeEventListener('message', h); }
      });
      w.postMessage({ type: 'GET_VERSION' });
      void ch;
    } catch { /* ignore */ }
  }

  // ---------- البناء ----------
  const avatarBtn = el('button', { class: 'avatar-btn', 'aria-label': 'تغيير الصورة', onclick: () => { if (!needNet()) fileAvatar.click(); } });
  const nameEl = el('div', { style: 'font-size:20px;font-weight:700' });
  const mailEl = el('div', { class: 'hint', style: 'direction:ltr' });
  function paintProfile() {
    avatarBtn.replaceChildren(avatarEl(state.me, 96), el('span', { class: 'cam', html: icon('camera', 16) }));
    nameEl.textContent = state.me.name || '—';
    mailEl.textContent = state.me.email || '';
  }

  const chatsGroup = el('div', { class: 'group' });
  function paintChats() {
    chatsGroup.replaceChildren(el('h4', {}, 'المحادثات'));
    const list = [...state.convs.values()];
    if (!list.length) chatsGroup.append(el('div', { class: 'note' }, 'لا توجد محادثات.'));
    for (const c of list) {
      const p = otherProfile(c);
      chatsGroup.append(item('trash', `حذف المحادثة مع ${displayName(p)}`, c.status === 'accepted' ? 'تُحذف عند الطرفين' : 'طلب معلّق', () => confirmDeleteConversation(c), 'danger'));
    }
  }

  body.append(
    el('div', { class: 'settings-body' },
      el('div', { class: 'group' }, el('div', { class: 'profile-edit' }, avatarBtn, nameEl, mailEl,
        el('button', { class: 'btn ghost small', onclick: editName }, 'تعديل الاسم'))),
      el('div', { class: 'group' }, el('h4', {}, 'الإشعارات'), pushItemHost),
      el('div', { class: 'group' }, el('h4', {}, 'الأمان'), item('lock', 'تغيير كلمة المرور', '', changePassword)),
      chatsGroup,
      el('div', { class: 'group' },
        el('h4', {}, 'النسخ الاحتياطي'),
        el('div', { class: 'item', style: 'min-height:0;padding-block:6px' }, el('span', { class: 'grow' }, backupInfo)),
        item('download', 'تصدير نسخة احتياطية (JSON)', 'يُحفظ في تطبيق «الملفات»', exportJSON),
        item('file', 'تصدير الرسائل (CSV)', 'للفتح في Excel / Numbers', exportCSV),
        item('upload', 'استعادة من نسخة احتياطية', 'يتحقق من الملف ثم يطلب تأكيدك', () => fileImport.click())
      ),
      el('div', { class: 'note' },
        'رسائلك محفوظة على خادم Supabase ومنسوخة على هذا الجهاز للعمل دون إنترنت. حذف بيانات Safari أو فقدان الجهاز قد يحذف النسخة المحلية فقط، وتعود المحادثات عند تسجيل الدخول. ',
        'النسخة الاحتياطية لا تتضمن كلمة المرور ولا ملفات الصور/الفيديو/الصوت، والمتصفح لا يستطيع رفعها تلقائياً إلى iCloud Drive؛ احفظها يدوياً في «الملفات».'
      ),
      el('div', { class: 'group' },
        el('h4', {}, 'الحساب'),
        item('refresh', 'التحقق من وجود تحديث للتطبيق', '', async () => {
          try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); toast('تم التحقق. سيظهر إشعار إن وُجد تحديث', { ms: 3000 }); } catch { toast('تعذّر التحقق الآن', { type: 'error' }); }
        }),
        item('logout', 'تسجيل الخروج', state.me.email, logout),
        item('trash', 'حذف الحساب', 'حذف نهائي لكل بياناتك', deleteAccount, 'danger')
      ),
      verEl
    )
  );

  paintProfile();
  paintChats();
  paintBackupInfo();
  paintPush();
  paintVersion();
  const offs = [on('me', paintProfile), on('convs', paintChats), on('profile', paintChats)];
  return () => offs.forEach((f) => f());
}

