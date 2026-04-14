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

/**
 * Returns the first matching rule (highest priority wins).
 * Rules must be pre-filtered to is_active=1 for the correct user.
 */
export function applyRules(transaction: Transaction, rules: Rule[]): RuleMatch | null {
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
