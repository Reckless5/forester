// Sends Web Push notifications:
//  - to a parcel owner when someone reports a flag on their parcel ({ report_id })
//  - to a user when another user sends them parcels or a group ({ share_token })
//
// GET  → { publicKey }: the VAPID public key browsers need to subscribe.
//        Creates the VAPID key pair on first use and stores it in the database
//        (private.app_settings), so no secret has to be set by hand.
// POST → { report_id } or { share_token }, called by database triggers with the
//        header x-webhook-secret. Pushes to all of the user's devices and
//        removes subscriptions the push service says are gone.
//
// Deployed with verify_jwt = false: GET is public, POST checks the secret.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const FLAG_LABEL: Record<string, string> = {
  kaefer: 'Käferbefall',
  windwurf: 'Windwurf',
  durchforsten: 'Durchforsten',
};

const serviceKey =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default;
const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

interface Settings {
  webhook_secret?: string;
  vapid_public?: string;
  vapid_private?: string;
}

async function settings(): Promise<Settings> {
  const { data, error } = await db.rpc('push_settings');
  if (error) throw error;
  return data ?? {};
}

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  let s = await settings();
  if (!s.vapid_public || !s.vapid_private) {
    const keys = webpush.generateVAPIDKeys();
    const { error } = await db.rpc('push_store_vapid', { pub: keys.publicKey, priv: keys.privateKey });
    if (error) throw error;
    s = await settings(); // another request may have stored its pair first
  }
  return { publicKey: s.vapid_public!, privateKey: s.vapid_private! };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    if (req.method === 'GET') {
      const { publicKey } = await vapidKeys();
      return json({ publicKey });
    }

    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

    const s = await settings();
    if (!s.webhook_secret || req.headers.get('x-webhook-secret') !== s.webhook_secret) {
      return json({ error: 'forbidden' }, 403);
    }

    const { report_id, share_token } = await req.json();
    let userId: string;
    let message: { title: string; body: string; url: string; tag: string };

    if (report_id) {
      const { data: report, error } = await db.from('flag_reports').select('*').eq('id', report_id).maybeSingle();
      if (error) throw error;
      if (!report || report.status !== 'pending') return json({ skipped: 'no pending report' });
      const flag = FLAG_LABEL[report.flag_type] ?? report.flag_type;
      const gnr = String(report.parcel_key).split('-').slice(1).join('-');
      const where = report.parcel_name ? `„${report.parcel_name}“ (Gst. ${gnr})` : `Gst. ${gnr}`;
      userId = report.owner_id;
      message = {
        title: `${flag} gemeldet`,
        body: `${report.reporter_name ?? 'Jemand'} meldet ${flag} auf ${where}. Bitte bestätigen oder ablehnen.`,
        url: `./?report=${report.id}`,
        tag: `report-${report.id}`,
      };
    } else if (share_token) {
      const { data: share, error } = await db
        .from('shares')
        .select('token, title, parcels, owner_id, recipient_id')
        .eq('token', share_token)
        .maybeSingle();
      if (error) throw error;
      if (!share?.recipient_id) return json({ skipped: 'no direct share' });
      const { data: sender } = await db.from('profiles').select('display_name').eq('id', share.owner_id).maybeSingle();
      const n = Array.isArray(share.parcels) ? share.parcels.length : 0;
      userId = share.recipient_id;
      message = {
        title: n === 1 ? 'Grundstück erhalten' : 'Grundstücke erhalten',
        body: `${sender?.display_name ?? 'Jemand'} hat dir „${share.title}“ geschickt (${n} Grundstück${n === 1 ? '' : 'e'}).`,
        url: `./?share=${share.token}`,
        tag: `share-${share.token}`,
      };
    } else {
      return json({ error: 'report_id or share_token required' }, 400);
    }

    const { data: subs, error: subErr } = await db
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);
    if (subErr) throw subErr;
    if (!subs?.length) return json({ sent: 0, note: 'user has no push subscriptions' });

    const { publicKey, privateKey } = await vapidKeys();
    webpush.setVapidDetails('mailto:noreply@forester.invalid', publicKey, privateKey);
    const payload = JSON.stringify(message);

    let sent = 0;
    const gone: string[] = [];
    const failures: string[] = [];
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 60 * 60 * 24 * 7, urgency: 'normal' },
          );
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(sub.endpoint);
          else failures.push(`${status ?? ''} ${(e as Error).message}`.trim());
        }
      }),
    );
    if (gone.length) await db.from('push_subscriptions').delete().in('endpoint', gone);

    return json({ sent, removed: gone.length, failures });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
