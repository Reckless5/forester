// Web Push: service worker registration and subscribing this device.
// iPhone/iPad only support push for apps added to the home screen (iOS 16.4+).

import { notifyFunctionUrl, registerPush, supabaseKey, unregisterPush } from './account';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'on' | 'off';

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone =
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let registration: Promise<ServiceWorkerRegistration | undefined> = Promise.resolve(undefined);

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  registration = navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch((e) => {
      console.warn('Service worker not registered', e);
      return undefined;
    });
}

/** Messages from the service worker (new report, notification tapped). */
export function onServiceWorkerMessage(fn: (msg: { type: string; url?: string }) => void) {
  navigator.serviceWorker?.addEventListener('message', (e) => fn(e.data ?? {}));
}

async function currentSubscription() {
  const reg = await registration;
  return reg?.pushManager.getSubscription() ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!supported) return isIos && !isStandalone ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) ? 'on' : 'off';
}

function keyToBytes(base64url: string) {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');
  const reg = await registration;
  if (!reg) throw new Error('Benachrichtigungen werden von diesem Browser nicht unterstützt.');
  const res = await fetch(notifyFunctionUrl(), { headers: { apikey: supabaseKey() } });
  if (!res.ok) throw new Error('Server für Benachrichtigungen nicht erreichbar.');
  const { publicKey } = await res.json();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
  await registerPush(sub);
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await unregisterPush(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** After login: make sure an existing subscription on this device belongs to this account. */
export async function claimPushForAccount() {
  const sub = await currentSubscription();
  if (sub) await registerPush(sub).catch(() => {});
}
