// =====================================================================
//  IndexedDB — النسخة المحلية (Cache) من المحادثات + صندوق الصادر + الوسائط
//  المصدر الأساسي للبيانات هو Supabase؛ هذه القاعدة تتيح العرض دون إنترنت
//  وحفظ الرسائل غير المُرسلة حتى يعود الاتصال.
// =====================================================================

const DB_NAME = 'risa2li-cache';
export const DB_VERSION = 1;

/**
 * نظام الترحيل (Migrations): كل رقم إصدار له دالة تُنفَّذ مرة واحدة بالترتيب.
 * عند تغيير هيكل القاعدة مستقبلاً: ارفع DB_VERSION وأضف دالة جديدة هنا
 * (بدون حذف القديمة) فتبقى بيانات المستخدم سليمة.
 */
const MIGRATIONS = {
  1(db) {
    db.createObjectStore('meta', { keyPath: 'k' });
    db.createObjectStore('profiles', { keyPath: 'id' });
    db.createObjectStore('convs', { keyPath: 'id' });
    const m = db.createObjectStore('messages', { keyPath: 'id' });
    m.createIndex('by_conv', ['conversation_id', 'created_at']);
    db.createObjectStore('outbox', { keyPath: 'id' });
    db.createObjectStore('media', { keyPath: 'path' });
  },
  // مثال للمستقبل:
  // 2(db, tx) { tx.objectStore('messages').createIndex('by_sender', 'sender_id'); },
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB غير مدعوم في هذا المتصفح'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const tx = req.transaction;
      for (let v = e.oldVersion + 1; v <= (e.newVersion || DB_VERSION); v++) {
        if (MIGRATIONS[v]) MIGRATIONS[v](db, tx);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('تعذّر فتح قاعدة البيانات المحلية'));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('قاعدة البيانات المحلية مشغولة بنافذة أخرى. أغلق باقي النوافذ وأعد المحاولة'));
    };
  });
  return dbPromise;
}

const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** تنفيذ معاملة، ويُحلّ الوعد فقط بعد اكتمال الحفظ فعلياً (oncomplete) */
async function run(stores, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let result;
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('أُلغيت عملية الحفظ'));
    Promise.resolve()
      .then(() => work(tx))
      .then((r) => {
        result = r;
      })
      .catch((e) => {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        reject(e);
      });
  });
}

// ---------- عمليات عامة ----------
export const dbGet = (store, key) => run(store, 'readonly', (tx) => reqP(tx.objectStore(store).get(key)));
export const dbAll = (store) => run(store, 'readonly', (tx) => reqP(tx.objectStore(store).getAll()));
export const dbCount = (store) => run(store, 'readonly', (tx) => reqP(tx.objectStore(store).count()));

export function dbPut(store, value) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) return Promise.resolve();
  return run(store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    list.forEach((v) => os.put(v));
  });
}

export function dbDel(store, key) {
  const list = Array.isArray(key) ? key : [key];
  if (!list.length) return Promise.resolve();
  return run(store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    list.forEach((k) => os.delete(k));
  });
}

export function dbClear(stores) {
  const list = Array.isArray(stores) ? stores : [stores];
  return run(list, 'readwrite', (tx) => {
    list.forEach((s) => tx.objectStore(s).clear());
  });
}

// ---------- meta ----------
export async function getMeta(k, fallback = null) {
  const row = await dbGet('meta', k);
  return row ? row.v : fallback;
}
export const setMeta = (k, v) => dbPut('meta', { k, v });

// ---------- الرسائل ----------
/** أحدث `limit` رسالة في محادثة (الأقدم أولاً في النتيجة). before = created_at لجلب ما هو أقدم منه */
export function getMessages(conv, { limit = 60, before = null } = {}) {
  return run('messages', 'readonly', (tx) => {
    const idx = tx.objectStore('messages').index('by_conv');
    const range = IDBKeyRange.bound([conv, ''], [conv, before || '￿'], false, !!before);
    return new Promise((resolve, reject) => {
      const out = [];
      const cur = idx.openCursor(range, 'prev');
      cur.onsuccess = () => {
        const c = cur.result;
        if (c && out.length < limit) {
          out.push(c.value);
          c.continue();
        } else {
          resolve(out.reverse());
        }
      };
      cur.onerror = () => reject(cur.error);
    });
  });
}

export function getAllMessagesOfConv(conv) {
  return getMessages(conv, { limit: Number.MAX_SAFE_INTEGER });
}

export async function lastMessageOfConv(conv) {
  const arr = await getMessages(conv, { limit: 1 });
  return arr[0] || null;
}

export async function unreadCount(conv, myId) {
  const all = await getMessages(conv, { limit: 500 });
  return all.filter((m) => m.sender_id !== myId && !m.read_at && !m.pending).length;
}

export async function deleteConvLocal(conv) {
  const msgs = await getAllMessagesOfConv(conv);
  await dbDel('messages', msgs.map((m) => m.id));
  const box = (await dbAll('outbox')).filter((o) => o.conversation_id === conv);
  await dbDel('outbox', box.map((o) => o.id));
  await dbDel('convs', conv);
}

// ---------- ذاكرة الوسائط ----------
export async function getCachedMedia(path) {
  try {
    const row = await dbGet('media', path);
    return row ? row.blob : null;
  } catch {
    return null;
  }
}

export async function cacheMedia(path, blob) {
  try {
    await dbPut('media', { path, blob, size: blob.size, ts: Date.now() });
  } catch (e) {
    // مثلاً امتلاء المساحة: لا نكسر التطبيق، فقط لا نخزّن
    console.warn('تعذّر تخزين الوسائط محلياً', e);
  }
}

export async function pruneMedia(maxBytes) {
  try {
    const rows = await run('media', 'readonly', (tx) =>
      new Promise((resolve, reject) => {
        const out = [];
        const cur = tx.objectStore('media').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            out.push({ path: c.value.path, size: c.value.size || 0, ts: c.value.ts || 0 });
            c.continue();
          } else resolve(out);
        };
        cur.onerror = () => reject(cur.error);
      })
    );
    let total = rows.reduce((s, r) => s + r.size, 0);
    if (total <= maxBytes) return;
    rows.sort((a, b) => a.ts - b.ts);
    const del = [];
    for (const r of rows) {
      if (total <= maxBytes * 0.8) break;
      del.push(r.path);
      total -= r.size;
    }
    await dbDel('media', del);
  } catch (e) {
    console.warn('prune media failed', e);
  }
}

export async function clearAllUserData() {
  await dbClear(['profiles', 'convs', 'messages', 'outbox', 'media']);
}
