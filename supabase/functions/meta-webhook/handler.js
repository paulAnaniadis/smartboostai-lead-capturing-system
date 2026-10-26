// Receiver για τα webhooks της Meta (Facebook Lead Ads και WhatsApp), χωρίς εξαρτήσεις.
// Κάνει ΜΟΝΟ ένα πράγμα: ελέγχει την υπογραφή και σώζει κάθε γεγονός αυτούσιο (raw first).
// Όλη η επεξεργασία γίνεται μετά, στο n8n. Τρέχει σε Deno (Edge Function) και σε Node (tests).

const enc = new TextEncoder();

async function hmacSha256Hex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=') || !appSecret) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqual(header.slice(7).toLowerCase(), expected);
}

const iso = (unixSeconds) => new Date(Number(unixSeconds) * 1000).toISOString();

// Από το σώμα του webhook → λίστα ορισμάτων για capture_raw_event.
export function eventsFromWebhook(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (body.object === 'page' && change.field === 'leadgen' && v.leadgen_id) {
        out.push({
          channel: 'fb_leadgen',
          external_id: String(v.leadgen_id),
          recipient: String(v.page_id ?? entry.id),
          occurred_at: v.created_time ? iso(v.created_time) : new Date().toISOString(),
          payload: { via: 'webhook', ...v },
        });
      }
      if (body.object === 'whatsapp_business_account' && (change.field === 'messages' || change.field === 'smb_message_echoes')) {
        const phoneNumberId = String(v.metadata?.phone_number_id ?? '');
        const direction = change.field === 'smb_message_echoes' ? 'echo' : 'in';
        const messages = direction === 'echo' ? (v.message_echoes ?? []) : (v.messages ?? []);
        for (const m of messages) {
          if (!m.id) continue;
          out.push({
            channel: 'whatsapp',
            external_id: String(m.id),
            recipient: phoneNumberId,
            occurred_at: m.timestamp ? iso(m.timestamp) : new Date().toISOString(),
            payload: {
              via: 'webhook', direction, message: m, metadata: v.metadata ?? null,
              contact: (v.contacts ?? []).find((c) => c.wa_id === m.from) ?? null,
            },
          });
        }
        // Τα statuses (sent/delivered/read) δεν μας αφορούν.
      }
    }
  }
  return out;
}

/**
 * @param {Request} req
 * @param {{ appSecret: string, verifyToken: string, capture: (args) => Promise<void> }} deps
 */
export async function handleMetaWebhook(req, { appSecret, verifyToken, capture }) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    // Επιβεβαίωση συνδρομής από τη Meta.
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && verifyToken
      && url.searchParams.get('hub.verify_token') === verifyToken;
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 })
      : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('x-hub-signature-256'), appSecret))) {
    return new Response('invalid signature', { status: 401 });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  try {
    for (const ev of eventsFromWebhook(body)) await capture(ev);
  } catch (err) {
    // 500 → η Meta ξαναστέλνει. Το capture είναι idempotent, άρα δεν δημιουργούνται διπλά.
    console.error('capture failed', err);
    return new Response('capture failed', { status: 500 });
  }
  return new Response('EVENT_RECEIVED', { status: 200 });
}
