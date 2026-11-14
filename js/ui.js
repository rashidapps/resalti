// عناصر واجهة مشتركة: تنبيهات، نوافذ تأكيد، قوائم إجراءات، صور شخصية، ترجمة الأخطاء
import { el, initials, colorFor, isNetworkError } from './util.js';
import { icon } from './icons.js';
import { getAvatarUrl } from './media.js';

const overlay = () => document.getElementById('overlay-root');

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------
export function toast(message, { type = 'info', ms = 3400, action } = {}) {
  const host = document.getElementById('toast-root');
  if (!host) return () => {};
  const t = el(
    'div',
    { class: `toast ${type}`, role: 'status' },
    el('span', { class: 'toast-msg' }, message),
    action ? el('button', { class: 'toast-action', onclick: () => { action.onClick(); close(); } }, action.label) : null
  );
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  let timer = ms ? setTimeout(close, ms) : null;
  function close() {
    clearTimeout(timer);
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }
  t.addEventListener('click', (e) => {
    if (!e.target.closest('.toast-action')) close();
  });
  return close;
}

// ---------------------------------------------------------------------
// نافذة تأكيد
// ---------------------------------------------------------------------
export function confirmDialog({ title, message = '', confirmText = 'تأكيد', cancelText = 'إلغاء', danger = false }) {
  return new Promise((resolve) => {
    const finish = (v) => {
      back.classList.remove('show');
      setTimeout(() => back.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
    };
    const back = el(
      'div',
      { class: 'backdrop center', onclick: (e) => e.target === back && finish(false) },
      el(
        'div',
        { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        el('h3', {}, title),
        message ? el('p', {}, message) : null,
        el(
          'div',
          { class: 'dialog-actions' },
          el('button', { class: 'btn ghost', onclick: () => finish(false) }, cancelText),
          el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, confirmText)
        )
      )
    );
    overlay().append(back);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => back.classList.add('show'));
  });
}

/** نافذة إدخال نص/كلمة مرور بسيطة */
export function promptDialog({ title, message = '', fields, confirmText = 'حفظ', cancelText = 'إلغاء' }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) =>
      el('input', {
        class: 'input',
        type: f.type || 'text',
        placeholder: f.placeholder || '',
        autocomplete: f.autocomplete || 'off',
        value: f.value || '',
        'aria-label': f.placeholder || f.name,
        dir: f.dir || 'auto',
      })
    );
    const finish = (v) => {
      back.classList.remove('show');
      setTimeout(() => back.remove(), 180);
      resolve(v);
    };
    const submit = () => finish(Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value])));
    const form = el(
      'form',
      {
        class: 'dialog',
        onsubmit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      el('h3', {}, title),
      message ? el('p', {}, message) : null,
      ...inputs,
      el(
        'div',
        { class: 'dialog-actions' },
        el('button', { class: 'btn ghost', type: 'button', onclick: () => finish(null) }, cancelText),
        el('button', { class: 'btn primary', type: 'submit' }, confirmText)
      )
    );
    const back = el('div', { class: 'backdrop center', onclick: (e) => e.target === back && finish(null) }, form);
    overlay().append(back);
    requestAnimationFrame(() => {
      back.classList.add('show');
      inputs[0] && inputs[0].focus();
    });
  });
}

// ---------------------------------------------------------------------
// قائمة إجراءات (Action sheet)
// ---------------------------------------------------------------------
export function actionSheet({ title = '', actions }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.remove('show');
    setTimeout(() => back.remove(), 220);
  };
  const back = el(
    'div',
    { class: 'backdrop bottom', onclick: (e) => e.target === back && close() },
    el(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      title ? el('div', { class: 'sheet-title' }, title) : null,
      ...actions.map((a) =>
        el(
          'button',
          {
            class: `sheet-item ${a.danger ? 'danger' : ''}`,
            onclick: () => {
              close();
              setTimeout(() => a.onSelect && a.onSelect(), 30);
            },
          },
          a.icon ? el('span', { class: 'sheet-ic', html: icon(a.icon, 22) }) : null,
          el('span', {}, a.label)
        )
      ),
      el('button', { class: 'sheet-item cancel', onclick: close }, 'إلغاء')
    )
  );
  overlay().append(back);
  requestAnimationFrame(() => back.classList.add('show'));
  return close;
}

// ---------------------------------------------------------------------
// الصورة الشخصية
// ---------------------------------------------------------------------
export function avatarEl(profile, size = 44) {
  const name = (profile && profile.name) || '';
  const node = el(
    'div',
    { class: 'avatar', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${colorFor((profile && profile.id) || name)}` },
    initials(name)
  );
  if (profile && profile.avatar_path) {
    getAvatarUrl(profile.avatar_path).then((url) => {
      if (!url || !node.isConnected && node.dataset.gone) return;
      const img = el('img', { src: url, alt: '', draggable: 'false' });
      img.onload = () => {
        node.textContent = '';
        node.append(img);
      };
    });
  }
  return node;
}

// ---------------------------------------------------------------------
// ترجمة رسائل الأخطاء
// ---------------------------------------------------------------------
export function arabicError(err) {
  if (!err) return 'حدث خطأ غير متوقع';
  if (isNetworkError(err)) return 'لا يوجد اتصال بالإنترنت. حاول مرة أخرى عند عودة الاتصال';
  const code = String(err.code || '').toLowerCase();
  const msg = String(err.message || err);
  const low = msg.toLowerCase();

  if (code === 'user_already_exists' || low.includes('already registered')) return 'هذا البريد مسجّل مسبقاً. جرّب تسجيل الدخول';
  if (low.includes('invalid login credentials') || code === 'invalid_credentials') return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
  if (low.includes('email not confirmed') || code === 'email_not_confirmed') return 'لم يتم تأكيد بريدك بعد. افتح رسالة التأكيد في بريدك ثم سجّل الدخول';
  if (code.includes('rate_limit') || err.status === 429 || low.includes('rate limit') || low.includes('too many')) return 'تم تجاوز حد الإرسال مؤقتاً. انتظر قليلاً ثم أعد المحاولة';
  if (low.includes('not authorized') && low.includes('email')) return 'خدمة البريد الافتراضية في Supabase لا ترسل إلا لأعضاء فريق المشروع. اضبط SMTP مخصصاً (راجع الدليل، قسم البريد)';
  if (code === 'weak_password' || low.includes('password should be')) return 'كلمة المرور ضعيفة: استخدم 8 أحرف على الأقل';
  if (code === 'same_password' || low.includes('different from the old')) return 'كلمة المرور الجديدة يجب أن تختلف عن الحالية';
  if (code === 'email_address_invalid' || low.includes('invalid email') || low.includes('email address') && low.includes('invalid')) return 'البريد الإلكتروني غير صالح';
  if (code === 'signup_disabled') return 'التسجيل معطّل في إعدادات Supabase';
  if (low.includes('user not found')) return 'لم يتم العثور على المستخدم';
  if (low.includes('exceeded the maximum allowed size') || low.includes('payload too large') || err.statusCode === '413') return 'الملف أكبر من الحد المسموح (50MB)';
  if (low.includes('row-level security') || code === '42501') return 'لا تملك صلاحية تنفيذ هذا الإجراء (قد تكون المحادثة حُذفت أو لم تُقبل بعد)';
  if (low.includes('jwt') || low.includes('refresh token')) return 'انتهت الجلسة. سجّل الدخول من جديد';
  if (err.name === 'NotAllowedError') return 'لم يُسمح بالوصول. فعّل الإذن من إعدادات الجهاز';
  if (err.name === 'NotFoundError') return 'لم يتم العثور على الميكروفون أو الكاميرا';
  return `حدث خطأ: ${msg}`;
}

export function spinner() {
  return el('div', { class: 'spinner', 'aria-label': 'جاري التحميل' });
}

// ---------------------------------------------------------------------
// ضغطة مطوّلة (للقوائم) + قائمة السياق في المتصفحات المكتبية
// ---------------------------------------------------------------------
export function longPress(node, handler, ms = 450) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; node.classList.remove('pressing'); };
  node.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; fired = false;
    timer = setTimeout(() => { fired = true; node.classList.remove('pressing'); if (navigator.vibrate) navigator.vibrate(8); handler(e); }, ms);
    node.classList.add('pressing');
  }, { passive: true });
  node.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
  }, { passive: true });
  node.addEventListener('touchend', (e) => { if (fired && e.cancelable) e.preventDefault(); cancel(); });
  node.addEventListener('touchcancel', cancel);
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); handler(e); });
  // يمنع نقرة "click" التالية للضغطة المطوّلة
  node.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}
