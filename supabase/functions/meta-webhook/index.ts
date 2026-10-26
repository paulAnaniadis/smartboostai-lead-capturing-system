// Supabase Edge Function: webhook της Meta (Facebook Lead Ads, WhatsApp).
// Deploy:  supabase functions deploy meta-webhook --no-verify-jwt
// Secrets: supabase secrets set META_APP_SECRET=... META_VERIFY_TOKEN=...
// (Τα SUPABASE_URL και SUPABASE_SERVICE_ROLE_KEY υπάρχουν ήδη στο περιβάλλον των Edge Functions.)
import { handleMetaWebhook } from './handler.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function capture(ev: { channel: string; external_id: string; recipient: string; occurred_at: string; payload: unknown }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/leads_capture_meta_event`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_channel: ev.channel, p_external_id: ev.external_id, p_recipient: ev.recipient,
      p_occurred_at: ev.occurred_at, p_payload: ev.payload,
    }),
  });
  if (!res.ok) throw new Error(`capture ${res.status}: ${await res.text()}`);
}

Deno.serve((req) => handleMetaWebhook(req, {
  appSecret: (Deno.env.get('META_APP_SECRET') ?? '').trim(),
  verifyToken: (Deno.env.get('META_VERIFY_TOKEN') ?? '').trim(),
  capture,
}));
