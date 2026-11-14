// =====================================================================
//  الإشعارات (Web Push)
//  على iPhone: تعمل فقط بعد "إضافة إلى الشاشة الرئيسية" وبنظام iOS 16.4 فأعلى،
//  ويجب أن يُطلب الإذن بضغطة من المستخدم.
// =====================================================================
import { CONFIG } from './config.js';
import * as API from './api.js';
import { urlBase64ToUint8Array, isIOS, isStandalone } from './util.js';

export function pushStatus() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return {
    supported,
    needsInstall: isIOS() && !isStandalone(),
    permission: supported ? Notification.permission : 'unsupported',
    configured: !!CONFIG.VAPID_PUBLIC_KEY,
  };
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager ? reg.pushManager.getSubscription() : null;
}

async function subscribeNow(reg) {
  const key = urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (e) {
    // اشتراك قديم بمفتاح مختلف: نلغيه ونعيد المحاولة
    const old = await reg.pushManager.getSubscription();
    if (old) {
      await old.unsubscribe();
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    throw e;
  }
}

/** يُستدعى من ضغطة زر فقط (شرط iOS) */
export async function enablePush() {
  const st = pushStatus();
  if (!st.supported) throw Object.assign(new Error('unsupported'), { code: 'push_unsupported' });
  if (st.needsInstall) throw Object.assign(new Error('install'), { code: 'push_needs_install' });
  if (!st.configured) throw Object.assign(new Error('not configured'), { code: 'push_not_configured' });
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw Object.assign(new Error('denied'), { code: 'push_denied' });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await subscribeNow(reg);
  await API.savePushSubscription(sub);
  return sub;
}

/** مزامنة صامتة عند فتح التطبيق: إن كان الإذن ممنوحاً نتأكد أن الاشتراك محفوظ لهذا الحساب */
export async function syncPush() {
  const st = pushStatus();
  if (!st.supported || !st.configured || st.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await subscribeNow(reg);
    await API.savePushSubscription(sub);
  } catch (e) {
    console.warn('push sync failed', e);
  }
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await API.removePushSubscription(endpoint);
  } catch (e) {
    console.warn(e);
  }
}
