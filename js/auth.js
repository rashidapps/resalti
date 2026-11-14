// =====================================================================
//  شاشة الحساب: دخول / تسجيل / نسيان كلمة المرور / كلمة مرور جديدة / تأكيد البريد
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import { el } from './util.js';
import { toast, arabicError } from './ui.js';
import { nav } from './nav.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASS = 8;

function field(label, attrs) {
  const input = el('input', { class: 'input', ...attrs });
  const id = 'f-' + Math.random().toString(36).slice(2, 8);
  input.id = id;
  return { wrap: el('div', { class: 'field' }, el('label', { for: id }, label), input), input };
}

export function renderAuth(mode = 'login', data = {}) {
  const host = document.getElementById('screen-auth');
  host.replaceChildren();
  const card = el('div', { class: 'auth-card' });
  const titles = {
    login: 'سجّل دخولك للمتابعة',
    signup: 'أنشئ حسابك في دقيقة',
    forgot: 'استعادة كلمة المرور',
    recovery: 'اختر كلمة مرور جديدة',
    verify: 'تأكيد البريد الإلكتروني',
    setup: 'الإعداد الأولي',
  };
  card.append(
    el('div', { class: 'brand' },
      el('img', { src: 'icon-192.png', width: 84, height: 84, alt: '' }),
      el('h2', {}, CONFIG.APP_NAME),
      el('p', {}, titles[mode] || '')
    )
  );
  const box = el('div', { class: 'card' });
  card.append(box);
  host.append(card);

  const errBox = el('div', { class: 'err', role: 'alert' });
  const setErr = (m) => { errBox.textContent = m || ''; };
  const link = (text, fn) => el('button', { type: 'button', class: 'link', onclick: fn }, text);

  /** يلفّ نموذجاً: يعطّل الزر أثناء التنفيذ ويعرض الخطأ */
  function form(submitText, work, ...children) {
    const btn = el('button', { class: 'btn primary block', type: 'submit' }, submitText);
    const f = el('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        setErr('');
        btn.disabled = true;
        btn.textContent = 'لحظة…';
        try {
          await work();
        } catch (err) {
          setErr(arabicError(err));
          if (err && (err.code === 'email_not_confirmed' || /email not confirmed/i.test(err.message || ''))) {
            nav.showAuth('verify', { email: data.lastEmail || '' });
          }
        } finally {
          if (btn.isConnected) { btn.disabled = false; btn.textContent = submitText; }
        }
      },
    }, ...children, errBox, btn);
    return f;
  }

  if (mode === 'setup') {
    box.append(
      el('div', { class: 'notice warn' }, 'لم يتم ربط التطبيق بـ Supabase بعد.'),
      el('p', { class: 'note' }, 'افتح الملف js/config.js في المستودع على GitHub، وضع قيمتي SUPABASE_URL و SUPABASE_ANON_KEY، ثم احفظ وانتظر دقيقة وأعد فتح التطبيق. الخطوات التفصيلية في دليل README.')
    );
    return;
  }

  if (mode === 'login') {
    const email = field('البريد الإلكتروني', { type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr', value: data.email || '' });
    const pass = field('كلمة المرور', { type: 'password', autocomplete: 'current-password', dir: 'ltr' });
    box.append(
      data.notice ? el('div', { class: 'notice' }, data.notice) : null,
      form('دخول', async () => {
        const em = email.input.value.trim().toLowerCase();
        data.lastEmail = em;
        if (!EMAIL_RE.test(em)) throw new Error('invalid email');
        if (!pass.input.value) throw new Error('أدخل كلمة المرور');
        const res = await API.auth.signIn(em, pass.input.value);
        nav.afterAuth(res.user);
      }, email.wrap, pass.wrap),
      el('div', { class: 'auth-links' },
        link('نسيت كلمة المرور؟', () => nav.showAuth('forgot', { email: email.input.value })),
        link('إنشاء حساب جديد', () => nav.showAuth('signup', { email: email.input.value }))
      )
    );
    return;
  }

  if (mode === 'signup') {
    const name = field('الاسم', { type: 'text', autocomplete: 'name', maxlength: 60 });
    const email = field('البريد الإلكتروني', { type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr', value: data.email || '' });
    const pass = field(`كلمة المرور (${MIN_PASS} أحرف على الأقل)`, { type: 'password', autocomplete: 'new-password', dir: 'ltr' });
    const pass2 = field('أعد كتابة كلمة المرور', { type: 'password', autocomplete: 'new-password', dir: 'ltr' });
    box.append(
      form('إنشاء الحساب', async () => {
        const nm = name.input.value.trim();
        const em = email.input.value.trim().toLowerCase();
        if (!nm) throw new Error('اكتب اسمك');
        if (!EMAIL_RE.test(em)) throw new Error('invalid email');
        if (pass.input.value.length < MIN_PASS) throw Object.assign(new Error('weak'), { code: 'weak_password' });
        if (pass.input.value !== pass2.input.value) throw new Error('كلمتا المرور غير متطابقتين');
        const res = await API.auth.signUp(em, pass.input.value, nm);
        if (res.session) nav.afterAuth(res.user);
        else nav.showAuth('verify', { email: em, fresh: true });
      }, name.wrap, email.wrap, pass.wrap, pass2.wrap),
      el('div', { class: 'auth-links' }, link('لدي حساب بالفعل', () => nav.showAuth('login', { email: email.input.value })))
    );
    return;
  }

  if (mode === 'forgot') {
    const email = field('البريد الإلكتروني', { type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', dir: 'ltr', value: data.email || '' });
    const done = el('div', { class: 'notice', hidden: true }, 'إن كان هذا البريد مسجّلاً فقد أرسلنا إليه رابطاً لاختيار كلمة مرور جديدة. افتح الرابط من الرسالة ثم عد وسجّل الدخول.');
    box.append(
      el('p', { class: 'note' }, 'اكتب بريدك وسنرسل لك رابطاً لتعيين كلمة مرور جديدة.'),
      done,
      form('إرسال الرابط', async () => {
        const em = email.input.value.trim().toLowerCase();
        if (!EMAIL_RE.test(em)) throw new Error('invalid email');
        await API.auth.resetPassword(em);
        done.hidden = false;
      }, email.wrap),
      el('div', { class: 'auth-links' }, link('رجوع لتسجيل الدخول', () => nav.showAuth('login', { email: email.input.value })))
    );
    return;
  }

  if (mode === 'verify') {
    const msg = el('div', { class: 'notice' },
      data.fresh ? 'تم إنشاء حسابك. ' : '',
      `أرسلنا رسالة تأكيد إلى ${data.email || 'بريدك'}. افتح الرابط الموجود فيها، ثم ارجع وسجّل الدخول.`
    );
    const resendBtn = el('button', { class: 'btn ghost block', type: 'button', onclick: async () => {
      if (!data.email) return nav.showAuth('login');
      resendBtn.disabled = true;
      try {
        await API.auth.resend(data.email);
        toast('أُعيد إرسال رسالة التأكيد', { type: 'success' });
      } catch (e) {
        toast(arabicError(e), { type: 'error' });
      } finally {
        setTimeout(() => { if (resendBtn.isConnected) resendBtn.disabled = false; }, 30000);
      }
    } }, 'إعادة إرسال رسالة التأكيد');
    box.append(
      msg,
      el('p', { class: 'note' }, 'تحقق من مجلد الرسائل غير المرغوب فيها (Spam) إن لم تصل الرسالة خلال دقيقة.'),
      resendBtn,
      el('div', { class: 'auth-links' }, link('رجوع لتسجيل الدخول', () => nav.showAuth('login', { email: data.email })))
    );
    return;
  }

  if (mode === 'recovery') {
    const pass = field(`كلمة المرور الجديدة (${MIN_PASS} أحرف على الأقل)`, { type: 'password', autocomplete: 'new-password', dir: 'ltr' });
    const pass2 = field('أعد كتابتها', { type: 'password', autocomplete: 'new-password', dir: 'ltr' });
    box.append(
      form('حفظ كلمة المرور', async () => {
        if (pass.input.value.length < MIN_PASS) throw Object.assign(new Error('weak'), { code: 'weak_password' });
        if (pass.input.value !== pass2.input.value) throw new Error('كلمتا المرور غير متطابقتين');
        await API.auth.updatePassword(pass.input.value);
        toast('تم تغيير كلمة المرور', { type: 'success' });
        const session = await API.auth.getSession();
        if (session) nav.afterAuth(session.user);
        else nav.showAuth('login');
      }, pass.wrap, pass2.wrap)
    );
  }
}
