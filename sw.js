/* =====================================================================
   Service Worker — رسائلي
   - يخزّن ملفات التطبيق لتعمل الواجهة دون إنترنت بعد التحميل الأول
   - يستقبل إشعارات Web Push ويعرضها حتى والتطبيق مغلق
   - لا يلمس أبداً طلبات Supabase (بيانات المستخدم لا تُخزَّن هنا)

   ⚠️ عند تعديل أي ملف من ملفات التطبيق: ارفع رقم VERSION أدناه،
      فيظهر للمستخدم إشعار "تحديث متوفر" ثم يُحدَّث التطبيق دون فقدان بياناته.
   ===================================================================== */

const VERSION = 'v1.0.2';
const STATIC_CACHE = `risa2li-static-${VERSION}`;
const RUNTIME_CACHE = 'risa2li-runtime';
const CDN_HOST = 'cdn.jsdelivr.net';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

// كل المسارات نسبية — تعمل داخل مسار فرعي مثل https://user.github.io/repo/
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/config.js',
  'js/util.js',
  'js/icons.js',
  'js/db.js',
  'js/api.js',
  'js/media.js',
  'js/push.js',
  'js/backup.js',
  'js/ui.js',
  'js/nav.js',
  'js/state.js',
  'js/auth.js',
  'js/list.js',
  'js/chat.js',
  'js/settings.js',
  'js/app.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon-32.png',
];

const abs = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // cache:'reload' لتجاوز ذاكرة HTTP المؤقتة وضمان أحدث نسخة
      await Promise.all(ASSETS.map((p) => cache.add(new Request(abs(p), { cache: 'reload' }))));
      try {
        await cache.add(new Request(SUPABASE_CDN, { mode: 'cors' }));
      } catch {
        /* غير حرج: يُخزَّن لاحقاً عند أول استخدام */
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('risa2li-static-') && k !== STATIC_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // مكتبة supabase-js من CDN: خزّنها وحدّثها بالخلفية
  if (url.hostname === CDN_HOST) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // أي نطاق آخر (Supabase وغيره): لا نتدخل إطلاقاً
  if (url.origin !== self.location.origin) return;

  // التنقل بين الصفحات: نقدّم index.html المخزّن (يعمل دون إنترنت)
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(abs('index.html'), { cacheName: STATIC_CACHE, ignoreSearch: true });
        if (cached) return cached;
        try {
          return await fetch(req);
        } catch {
          return new Response('التطبيق غير متاح دون إنترنت حالياً. افتحه مرة واحدة مع الاتصال.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // ملفات التطبيق: من الذاكرة أولاً
  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { cacheName: STATIC_CACHE, ignoreSearch: true });
      if (cached) return cached;
      // ملفات اختيارية (مثل vendor/supabase.js): من الشبكة ثم تُخزَّن للاستخدام دون إنترنت
      const rt = await caches.open(RUNTIME_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) rt.put(req, res.clone());
        return res;
      } catch (e) {
        const old = await rt.match(req);
        if (old) return old;
        throw e;
      }
    })()
  );
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const staticCache = await caches.open(STATIC_CACHE);
  const cached = (await staticCache.match(req)) || (await cache.match(req));
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const res = await network;
  return res || Response.error();
}

// ---------------------------------------------------------------------
// الإشعارات
// ---------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'رسالة جديدة';
  // iOS يشترط عرض إشعار مع كل push، لذلك نعرضه دائماً
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: abs('icon-192.png'),
      badge: abs('icon-192.png'),
      tag: data.conv || 'msg',
      renotify: true,
      lang: 'ar',
      dir: 'rtl',
      data: { conv: data.conv || null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conv = event.notification.data && event.notification.data.conv;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          c.postMessage({ type: 'open-chat', conv });
          return;
        }
      }
      await self.clients.openWindow(abs(conv ? `./?c=${encodeURIComponent(conv)}` : './'));
    })()
  );
});
