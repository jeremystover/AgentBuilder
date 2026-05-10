import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';
import type { VenmoContext } from '../types';

export interface VenmoEmailPayment {
  direction: VenmoContext['direction'];
  counterparty: string;
  memo: string | null;
  amount: number;
  date: string; // YYYY-MM-DD, derived from email received date
  gmailMessageId: string;
}

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseAmount(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

// Venmo subject formats:
//   "[Name] paid you $XX.XX"          → received
//   "You paid [Name] $XX.XX"          → sent
//   "[Name] charged you $XX.XX"       → charged (request received, money owed)
//   "You charged [Name] for $XX.XX"   → (we sent a charge request — skip, no money moved)
export function parseVenmoEmail(message: GmailMessage): VenmoEmailPayment | null {
  const from = getHeader(message, 'from');
  if (!/venmo@venmo\.com/i.test(from)) return null;

  const subject = getHeader(message, 'subject');

  // Determine direction and counterparty from subject.
  let direction: VenmoContext['direction'] | null = null;
  let counterparty: string | null = null;
  let subjectAmount: number | null = null;

  // "[Name] paid you $XX.XX"
  const receivedMatch = subject.match(/^(.+?)\s+paid you\s+\$([\d,]+\.\d{2})/i);
  if (receivedMatch) {
    direction = 'received';
    counterparty = receivedMatch[1].trim();
    subjectAmount = parseAmount(receivedMatch[2]);
  }

  // "You paid [Name] $XX.XX"
  const sentMatch = !direction && subject.match(/^You paid\s+(.+?)\s+\$([\d,]+\.\d{2})/i);
  if (sentMatch) {
    direction = 'sent';
    counterparty = sentMatch[1].trim();
    subjectAmount = parseAmount(sentMatch[2]);
  }

  // "[Name] charged you $XX.XX"
  const chargedMatch = !direction && subject.match(/^(.+?)\s+charged you\s+\$([\d,]+\.\d{2})/i);
  if (chargedMatch) {
    direction = 'charged';
    counterparty = chargedMatch[1].trim();
    subjectAmount = parseAmount(chargedMatch[2]);
  }

  // "You charged [Name]" — this is a charge request we sent, not a completed payment; skip.
  if (!direction || !counterparty || subjectAmount === null) return null;

  const { text, html } = getMessageBody(message);
  const body = text || stripHtml(html);

  // Extract memo from the email body. Venmo includes it as:
  //   "For [memo]" or "Memo: [memo]" or just after the payment line.
  let memo: string | null = null;
  const forMatch = body.match(/For\s+"([^"]+)"/i) ?? body.match(/For\s+(.{3,80}?)(?:\n|$)/i);
  if (forMatch) memo = forMatch[1].trim();

  // Fall back to amount from body if subject parse missed it.
  let amount = subjectAmount;
  if (!amount) {
    const bodyAmountMatch = body.match(/\$([\d,]+\.\d{2})/);
    if (bodyAmountMatch) amount = parseAmount(bodyAmountMatch[1]) ?? 0;
  }
  if (!amount) return null;

  return {
    direction,
    counterparty,
    memo,
    amount,
    date: epochToIsoDate(message.internalDate),
    gmailMessageId: message.id,
  };
}
