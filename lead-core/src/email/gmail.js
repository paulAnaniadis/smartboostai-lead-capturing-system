// Μετατροπή μηνύματος του Gmail API (users.messages.get?format=full) στο payload
// που αποθηκεύεται στο raw_events. Τα attachments δεν αποθηκεύονται, μόνο τα ονόματά τους.

import { extractAddresses } from './text.js';
import { base64UrlToBytes, decodeBytes } from '../bytes.js';

const decodeBase64Url = (data, charset) => decodeBytes(base64UrlToBytes(data), charset);

const headerList = (part) => part?.headers ?? [];
const header = (part, name) =>
  headerList(part).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
const headersAll = (part, name) =>
  headerList(part).filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);

function charsetOf(part) {
  const ct = header(part, 'Content-Type') ?? '';
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1].toLowerCase() : 'utf-8';
}

function walk(part, acc) {
  if (!part) return acc;
  const mime = (part.mimeType ?? '').toLowerCase();
  if (part.filename) {
    acc.attachments.push({ filename: part.filename, mime, size: part.body?.size ?? 0 });
  } else if (mime === 'text/plain' && part.body?.data && acc.text == null) {
    acc.text = decodeBase64Url(part.body.data, charsetOf(part));
  } else if (mime === 'text/html' && part.body?.data && acc.html == null) {
    acc.html = decodeBase64Url(part.body.data, charsetOf(part));
  }
  for (const p of part.parts ?? []) walk(p, acc);
  return acc;
}

export function payloadFromGmailMessage(msg) {
  const root = msg.payload ?? {};
  const body = walk(root, { text: null, html: null, attachments: [] });
  const messageId = header(root, 'Message-ID') ?? header(root, 'Message-Id');
  return {
    gmail_id: msg.id,
    thread_id: msg.threadId,
    internal_date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    headers: {
      message_id: messageId,
      from: header(root, 'From'),
      reply_to: header(root, 'Reply-To'),
      to: header(root, 'To'),
      cc: header(root, 'Cc'),
      delivered_to: headersAll(root, 'Delivered-To'),
      x_original_to: header(root, 'X-Original-To'),
      subject: header(root, 'Subject'),
      date: header(root, 'Date'),
    },
    text: body.text,
    html: body.html,
    attachments: body.attachments,
  };
}

// Κλειδί idempotency: το Message-ID header. Fallback: το id του Gmail.
export function externalIdOf(payload) {
  const mid = payload.headers?.message_id?.trim();
  return mid || `gmail:${payload.gmail_id}`;
}

export function occurredAtOf(payload) {
  if (payload.internal_date) return payload.internal_date;
  const d = payload.headers?.date ? new Date(payload.headers.date) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

// Η plus-διεύθυνση του πελάτη. Ελέγχει με σειρά Delivered-To, X-Original-To, To, Cc.
export function findLeadRecipient(payload, { localPart = 'leads' } = {}) {
  const re = new RegExp(`^${localPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\+[a-z0-9-]+@`, 'i');
  const h = payload.headers ?? {};
  for (const value of [h.delivered_to, h.x_original_to, h.to, h.cc]) {
    const hit = extractAddresses(value).find((a) => re.test(a));
    if (hit) return hit;
  }
  return null;
}

// Όλα όσα χρειάζεται το capture_raw_event, από ένα μήνυμα του Gmail API.
export function captureArgsFromGmailMessage(msg, opts) {
  const payload = payloadFromGmailMessage(msg);
  return {
    channel: 'gmail',
    external_id: externalIdOf(payload),
    recipient: findLeadRecipient(payload, opts),
    occurred_at: occurredAtOf(payload),
    payload,
  };
}
