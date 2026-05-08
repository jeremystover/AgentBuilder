import type { Transaction, Rule } from '../types';

export interface RuleMatch {
  entity: string;
  category_tax: string | null;
  category_budget: string | null;
  rule_id: string;
  rule_name: string;
}

function getFieldValue(transaction: Transaction, field: Rule['match_field']): string {
  switch (field) {
    case 'merchant_name': return (transaction.merchant_name ?? '').toLowerCase();
    case 'description':   return transaction.description.toLowerCase();
    case 'account_id':    return transaction.account_id ?? '';
    case 'amount':        return Math.abs(transaction.amount).toFixed(2);
  }
}

function matches(value: string, operator: Rule['match_operator'], pattern: string): boolean {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  switch (operator) {
    case 'contains':    return v.includes(p);
    case 'equals':      return v === p;
    case 'starts_with': return v.startsWith(p);
    case 'ends_with':   return v.endsWith(p);
    case 'regex': {
      try { return new RegExp(pattern, 'i').test(value); }
      catch { return false; }
    }
  }
}

// Patterns in description or merchant_name that reliably indicate a transfer
// between owned accounts. Checked before user rules so they can't be overridden
// by accident, but a user rule with higher priority can still win if needed.
const TRANSFER_PATTERNS: RegExp[] = [
  /\btransfer\b/i,
  /\bpayment\s+thank\s+you\b/i,       // "Payment Thank You" — credit card payment confirmation
  /\bcredit\s+card\s+payment\b/i,
  /\bonline\s+payment\b/i,
  /\bautopay\b/i,
  /\bauto[\s-]?pay\b/i,
  /\bbal(?:ance)?\s+transfer\b/i,
  /\bzelle\s+(to|from)\b/i,
  /\bvenmo\s+(to|from)\b/i,           // "Venmo to/from" — inter-account settlement
  /\bbank\s+transfer\b/i,
  /\bwire\s+transfer\b/i,
  /\binternal\s+transfer\b/i,
  /\bdeposit\s+transfer\b/i,
  /\bsweep\b/i,
];

function isBuiltInTransfer(transaction: Transaction): boolean {
  const desc = (transaction.description ?? '').toLowerCase();
  const merchant = (transaction.merchant_name ?? '').toLowerCase();
  return TRANSFER_PATTERNS.some(re => re.test(desc) || re.test(merchant));
}

/**
 * Returns the first matching rule (highest priority wins).
 * Runs a built-in transfer detection pass first, then user rules.
 * Rules must be pre-filtered to is_active=1 for the correct user.
 */
export function applyRules(transaction: Transaction, rules: Rule[]): RuleMatch | null {
  if (isBuiltInTransfer(transaction)) {
    return {
      entity: 'family_personal',
      category_tax: 'transfer',
      category_budget: null,
      rule_id: '__builtin_transfer__',
      rule_name: 'Built-in: transfer detection',
    };
  }

  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const rule of sorted) {
    if (!rule.is_active) continue;
    const fieldValue = getFieldValue(transaction, rule.match_field);
    if (matches(fieldValue, rule.match_operator, rule.match_value)) {
      return {
        entity: rule.entity,
        category_tax: rule.category_tax,
        category_budget: rule.category_budget,
        rule_id: rule.id,
        rule_name: rule.name,
      };
    }
  }
  return null;
}
