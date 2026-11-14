// =====================================================================
//  الوسائط: ضغط الصور، قراءة معلومات الفيديو، التسجيل الصوتي، جلب الملفات مع تخزين محلي
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import { dbGet, getCachedMedia, cacheMedia } from './db.js';
export { cacheMedia };
import { baseMime } from './util.js';

// ---------------------------------------------------------------------
// الصور
// ---------------------------------------------------------------------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        if (img.decode) await img.decode().catch(() => {});
      } finally {
        resolve({ img, url });
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('تعذّر قراءة الصورة'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('تعذّر ضغط الصورة'))), type, quality);
    } else {
      try {
        const data = atob(canvas.toDataURL(type, quality).split(',')[1]);
        const arr = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i);
        resolve(new Blob([arr], { type }));
      } catch (e) {
        reject(e);
      }
    }
  });
}

/** ضغط الصورة وتصحيح اتجاهها (EXIF) وتحويلها إلى JPEG لتوفير مساحة Supabase المجانية */
export async function compressImage(file, { maxDim = CONFIG.IMAGE_MAX_DIM, quality = CONFIG.IMAGE_QUALITY } = {}) {
  const { img, url } = await loadImage(file);
  try {
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) throw new Error('صورة غير صالحة');
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { blob, w, h, type: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** صورة شخصية مربعة */
export async function makeAvatarBlob(file, size = 384) {
  const { img, url } = await loadImage(file);
  try {
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    const side = Math.min(w0, h0);
    const sx = (w0 - side) / 2;
    const sy = (h0 - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return await canvasToBlob(canvas, 'image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------
// الفيديو
// ---------------------------------------------------------------------
export function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const done = (info) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      v.load();
      resolve(info);
    };
    const timer = setTimeout(() => done({ dur: 0, w: 0, h: 0 }), 5000);
    v.onloadedmetadata = () => done({ dur: isFinite(v.duration) ? v.duration : 0, w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => done({ dur: 0, w: 0, h: 0 });
    v.src = url;
  });
}

// ---------------------------------------------------------------------
// التسجيل الصوتي
// ---------------------------------------------------------------------
export class VoiceRecorder {
  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  static pickMime() {
    const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  constructor({ maxMs = 10 * 60 * 1000, onLimit } = {}) {
    this.maxMs = maxMs;
    this.onLimit = onLimit;
    this.chunks = [];
    this.startedAt = 0;
    this.stream = null;
    this.rec = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const mime = VoiceRecorder.pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mime = this.rec.mimeType || mime || 'audio/mp4';
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(500);
    this.startedAt = Date.now();
    this.limitTimer = setTimeout(() => this.onLimit && this.onLimit(), this.maxMs);
  }

  get elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  _release() {
    clearTimeout(this.limitTimer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec || this.rec.state === 'inactive') {
        this._release();
        reject(new Error('لا يوجد تسجيل'));
        return;
      }
      const duration = this.elapsedMs / 1000;
      this.rec.onstop = () => {
        this._release();
        const type = baseMime(this.rec.mimeType || this.mime) || 'audio/mp4';
        const blob = new Blob(this.chunks, { type });
        resolve({ blob, type, duration });
      };
      this.rec.onerror = (e) => {
        this._release();
        reject(e.error || new Error('فشل التسجيل'));
      };
      try {
        this.rec.requestData();
      } catch {
        /* بعض المتصفحات لا تدعمها */
      }
      this.rec.stop();
    });
  }

  cancel() {
    try {
      if (this.rec && this.rec.state !== 'inactive') {
        this.rec.onstop = null;
        this.rec.stop();
      }
    } catch {
      /* ignore */
    }
    this._release();
  }
}

// ---------------------------------------------------------------------
// جلب الوسائط للعرض (مع تخزين محلي ليعمل العرض دون إنترنت)
// ---------------------------------------------------------------------
const urlMemo = new Map();
const inflight = new Map();
const MAX_CACHE_FILE = 30 * 1024 * 1024;

function typed(blob, type) {
  const want = baseMime(type);
  return want && baseMime(blob.type) !== want ? new Blob([blob], { type: want }) : blob;
}

/** رابط Blob محلي لصورة/صوت (يُحمّل مرة واحدة ويُخزَّن في IndexedDB) */
export function getMediaUrl(entry, msg) {
  const key = (msg && msg.pending ? `p:${msg.id}:` : '') + entry.path;
  if (urlMemo.has(key)) return Promise.resolve(urlMemo.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let blob = null;
    if (msg && msg.pending) {
      const box = await dbGet('outbox', msg.id);
      const f = box && box.files && box.files.find((x) => x.path === entry.path);
      blob = f ? f.blob : null;
    }
    if (!blob) blob = await getCachedMedia(entry.path);
    if (!blob) {
      blob = await API.downloadMedia(entry.path);
      if (blob.size <= MAX_CACHE_FILE) cacheMedia(entry.path, typed(blob, entry.type));
    }
    const url = URL.createObjectURL(typed(blob, entry.type));
    urlMemo.set(key, url);
    return url;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** مصدر الفيديو: محلي إن توفر، وإلا رابط موقّع (بث دون تحميل الملف كاملاً) */
export async function getVideoSrc(entry, msg) {
  const key = 'v:' + (msg && msg.pending ? `p:${msg.id}:` : '') + entry.path;
  const memo = urlMemo.get(key);
  if (memo && (!memo.exp || memo.exp > Date.now())) return memo.url;
  if (msg && msg.pending) {
    const box = await dbGet('outbox', msg.id);
    const f = box && box.files && box.files.find((x) => x.path === entry.path);
    if (f && f.blob) {
      const url = URL.createObjectURL(typed(f.blob, entry.type));
      urlMemo.set(key, { url });
      return url;
    }
  }
  const cached = await getCachedMedia(entry.path);
  if (cached) {
    const url = URL.createObjectURL(typed(cached, entry.type));
    urlMemo.set(key, { url });
    return url;
  }
  const url = await API.signedUrl(entry.path, 3600);
  urlMemo.set(key, { url, exp: Date.now() + 50 * 60 * 1000 });
  return url;
}

/** تنزيل ملف وسائط كـ Blob (للحفظ/المشاركة) */
export async function getMediaBlob(entry, msg) {
  if (msg && msg.pending) {
    const box = await dbGet('outbox', msg.id);
    const f = box && box.files && box.files.find((x) => x.path === entry.path);
    if (f && f.blob) return typed(f.blob, entry.type);
  }
  const cached = await getCachedMedia(entry.path);
  if (cached) return typed(cached, entry.type);
  const blob = await API.downloadMedia(entry.path);
  return typed(blob, entry.type);
}

// ---------------------------------------------------------------------
// الصور الشخصية
// ---------------------------------------------------------------------
export async function getAvatarUrl(path) {
  if (!path) return null;
  const key = 'a:' + path;
  if (urlMemo.has(key)) return urlMemo.get(key);
  const cached = await getCachedMedia(key);
  if (cached) {
    const url = URL.createObjectURL(cached);
    urlMemo.set(key, url);
    return url;
  }
  try {
    const res = await fetch(API.avatarPublicUrl(path));
    if (!res.ok) throw new Error('avatar ' + res.status);
    const blob = await res.blob();
    cacheMedia(key, blob);
    const url = URL.createObjectURL(blob);
    urlMemo.set(key, url);
    return url;
  } catch {
    return null;
  }
}

export function forgetUrls() {
  for (const v of urlMemo.values()) {
    const u = typeof v === 'string' ? v : v && v.url;
    if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
  }
  urlMemo.clear();
}
