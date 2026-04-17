import type { Env, Transaction, AIClassification, AmazonContext } from '../types';
import { SCHEDULE_C_CATEGORIES, AIRBNB_CATEGORIES, FAMILY_CATEGORIES } from '../types';

function describeApiKey(value: string | undefined): {
  present: boolean;
  length: number;
  trimmed_length: number;
  has_leading_whitespace: boolean;
  has_trailing_whitespace: boolean;
  preview: string;
} {
  const raw = value ?? '';
  const trimmed = raw.trim();

  return {
    present: raw.length > 0,
    length: raw.length,
    trimmed_length: trimmed.length,
    has_leading_whitespace: raw.length > 0 && raw !== raw.trimStart(),
    has_trailing_whitespace: raw.length > 0 && raw !== raw.trimEnd(),
    preview: trimmed ? `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}` : '(empty)',
  };
}

export function getClaudeDiagnostics(env: Env) {
  return {
    anthropic_api_key: describeApiKey(env.ANTHROPIC_API_KEY),
    model: 'claude-opus-4-6',
  };
}

const CLASSIFICATION_TOOL = {
  name: 'classify_transaction',
  description: 'Classify a financial transaction for US tax and accounting purposes',
  input_schema: {
    type: 'object' as const,
    properties: {
      entity: {
        type: 'string',
        enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
        description: 'Which business entity or personal category this transaction belongs to',
      },
      category_tax: {
        type: 'string',
        description: 'Tax schedule category code (e.g. advertising, supplies, rental_income)',
      },
      category_budget: {
        type: 'string',
        description: 'Household/budget category code (e.g. groceries, dining_out, subscriptions)',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence score 0-1. Be honest — never fabricate certainty.',
      },
      reason_codes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short machine-readable rationale (e.g. ["merchant_match:zoom", "historical_precedent", "business_tool"])',
      },
      review_required: {
        type: 'boolean',
        description: 'True when confidence < 0.90 or the transaction is ambiguous/mixed-purpose',
      },
    },
    required: ['entity', 'category_tax', 'category_budget', 'confidence', 'reason_codes', 'review_required'],
  },
};

const SYSTEM_PROMPT = `You are an expert US tax and accounting classification agent for a household with four entities:

1. **Elyse's Coaching** (entity: elyse_coaching — sole proprietor → Schedule C)
   Elyse's online coaching, courses, and digital products business.
   Valid tax categories: ${Object.keys(SCHEDULE_C_CATEGORIES).join(', ')}

2. **Jeremy's Coaching** (entity: jeremy_coaching — sole proprietor → Schedule C)
   Jeremy's coaching business, separate Schedule C.
   Valid tax categories: ${Object.keys(SCHEDULE_C_CATEGORIES).join(', ')}

3. **Whitford House Rental Activity** (entity: airbnb_activity → Schedule E)
   Whitford House short-term rental; tracks rental income and all associated expenses.
   Valid tax categories: ${Object.keys(AIRBNB_CATEGORIES).join(', ')}

4. **Family / Personal** (entity: family_personal — not deductible unless noted)
   Everything else, including potentially deductible personal items.
   Valid budget categories: ${Object.keys(FAMILY_CATEGORIES).join(', ')}

## Classification policy (MUST follow)
- NEVER fabricate certainty. Confidence reflects true uncertainty.
- PREFER historical precedent when near-identical merchant/pattern exists.
- HARD RULES override model judgment:
  * Personal mortgage interest → family_personal / interest_mortgage
  * Airbnb / VRBO platform fees → airbnb_activity / commissions
  * Zoom / Loom / coaching-tool SaaS on Elyse's accounts → elyse_coaching / office_expense or supplies
  * Amazon orders shipped to 912 Grandey Rd or Grandey Road are likely Whitford House expenses and should usually be classified as airbnb_activity
  * Amazon orders shipped to Edna Street are usually family_personal unless stronger evidence says otherwise
  * Elyse coaching income is usually a positive deposit into Elyse's Checking (Wells Fargo 9953) or Elyse's Venmo
  * Some 2025 Elyse coaching deposits arrived in Wells Fargo 3204 from Square Inc. and were then transferred out; treat the Square deposit as elyse_coaching income and the outbound movement as a transfer/internal move, not an expense
  * Elyse coaching expenses are usually negative amounts on Delta Skymiles Platinum card 8005; recurring coaching merchants include Google Workspace/Storage/Cloud, LinkedIn, QuickBooks, Dropbox, Typeform, Zoom, USPS, Apple billing, Dreamhost, Tiller, Doodle, and similar business tools
  * Jeremy coaching income/expenses go to jeremy_coaching — use account context and merchant to distinguish from Elyse's coaching
  * Whitford House income usually deposits into Wells Fargo 3204 and includes Airbnb, Booking.com, Square Inc., mobile deposits, ATM check deposits, and guest booking descriptions
  * Whitford House expenses are usually paid from Wells Fargo 3204, Chase Sapphire 9026, or Jeremy's Venmo
  * Jeremy's Venmo often pays Whitford expenses; if the Venmo balance was empty and the payment pulled from Wells Fargo 3204, still treat it as Whitford House activity
  * Transfers and credit card payments between owned accounts must be treated as transfers/internal moves, not income or expense
- FLAG split-purpose transactions with review_required=true and add "split_candidate" reason code.
- Reason codes must be short, machine-readable, and explain the key signal used.

## Confidence thresholds
- ≥ 0.90 → auto-accepted, set review_required=false
- 0.70-0.89 → suggested but must review, set review_required=true
- < 0.70 → manual review required, set review_required=true`;

export async function classifyTransaction(
  env: Env,
  transaction: Transaction,
  accountContext: string,
  historicalExamples: Array<{ merchant: string; entity: string; category_tax: string }>,
  amazonContext?: AmazonContext | null,
): Promise<AIClassification> {
  // DB convention: expenses stored as negative, income as positive
  // (Teller-native, and Chase/Venmo importers normalize to match).
  const isExpense = transaction.amount < 0;
  const amountStr = `$${Math.abs(transaction.amount).toFixed(2)} (${isExpense ? 'expense/debit' : 'income/credit'})`;

  const exampleBlock =
    historicalExamples.length > 0
      ? `\nSimilar past transactions (already classified):\n${historicalExamples
          .map(e => `  • "${e.merchant}" → ${e.entity} / ${e.category_tax}`)
          .join('\n')}`
      : '';

  const amazonBlock = amazonContext
    ? `\nAmazon order context:
- Order id:     ${amazonContext.order_id ?? '(unknown)'}
- Order date:   ${amazonContext.order_date ?? '(unknown)'}
- Ship date:    ${amazonContext.shipment_date ?? '(unknown)'}
- Ship to:      ${amazonContext.ship_to ?? '(unknown)'}
- Address:      ${amazonContext.shipping_address ?? '(unknown)'}
- Products:     ${amazonContext.product_names.join(' | ') || '(unknown)'}
- Sellers:      ${amazonContext.seller_names.join(' | ') || '(unknown)'}
- Destination hint: ${
      amazonContext.inferred_destination === 'whitford_house'
        ? 'Whitford House / Grandey Road'
        : amazonContext.inferred_destination === 'family_home'
          ? 'Family / Edna Street'
          : 'none'
    }`
    : '';

  const userMessage = `Classify this transaction:
- Merchant:     ${transaction.merchant_name ?? '(unknown)'}
- Description:  ${transaction.description}
- Amount:       ${amountStr}
- Date:         ${transaction.posted_date}
- Account:      ${accountContext}
${exampleBlock}
${amazonBlock}

Call the classify_transaction tool with your classification.`;

  const diagnostics = getClaudeDiagnostics(env);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      tools: [CLASSIFICATION_TOOL],
      tool_choice: { type: 'tool', name: 'classify_transaction' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Claude API request failed', {
      status: res.status,
      diagnostics,
      response_preview: err.slice(0, 500),
    });

    const diagnosticSuffix = res.status === 401
      ? ` | diagnostics=${JSON.stringify(diagnostics)}`
      : '';
    throw new Error(`Claude API error ${res.status}: ${err}${diagnosticSuffix}`);
  }

  const data = await res.json() as {
    content: Array<{ type: string; name?: string; input?: AIClassification }>;
  };

  const toolUse = data.content.find(b => b.type === 'tool_use' && b.name === 'classify_transaction');
  if (!toolUse?.input) {
    throw new Error('Claude did not return a classification tool call');
  }

  // Enforce confidence thresholds
  const result = toolUse.input;
  if (result.confidence < 0.9) result.review_required = true;
  return result;
}

// ── Batch classification with rate-limit awareness ────────────────────────────
export async function classifyBatch(
  env: Env,
  items: Array<{
    transaction: Transaction;
    accountContext: string;
    historicalExamples: Array<{ merchant: string; entity: string; category_tax: string }>;
    amazonContext?: AmazonContext | null;
  }>,
  onResult: (txId: string, result: AIClassification | null, error?: string) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    try {
      const result = await classifyTransaction(
        env,
        item.transaction,
        item.accountContext,
        item.historicalExamples,
        item.amazonContext,
      );
      await onResult(item.transaction.id, result);
    } catch (err) {
      await onResult(item.transaction.id, null, String(err));
    }
    // Modest delay to avoid hitting rate limits
    await new Promise(r => setTimeout(r, 200));
  }
}
