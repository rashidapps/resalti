// =====================================================================
//  إعدادات التطبيق — عدّل هذا الملف مرة واحدة فقط بعد إنشاء مشروع Supabase.
//
//  كل القيم هنا "عامة" بطبيعتها (آمنة للنشر على GitHub):
//   - SUPABASE_URL      : رابط المشروع  (Project Settings → API → Project URL)
//   - SUPABASE_ANON_KEY : المفتاح العام  (anon public — أو Publishable key)
//   - VAPID_PUBLIC_KEY  : المفتاح العام للإشعارات (من صفحة vapid.html) — اختياري
//
//  ⚠️ لا تضع هنا أبداً مفتاح service_role أو أي مفتاح "سري".
//  الحماية الفعلية للبيانات تتم داخل Supabase عبر سياسات RLS (ملف schema.sql).
// =====================================================================
export const CONFIG = {
  SUPABASE_URL: "https://laurysigbzlmzrzodzvf.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1ewWrF4Pff36N3soVyrxyA_hJ9lc3kY",
  VAPID_PUBLIC_KEY: "",

  APP_NAME: "رسائلي",
  MAX_VIDEO_MB: 45,        // حد Supabase المجاني 50MB للملف الواحد
  IMAGE_MAX_DIM: 1600,     // أقصى بُعد للصورة بعد الضغط
  IMAGE_QUALITY: 0.82,
  MEDIA_CACHE_MB: 150,     // سقف تخزين الوسائط محلياً على الجهاز
  PAGE_SIZE: 60,
};
