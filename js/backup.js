// =====================================================================
//  النسخ الاحتياطي والاستعادة (JSON / CSV)
//  - المصدر الأساسي للمحادثات هو Supabase؛ هذه النسخة "أرشيف شخصي" تحفظه أنت في تطبيق الملفات.
//  - لا تتضمن النسخة كلمات المرور ولا ملفات الصور/الفيديو/الصوت (فقط الرسائل النصية وبيانات الوسائط).
//  - الاستعادة تُدمج في النسخة المحلية على الجهاز فقط ولا ترفع شيئاً للسيرفر.
// =====================================================================
import { dbAll, dbPut, getAllMessagesOfConv } from './db.js';
import { sha256Hex } from './util.js';

const FORMAT = 1;
const APP = 'risa2li';
const KINDS = new Set(['text', 'image', 'video', 'audio']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanMessage(m) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender_id: m.sender_id,
    kind: m.kind,
    body: m.body ?? null,
    media: Array.isArray(m.media) ? m.media : [],
    created_at: m.created_at,
    delivered_at: m.delivered_at ?? null,
    read_at: m.read_at ?? null,
  };
}

export async function buildBackup(me) {
  const [profiles, convs, messages] = await Promise.all([dbAll('profiles'), dbAll('convs'), dbAll('messages')]);
  const data = {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, email: p.email ?? null, avatar_path: p.avatar_path ?? null })),
    convs: convs.map((c) => ({
      id: c.id, user_a: c.user_a, user_b: c.user_b, requested_by: c.requested_by, status: c.status, created_at: c.created_at,
    })),
    messages: messages.filter((m) => !m.pending).map(cleanMessage),
  };
  const checksum = await sha256Hex(JSON.stringify(data));
  return {
    app: APP,
    format: FORMAT,
    exported_at: new Date().toISOString(),
    user: { id: me.id, email: me.email, name: me.name },
    counts: { conversations: data.convs.length, messages: data.messages.length },
    checksum,
    data,
  };
}

export async function backupToBlob(me) {
  const backup = await buildBackup(me);
  const text = JSON.stringify(backup, null, 1);
  return { blob: new Blob([text], { type: 'application/json' }), backup };
}

export function backupFileName(prefix = 'backup') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `risa2li-${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const KIND_AR = { text: 'نص', image: 'صورة', video: 'فيديو', audio: 'صوت' };

export async function buildCSV(me) {
  const [profiles, convs] = await Promise.all([dbAll('profiles'), dbAll('convs')]);
  const nameOf = new Map(profiles.map((p) => [p.id, p.name || p.email || p.id]));
  nameOf.set(me.id, me.name || me.email);
  const rows = [['المحادثة مع', 'المرسل', 'وقت الإرسال', 'النوع', 'النص', 'عدد الملفات', 'الحالة']];
  for (const c of convs) {
    const other = c.user_a === me.id ? c.user_b : c.user_a;
    const msgs = (await getAllMessagesOfConv(c.id)).filter((m) => !m.pending);
    for (const m of msgs) {
      const status = m.sender_id !== me.id ? 'مستلمة' : m.read_at ? 'مقروءة' : m.delivered_at ? 'وصلت' : 'أُرسلت';
      rows.push([nameOf.get(other), nameOf.get(m.sender_id), m.created_at, KIND_AR[m.kind] || m.kind, m.body || '', (m.media || []).length, status]);
    }
  }
  const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'); // BOM لعرض العربية صحيحاً في Excel/Numbers
  return { blob: new Blob([text], { type: 'text/csv;charset=utf-8' }), rowCount: rows.length - 1 };
}

// ---------------------------------------------------------------------
// التحقق من ملف النسخة قبل الاستعادة
// ---------------------------------------------------------------------
export async function validateBackup(text, myId) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: 'الملف ليس بصيغة JSON صالحة' };
  }
  if (!obj || obj.app !== APP) return { ok: false, error: 'هذا الملف ليس نسخة احتياطية من هذا التطبيق' };
  if (obj.format !== FORMAT) return { ok: false, error: `إصدار النسخة (${obj.format}) غير مدعوم` };
  if (!obj.data || !Array.isArray(obj.data.messages) || !Array.isArray(obj.data.convs) || !Array.isArray(obj.data.profiles)) {
    return { ok: false, error: 'بنية الملف ناقصة أو تالفة' };
  }
  if (obj.data.messages.length > 500000) return { ok: false, error: 'الملف كبير جداً' };
  const sum = await sha256Hex(JSON.stringify(obj.data));
  if (sum !== obj.checksum) return { ok: false, error: 'فشل التحقق من سلامة الملف (تم تعديله أو تلف أثناء النقل)' };
  if (!obj.user || obj.user.id !== myId) return { ok: false, error: 'هذه النسخة تخص حساباً آخر ولا يمكن استعادتها هنا' };
  for (const m of obj.data.messages) {
    const okMsg =
      m && UUID_RE.test(m.id || '') && UUID_RE.test(m.conversation_id || '') && UUID_RE.test(m.sender_id || '') &&
      KINDS.has(m.kind) && !Number.isNaN(Date.parse(m.created_at)) &&
      (m.body == null || typeof m.body === 'string') && Array.isArray(m.media || []);
    if (!okMsg) return { ok: false, error: 'تم العثور على رسالة غير صالحة داخل الملف' };
  }
  return {
    ok: true,
    backup: obj,
    summary: {
      exportedAt: obj.exported_at,
      conversations: obj.data.convs.length,
      messages: obj.data.messages.length,
    },
  };
}

/** دمج الرسائل المفقودة محلياً (لا يستبدل ولا يحذف شيئاً موجوداً) */
export async function importBackup(backup) {
  const [convs, existing] = await Promise.all([dbAll('convs'), dbAll('messages')]);
  const convIds = new Set(convs.map((c) => c.id));
  const have = new Set(existing.map((m) => m.id));
  const toAdd = [];
  let skippedNoConv = 0;
  for (const m of backup.data.messages) {
    if (!convIds.has(m.conversation_id)) {
      skippedNoConv++;
      continue;
    }
    if (have.has(m.id)) continue;
    toAdd.push({ ...cleanMessage(m), created_at: new Date(m.created_at).toISOString(), local_only: true });
  }
  await dbPut('messages', toAdd); // يُحلّ بعد اكتمال الحفظ فعلياً
  return { added: toAdd.length, alreadyPresent: backup.data.messages.length - toAdd.length - skippedNoConv, skippedNoConv };
}
