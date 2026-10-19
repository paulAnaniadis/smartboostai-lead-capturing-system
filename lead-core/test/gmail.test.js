import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureArgsFromGmailMessage, findLeadRecipient } from '../src/index.js';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ISO-8859-7 bytes για «Όνομα: Άννα» (ελληνική κωδικοποίηση που στέλνουν παλιά συστήματα).
const iso88597 = Buffer.from([0xbc, 0xed, 0xef, 0xec, 0xe1, 0x3a, 0x20, 0xb6, 0xed, 0xed, 0xe1]);

const message = {
  id: '18f0abc',
  threadId: '18f0abc',
  internalDate: String(Date.parse('2026-10-19T08:00:00Z')),
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Spitogatos <noreply@spitogatos.gr>' },
      { name: 'Delivered-To', value: 'leads@example.com' },
      { name: 'Delivered-To', value: 'leads+demo@example.com' },
      { name: 'To', value: 'Info <info@demo-akinita.example>' },
      { name: 'Subject', value: 'Νέο μήνυμα' },
      { name: 'Message-ID', value: ' <abc123@mail.spitogatos.gr> ' },
    ],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-7"' }],
            body: { data: b64url(iso88597) } },
          { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }],
            body: { data: b64url('<p>Όνομα: Άννα</p>') } },
        ],
      },
      { mimeType: 'application/pdf', filename: 'brochure.pdf', body: { size: 1234, attachmentId: 'x' } },
    ],
  },
};

test('Gmail API μήνυμα → capture args', () => {
  const args = captureArgsFromGmailMessage(message);
  assert.equal(args.channel, 'gmail');
  assert.equal(args.external_id, '<abc123@mail.spitogatos.gr>');
  assert.equal(args.recipient, 'leads+demo@example.com');
  assert.equal(args.occurred_at, '2026-10-19T08:00:00.000Z');
  assert.equal(args.payload.text, 'Όνομα: Άννα');
  assert.equal(args.payload.html, '<p>Όνομα: Άννα</p>');
  assert.deepEqual(args.payload.attachments, [{ filename: 'brochure.pdf', mime: 'application/pdf', size: 1234 }]);
  assert.deepEqual(args.payload.headers.delivered_to, ['leads@example.com', 'leads+demo@example.com']);
});

test('χωρίς Message-ID: fallback στο Gmail id', () => {
  const m = structuredClone(message);
  m.payload.headers = m.payload.headers.filter((h) => h.name !== 'Message-ID');
  assert.equal(captureArgsFromGmailMessage(m).external_id, 'gmail:18f0abc');
});

test('παραλήπτης: plus-address από To όταν λείπει το Delivered-To', () => {
  assert.equal(findLeadRecipient({ headers: { to: 'X <LEADS+Kalogirou@example.com>' } }), 'leads+kalogirou@example.com');
  assert.equal(findLeadRecipient({ headers: { to: 'info@example.com' } }), null);
});
