// =====================================================================
//  شاشة المحادثة: عرض الرسائل، الإرسال (نص/صور/فيديو/صوت)، الحذف، المعرض
// =====================================================================
import { CONFIG } from './config.js';
import { el, uuid, fmtTime, fmtDayLabel, dayKey, fmtDuration, extFor, shareOrDownload } from './util.js';
import { icon } from './icons.js';
import { avatarEl, toast, confirmDialog, actionSheet, arabicError, longPress } from './ui.js';
import {
  state, on, visibleMsgs, getMsgs, otherProfile, queueMessage, retryFailed, discardPending,
  deleteMyMessage, hideForMe, loadOlder, scheduleAck,
} from './state.js';
import { compressImage, probeVideo, VoiceRecorder, getMediaUrl, getVideoSrc, getMediaBlob } from './media.js';
import { displayName, confirmDeleteConversation } from './list.js';
import { nav } from './nav.js';

const MAX_IMAGES = 10;
let playing = null; // الصوت الجاري تشغيله (واحد فقط في كل مرة)

// ---------------------------------------------------------------------
// أجزاء الرسالة
// ---------------------------------------------------------------------
function ticksEl(m) {
  if (m.failed) return el('span', { class: 'ticks fail', html: icon('alert', 15) });
  if (m.pending) return el('span', { class: 'ticks', html: icon('clock', 14) });
  if (m.read_at) return el('span', { class: 'ticks read', 'aria-label': 'تمت القراءة', html: icon('checks', 16) });
  if (m.delivered_at) return el('span', { class: 'ticks', 'aria-label': 'وصلت', html: icon('checks', 16) });
  return el('span', { class: 'ticks', 'aria-label': 'أُرسلت', html: icon('check', 15) });
}

function metaEl(m) {
  const mine = m.sender_id === state.me.id;
  return el('div', { class: 'meta' },
    m.failed ? el('span', { class: 'local-tag' }, 'فشل الإرسال — اضغط للخيارات') : null,
    m.local_only ? el('span', { class: 'local-tag' }, 'من نسخة احتياطية') : null,
    el('span', {}, fmtTime(m.created_at)),
    mine ? ticksEl(m) : null
  );
}

function imageGrid(m, openLightbox) {
  const items = (m.media || []).filter((x) => x && x.path);
  const shown = items.slice(0, 4);
  const grid = el('div', { class: `media-grid n${Math.min(shown.length, 4)}` });
  shown.forEach((entry, i) => {
    const cell = el('button', { class: 'cell', 'aria-label': 'عرض الصورة', onclick: () => openLightbox(m, i) },
      el('div', { class: 'ph' }, el('div', { class: 'spinner' }))
    );
    const load = () => {
      cell.querySelector('.ph').replaceChildren(el('div', { class: 'spinner' }));
      getMediaUrl(entry, m).then((url) => {
        const img = el('img', { alt: '', draggable: 'false' });
        img.onload = () => cell.querySelector('.ph') && cell.querySelector('.ph').remove();
        img.onerror = () => cell.querySelector('.ph') && cell.querySelector('.ph').replaceChildren('تعذّر التحميل');
        img.src = url;
        cell.prepend(img);
      }).catch(() => {
        const ph = cell.querySelector('.ph');
        if (ph) ph.replaceChildren(!navigator.onLine ? 'غير متاحة دون إنترنت' : 'تعذّر التحميل');
      });
    };
    load();
    if (i === 3 && items.length > 4) cell.append(el('div', { class: 'more' }, `+${items.length - 4}`));
    grid.append(cell);
  });
  return grid;
}

function videoBox(m) {
  const entry = (m.media || [])[0];
  const wrap = el('div', { class: 'video-wrap' });
  const ph = el('div', { class: 'ph' }, el('div', { class: 'spinner' }));
  const v = el('video', { controls: true, playsinline: true, preload: 'metadata' });
  v.setAttribute('webkit-playsinline', '');
  wrap.append(v, ph);
  if (!entry) { ph.replaceChildren('الفيديو غير متوفر'); return wrap; }
  getVideoSrc(entry, m).then((src) => {
    v.src = src;
    v.addEventListener('loadedmetadata', () => ph.remove(), { once: true });
    v.addEventListener('error', () => { ph.style.pointerEvents = 'none'; ph.replaceChildren(!navigator.onLine ? 'غير متاح دون إنترنت' : 'تعذّر تشغيل الفيديو'); }, { once: true });
  }).catch(() => ph.replaceChildren(!navigator.onLine ? 'غير متاح دون إنترنت' : 'تعذّر تحميل الفيديو'));
  v.addEventListener('play', () => { if (playing && playing !== v) playing.pause(); playing = v; });
  return wrap;
}

function audioBox(m) {
  const entry = (m.media || [])[0];
  const box = el('div', { class: 'audio' });
  const play = el('button', { class: 'play', 'aria-label': 'تشغيل', html: icon('play', 20), disabled: true });
  const fill = el('div', { class: 'fill' });
  const track = el('div', { class: 'track' }, fill);
  const dur = el('div', { class: 'dur' }, fmtDuration(entry && entry.dur));
  box.append(play, track, dur);
  if (!entry) { box.replaceChildren(el('div', { class: 'broken' }, 'الرسالة الصوتية غير متوفرة')); return box; }

  const audio = new Audio();
  audio.preload = 'auto';
  // نجهّز الملف مسبقاً لتبدأ العملية بضغطة المستخدم مباشرة (شرط iOS)
  getMediaUrl(entry, m).then((url) => { audio.src = url; play.disabled = false; })
    .catch(() => { box.replaceChildren(el('div', { class: 'broken' }, !navigator.onLine ? 'غير متاحة دون إنترنت' : 'تعذّر تحميل الرسالة الصوتية')); });

  const setIcon = (name) => { play.innerHTML = icon(name, 20); play.setAttribute('aria-label', name === 'play' ? 'تشغيل' : 'إيقاف مؤقت'); };
  play.addEventListener('click', () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch((e) => toast(arabicError(e), { type: 'error' }));
    } else audio.pause();
  });
  audio.addEventListener('play', () => setIcon('pause'));
  audio.addEventListener('pause', () => setIcon('play'));
  audio.addEventListener('ended', () => { setIcon('play'); fill.style.width = '0'; dur.textContent = fmtDuration(entry.dur || audio.duration); });
  audio.addEventListener('loadedmetadata', () => { if (!entry.dur && isFinite(audio.duration)) dur.textContent = fmtDuration(audio.duration); });
  audio.addEventListener('timeupdate', () => {
    const total = isFinite(audio.duration) && audio.duration ? audio.duration : entry.dur || 0;
    if (total) fill.style.width = `${Math.min(100, (audio.currentTime / total) * 100)}%`;
    dur.textContent = fmtDuration(audio.paused && !audio.currentTime ? total : audio.currentTime);
  });
  track.addEventListener('click', (e) => {
    const r = track.getBoundingClientRect();
    const total = isFinite(audio.duration) && audio.duration ? audio.duration : entry.dur || 0;
    if (total) audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
  });
  box._audio = audio;
  return box;
}

// ---------------------------------------------------------------------
// الشاشة
// ---------------------------------------------------------------------
export function renderChat(convId) {
  const conv = state.convs.get(convId);
  const host = document.getElementById('screen-chat');
  host.replaceChildren();
  if (!conv) { nav.showList(); return () => {}; }
  state.chatId = convId;

  // ---------- الهيكل ----------
  const headAvatar = el('div', {});
  const nameEl = el('div', { class: 'nm' });
  const stEl = el('div', { class: 'st' });
  const head = el('div', { class: 'chat-head' }, headAvatar, el('div', { class: 'who' }, nameEl, stEl));
  const bar = el('div', { class: 'bar' },
    el('button', { class: 'icon-btn', 'aria-label': 'رجوع', onclick: () => nav.back(), html: icon('back', 24) }),
    head,
    el('button', { class: 'icon-btn', 'aria-label': 'خيارات', onclick: () => menu(), html: icon('more', 24) })
  );
  const conn = el('div', { class: 'conn-bar', hidden: true });
  const olderBtn = el('button', { class: 'btn ghost small load-older', onclick: onLoadOlder }, 'تحميل رسائل أقدم');
  const msgsEl = el('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' }, olderBtn);

  const tray = el('div', { class: 'tray', hidden: true });
  const ta = el('textarea', { rows: 1, placeholder: 'اكتب رسالة…', 'aria-label': 'نص الرسالة', enterkeyhint: 'enter', autocomplete: 'off' });
  const actionBtn = el('button', { class: 'round noflip', 'aria-label': 'تسجيل رسالة صوتية', type: 'button' });
  const attachBtn = el('button', { class: 'round plain noflip', 'aria-label': 'إرفاق', type: 'button', html: icon('plus', 26), onclick: () => attachMenu() });
  const composer = el('div', { class: 'composer' }, attachBtn, ta, actionBtn);
  const recBar = el('div', { class: 'rec-bar', hidden: true });
  const wrapC = el('div', { class: 'composer-wrap' }, tray, composer, recBar);

  const mkInput = (accept, capture, multiple) => el('input', {
    type: 'file', accept, capture: capture || false, multiple: multiple || false, hidden: true,
    onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; },
  });
  const inGallery = mkInput('image/*', null, true);
  const inCamera = mkInput('image/*', 'environment', false);
  const inVideo = mkInput('video/*', null, true);
  const inVideoCam = mkInput('video/*', 'environment', false);

  host.append(bar, conn, msgsEl, wrapC, inGallery, inCamera, inVideo, inVideoCam);

  // ---------- العنوان ----------
  function paintHead() {
    const c = state.convs.get(convId) || conv;
    const p = otherProfile(c);
    headAvatar.replaceChildren(avatarEl(p, 40));
    nameEl.textContent = displayName(p);
    stEl.textContent = !navigator.onLine || !state.online ? 'بدون اتصال — الرسائل ستُرسل لاحقاً' : p.email || '';
    const offline = !navigator.onLine || !state.online;
    conn.hidden = !offline;
    conn.textContent = offline ? 'لا يوجد اتصال — ستُرسل رسائلك عند عودة الإنترنت' : '';
  }

  // ---------- بناء رسالة ----------
  function buildMsg(m) {
    const mine = m.sender_id === state.me.id;
    const mediaKind = m.kind === 'image' || m.kind === 'video';
    const bubble = el('div', { class: `bubble ${mediaKind ? 'media-only' : ''}` });
    if (m.kind === 'image') bubble.append(imageGrid(m, openLightbox));
    else if (m.kind === 'video') bubble.append(videoBox(m));
    else if (m.kind === 'audio') bubble.append(audioBox(m));
    if (m.body) bubble.append(el('div', { class: 'txt' }, m.body));
    bubble.append(metaEl(m));
    const node = el('div', { class: `msg ${mine ? 'mine' : 'theirs'}`, 'data-id': m.id }, bubble);
    longPress(bubble, () => messageMenu(m.id));
    bubble.addEventListener('click', () => {
      const cur = getMsgs(convId).find((x) => x.id === m.id);
      if (cur && cur.failed) messageMenu(m.id);
    });
    return node;
  }

  function updateMeta(node, m) {
    const old = node.querySelector('.meta');
    if (old) old.replaceWith(metaEl(m));
  }

  const nodes = new Map();
  const seps = new Map();
  const place = (node, ref) => {
    if (node === ref) return ref.nextSibling;
    msgsEl.insertBefore(node, ref);
    return ref;
  };

  let holdScroll = false;
  let forceBottom = true;
  let rafPending = false;
  const nearBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 140;
  const toBottom = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };

  function reconcile() {
    const wasNear = nearBottom();
    const list = visibleMsgs(convId);
    const ids = new Set(list.map((m) => m.id));
    for (const [id, n] of nodes) if (!ids.has(id)) { n.remove(); nodes.delete(id); }
    const days = new Set(list.map((m) => dayKey(m.created_at)));
    for (const [k, n] of seps) if (!days.has(k)) { n.remove(); seps.delete(k); }
    olderBtn.hidden = state.noMore.has(convId);
    let ref = olderBtn.nextSibling;
    let lastDay = null;
    for (const m of list) {
      const dk = dayKey(m.created_at);
      if (dk !== lastDay) {
        lastDay = dk;
        let s = seps.get(dk);
        if (!s) { s = el('div', { class: 'day-sep' }, fmtDayLabel(m.created_at)); seps.set(dk, s); }
        ref = place(s, ref);
      }
      let n = nodes.get(m.id);
      if (!n) { n = buildMsg(m); nodes.set(m.id, n); } else updateMeta(n, m);
      ref = place(n, ref);
    }
    if (!holdScroll && (forceBottom || wasNear)) { toBottom(); forceBottom = false; }
  }
  function scheduleReconcile() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; reconcile(); });
  }

  async function onLoadOlder() {
    olderBtn.disabled = true;
    holdScroll = true;
    const h0 = msgsEl.scrollHeight, t0 = msgsEl.scrollTop;
    try {
      await loadOlder(convId);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      msgsEl.scrollTop = t0 + (msgsEl.scrollHeight - h0);
    } catch (e) {
      toast(arabicError(e), { type: 'error' });
    } finally {
      holdScroll = false;
      olderBtn.disabled = false;
    }
  }

  // ---------- قوائم ----------
  function menu() {
    const c = state.convs.get(convId);
    if (!c) return;
    actionSheet({
      title: displayName(otherProfile(c)),
      actions: [{
        label: 'حذف المحادثة', icon: 'trash', danger: true,
        onSelect: async () => { if (await confirmDeleteConversation(c)) { /* حدث conv-removed يعيدنا للقائمة */ } },
      }],
    });
  }

  function messageMenu(id) {
    const m = getMsgs(convId).find((x) => x.id === id);
    if (!m) return;
    const mine = m.sender_id === state.me.id;
    const actions = [];
    if (m.failed) {
      actions.push({ label: 'إعادة المحاولة', icon: 'refresh', onSelect: () => retryFailed(m.id) });
      actions.push({ label: 'حذف الرسالة', icon: 'trash', danger: true, onSelect: () => discardPending(m.id) });
      return actionSheet({ title: 'فشل الإرسال' + (m.error ? ` — ${m.error}` : ''), actions });
    }
    if (m.body) actions.push({ label: 'نسخ النص', icon: 'copy', onSelect: () => copyText(m.body) });
    if ((m.kind === 'image' || m.kind === 'video' || m.kind === 'audio') && (m.media || []).length) {
      actions.push({ label: 'حفظ / مشاركة', icon: 'download', onSelect: () => saveMedia(m) });
    }
    if (!m.pending) actions.push({ label: 'حذف عندي فقط', icon: 'trash', danger: !mine, onSelect: () => hideForMe(m) });
    if (mine) {
      actions.push({
        label: m.pending ? 'إلغاء الإرسال' : 'حذف عند الجميع', icon: 'trash', danger: true,
        onSelect: async () => {
          if (!m.pending) {
            if (!navigator.onLine) return toast('تحتاج إلى اتصال بالإنترنت لحذف الرسالة عند الطرفين', { type: 'error' });
            const ok = await confirmDialog({ title: 'حذف الرسالة', message: 'ستُحذف الرسالة من عندك ومن عند الطرف الآخر.', confirmText: 'حذف', danger: true });
            if (!ok) return;
          }
          try { await deleteMyMessage(m); } catch (e) { toast(arabicError(e), { type: 'error' }); }
        },
      });
    }
    actionSheet({ actions });
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('تم النسخ', { type: 'success', ms: 1400 }); }
    catch { toast('تعذّر النسخ', { type: 'error' }); }
  }

  async function saveMedia(m) {
    try {
      const entries = m.media || [];
      for (let i = 0; i < entries.length; i++) {
        const blob = await getMediaBlob(entries[i], m);
        const name = `risa2li-${Date.now()}-${i + 1}.${extFor(entries[i].type || blob.type)}`;
        const r = await shareOrDownload(blob, name, entries[i].type || blob.type);
        if (r === 'cancelled') break;
      }
    } catch (e) {
      toast(!navigator.onLine ? 'الملف غير محفوظ على الجهاز ولا يوجد اتصال' : arabicError(e), { type: 'error' });
    }
  }

  // ---------- معرض الصور ----------
  let lightbox = null;
  function closeLightbox() { if (lightbox) { lightbox.remove(); lightbox = null; } }
  async function openLightbox(m, start) {
    closeLightbox();
    const items = (m.media || []).filter((x) => x && x.path);
    let idx = start;
    const img = el('img', { alt: '' });
    const count = el('div', { class: 'count' });
    const stage = el('div', { class: 'stage' }, img);
    const show = async (i) => {
      idx = (i + items.length) % items.length;
      count.textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
      img.removeAttribute('src');
      try { img.src = await getMediaUrl(items[idx], m); } catch { toast('تعذّر تحميل الصورة', { type: 'error' }); }
    };
    if (items.length > 1) {
      stage.append(
        el('button', { class: 'nav prev', 'aria-label': 'السابقة', onclick: () => show(idx - 1), html: icon('chevron', 24) }),
        el('button', { class: 'nav next', 'aria-label': 'التالية', onclick: () => show(idx + 1), html: icon('chevron', 24) })
      );
      let sx = 0;
      stage.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 60) show(idx + (dx < 0 ? 1 : -1)); });
    }
    lightbox = el('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'top' },
        el('button', { class: 'icon-btn', 'aria-label': 'إغلاق', onclick: closeLightbox, html: icon('x', 26) }),
        count,
        el('button', { class: 'icon-btn', 'aria-label': 'حفظ', onclick: async () => {
          try { const b = await getMediaBlob(items[idx], m); await shareOrDownload(b, `risa2li-${Date.now()}.${extFor(items[idx].type || b.type)}`, items[idx].type || b.type); }
          catch (e) { toast(arabicError(e), { type: 'error' }); }
        }, html: icon('download', 24) })
      ),
      stage,
      el('div', { class: 'bottom' })
    );
    document.getElementById('overlay-root').append(lightbox);
    show(idx);
  }

  // ---------- المرفقات (صور/فيديو) ----------
  let attachments = []; // {id, kind, file, url}
  function paintTray() {
    tray.replaceChildren();
    tray.hidden = !attachments.length;
    for (const a of attachments) {
      tray.append(el('div', { class: 'item' },
        a.kind === 'image' ? el('img', { src: a.url, alt: '' }) : el('span', { html: icon('video', 28) }),
        el('button', { class: 'rm', 'aria-label': 'إزالة', onclick: () => { URL.revokeObjectURL(a.url); attachments = attachments.filter((x) => x !== a); paintTray(); paintAction(); }, html: icon('x', 14) })
      ));
    }
  }

  function addFiles(files) {
    for (const f of files) {
      const isVideo = (f.type || '').startsWith('video/');
      const isImage = (f.type || '').startsWith('image/');
      if (!isVideo && !isImage) { toast('نوع الملف غير مدعوم', { type: 'error' }); continue; }
      if (isVideo && f.size > CONFIG.MAX_VIDEO_MB * 1024 * 1024) {
        toast(`حجم الفيديو أكبر من ${CONFIG.MAX_VIDEO_MB}MB (حد الخطة المجانية)`, { type: 'error', ms: 4500 });
        continue;
      }
      if (isImage && attachments.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
        toast(`الحد الأقصى ${MAX_IMAGES} صور في الرسالة الواحدة`, { type: 'error' });
        continue;
      }
      attachments.push({ id: uuid(), kind: isVideo ? 'video' : 'image', file: f, url: URL.createObjectURL(f) });
    }
    paintTray();
    paintAction();
  }

  function attachMenu() {
    actionSheet({
      actions: [
        { label: 'صورة من المعرض', icon: 'image', onSelect: () => inGallery.click() },
        { label: 'التقاط صورة', icon: 'camera', onSelect: () => inCamera.click() },
        { label: 'فيديو من المعرض', icon: 'video', onSelect: () => inVideo.click() },
        { label: 'تصوير فيديو', icon: 'video', onSelect: () => inVideoCam.click() },
      ],
    });
  }

  // ---------- الإرسال ----------
  const hasContent = () => ta.value.trim().length > 0 || attachments.length > 0;

  function paintAction() {
    const send = hasContent();
    actionBtn.classList.toggle('noflip', !send);
    actionBtn.innerHTML = icon(send ? 'send' : 'mic', 22);
    actionBtn.setAttribute('aria-label', send ? 'إرسال' : 'تسجيل رسالة صوتية');
    actionBtn.dataset.mode = send ? 'send' : 'mic';
  }

  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
  }

  async function sendCurrent() {
    if (!hasContent()) return;
    // نفرّغ الحقول فوراً: يستطيع المستخدم كتابة الرسالة التالية دون انتظار، ولا يتكرر الإرسال بالضغط المزدوج
    let text = ta.value.trim();
    const original = text;
    const list = attachments.slice();
    attachments = [];
    ta.value = '';
    autosize();
    paintTray();
    paintAction();
    forceBottom = true;
    let remaining = list.slice(); // مرفقات لم تُحفظ بعد
    let textSaved = false;
    try {
      const images = list.filter((a) => a.kind === 'image');
      const videos = list.filter((a) => a.kind === 'video');
      if (images.length) {
        const files = [];
        const media = [];
        for (const a of images) {
          const { blob, w, h, type } = await compressImage(a.file);
          const path = `${convId}/${uuid()}.${extFor(type)}`;
          files.push({ path, blob, type });
          media.push({ path, type, w, h, size: blob.size });
        }
        await queueMessage({ conv: convId, kind: 'image', body: text || null, media, files });
        remaining = remaining.filter((a) => a.kind !== 'image');
        if (text) textSaved = true;
        text = '';
      }
      for (const a of videos) {
        const info = await probeVideo(a.file);
        const type = a.file.type || 'video/mp4';
        const path = `${convId}/${uuid()}.${extFor(type)}`;
        await queueMessage({
          conv: convId, kind: 'video', body: text || null,
          media: [{ path, type, w: info.w, h: info.h, dur: info.dur, size: a.file.size }],
          files: [{ path, blob: a.file, type }],
        });
        remaining = remaining.filter((x) => x !== a);
        if (text) textSaved = true;
        text = '';
      }
      if (text) { await queueMessage({ conv: convId, kind: 'text', body: text }); textSaved = true; }
      list.forEach((a) => URL.revokeObjectURL(a.url));
    } catch (e) {
      // لا تضيع رسالة المستخدم عند الفشل: نعيد النص والمرفقات التي لم تُحفظ
      attachments = remaining.concat(attachments);
      if (!textSaved && !ta.value) ta.value = original;
      autosize(); paintTray(); paintAction();
      toast(arabicError(e), { type: 'error', ms: 4500 });
    }
    if (!('ontouchstart' in window)) ta.focus();
  }

  // ---------- التسجيل الصوتي ----------
  let recorder = null;
  let recTimer = null;

  function endRecUi() {
    clearInterval(recTimer);
    recBar.hidden = true;
    composer.hidden = false;
    tray.hidden = !attachments.length;
    recorder = null;
  }

  async function startRecording() {
    if (!VoiceRecorder.supported()) return toast('التسجيل الصوتي غير مدعوم في هذا المتصفح', { type: 'error' });
    const r = new VoiceRecorder({ onLimit: () => finishRecording(true) });
    try {
      await r.start();
    } catch (e) {
      r.cancel();
      return toast(e && e.name === 'NotAllowedError' ? 'لم يُسمح بالميكروفون. فعّله من إعدادات الجهاز ثم أعد المحاولة' : arabicError(e), { type: 'error', ms: 5000 });
    }
    recorder = r;
    composer.hidden = true;
    tray.hidden = true;
    const time = el('div', { class: 'rec-time' }, '0:00');
    recBar.replaceChildren(
      el('button', { class: 'round plain noflip', 'aria-label': 'إلغاء التسجيل', onclick: () => { r.cancel(); endRecUi(); }, html: icon('trash', 24), style: 'color:var(--danger)' }),
      el('span', { class: 'rec-dot' }),
      time,
      el('span', { class: 'rec-label' }, 'جاري التسجيل'),
      el('button', { class: 'round', 'aria-label': 'إرسال التسجيل', onclick: () => finishRecording(true), html: icon('send', 22) })
    );
    recBar.hidden = false;
    recTimer = setInterval(() => { time.textContent = fmtDuration(r.elapsedMs / 1000); }, 250);
  }

  async function finishRecording(send) {
    const r = recorder;
    if (!r) return;
    recorder = null;
    try {
      const { blob, type, duration } = await r.stop();
      endRecUi();
      if (!send) return;
      if (duration < 0.7 || blob.size < 500) return toast('التسجيل قصير جداً', { type: 'error' });
      const path = `${convId}/${uuid()}.${extFor(type)}`;
      await queueMessage({ conv: convId, kind: 'audio', media: [{ path, type, dur: Math.round(duration * 10) / 10, size: blob.size }], files: [{ path, blob, type }] });
      forceBottom = true;
    } catch (e) {
      endRecUi();
      toast(arabicError(e), { type: 'error' });
    }
  }

  // ---------- ربط الأحداث ----------
  actionBtn.addEventListener('click', () => (hasContent() ? sendCurrent() : startRecording()));
  ta.addEventListener('input', () => { autosize(); paintAction(); });
  ta.addEventListener('keydown', (e) => {
    // Enter يرسل على الكمبيوتر فقط؛ على الهاتف يبقى سطراً جديداً
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); sendCurrent(); }
  });
  ta.addEventListener('focus', () => setTimeout(() => { toBottom(); }, 320));

  const offs = [
    on('msgs', (d) => {
      if (d.conv !== convId) return;
      if (d.type === 'add' && d.msg.sender_id === state.me.id) forceBottom = true;
      scheduleReconcile();
    }),
    on('conv-removed', (id) => {
      if (id === convId) { toast('تم حذف هذه المحادثة'); nav.showList(); }
    }),
    on('conn', paintHead),
    on('convs', paintHead),
    on('profile', paintHead),
  ];
  const onVis = () => { if (document.visibilityState === 'visible') scheduleAck(convId); };
  document.addEventListener('visibilitychange', onVis);
  const onNet = () => paintHead();
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  paintHead();
  paintAction();
  reconcile();
  requestAnimationFrame(toBottom);
  scheduleAck(convId);

  return () => {
    offs.forEach((f) => f());
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('online', onNet);
    window.removeEventListener('offline', onNet);
    closeLightbox();
    if (recorder) { recorder.cancel(); recorder = null; clearInterval(recTimer); }
    if (playing) { try { playing.pause(); } catch { /* ignore */ } playing = null; }
    attachments.forEach((a) => URL.revokeObjectURL(a.url));
    if (state.chatId === convId) state.chatId = null;
  };
}
