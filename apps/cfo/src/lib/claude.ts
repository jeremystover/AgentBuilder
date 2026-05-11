import type { Env, Transaction, AIClassification, AmazonContext, VenmoContext } from '../types';
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
        description: 'Which business entity this transaction belongs to. Omit (do not include) when category_tax is "transfer".',
      },
      category_tax: {
        type: 'string',
        description: 'Tax schedule category code (e.g. advertising, supplies, rental_income). Use "transfer" for any movement of money between owned accounts — credit card payments, bank-to-bank transfers, Venmo/Zelle settlements between personal accounts, etc. Transfers are excluded from taxes and budget.',
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
    required: ['category_tax', 'confidence', 'reason_codes', 'review_required'],
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
  * Whitford House is physically located in South Burlington / Burlington, Vermont (VT). When a transaction description or merchant location contains geographic hints such as "BURLINGTON", "S BURLING", "SOUTH BURL", "VT", "VERMONT", or other Vermont place names, it may be a Whitford House expense even if paid on a personal card — especially for gas stations, hardware stores, utility companies, plumbers, and other home/property services. Use the combination of geography + merchant type + account to decide; set confidence ≤ 0.80 and review_required=true with reason code "geographic_signal_vt" when Vermont geography is the key signal.
  * Common US gasoline and fuel brands: SUNOCO, Shell, ExxonMobil, Mobil, BP, Citgo, Gulf, Speedway, Sheetz, Wawa, Cumberland Farms → category_tax: car_truck. If the purchase appears Vermont-related, classify as airbnb_activity / car_truck with review_required=true; if clearly a personal road trip or commute, use family_personal / car_truck.
  * Transfers and credit card payments between owned accounts MUST use category_tax="transfer" and NO entity. This includes: credit card payments, bank-to-bank ACH transfers, Venmo/Zelle between your own accounts, moving money from checking to savings, etc. These are excluded from taxes and budget entirely.
- FLAG split-purpose transactions with review_required=true and add "split_candidate" reason code.
- Reason codes must be short, machine-readable, and explain the key signal used.

## Confidence thresholds
- ≥ 0.90 → auto-accepted, set review_required=false
- 0.70-0.89 → suggested but must review, set review_required=true
- < 0.70 → manual review required, set review_required=true`;

/**
 * Per-category vendor & signal guide. Appended to SYSTEM_PROMPT and cached via
 * Anthropic prompt caching (the system block has cache_control: ephemeral) so
 * the per-call cost is amortized across the batch.
 *
 * Each section follows the same shape:
 *   - Vendors: typical merchant types and brand names
 *   - Amounts: rough sanity range so wildly off-pattern txns get flagged
 *   - Routing: when to override the account-default entity
 *   - Disambiguation: lookalikes that belong in a *different* category
 *
 * Built up in groups; see commit history. Group A = vehicle/travel/meals.
 */
const CATEGORY_GUIDE = `

## Category recognition guide

For each tax/budget category, here are typical vendors, amount ranges, entity
routing rules, and lookalike traps. Use these as soft signals — the HARD RULES
above always win. When a transaction fits the category guide but the entity is
ambiguous, classify with confidence ≤ 0.80 and review_required=true.

### Group A — Vehicle, travel, and meals

**car_and_truck** (Schedule C, Line 9 — coaching business vehicle expenses)
- Vendors: gas/fuel (SUNOCO, Shell, Exxon, Mobil, BP, Citgo, Gulf, Speedway, Sheetz, Wawa, Cumberland Farms, Maverik, Stewart's, Mirabito, Marathon, Phillips 66, 76, ARCO, Chevron, Texaco, Costco Gas, Sam's Fuel, BJ's Fuel); EV charging (Tesla Supercharger, ChargePoint, EVgo, Electrify America, Blink, Volta, Flo); parking (ParkMobile, SpotHero, ParkWhiz, LAZ, "PARKING", "GARAGE"); tolls (E-ZPass, NJ TPK, Mass Pike, FasTrak, SunPass, "TOLL"); maintenance (Jiffy Lube, Valvoline, Midas, Meineke, Pep Boys, Firestone, Goodyear, Discount Tire, Mavis); parts (AutoZone, Advance Auto, NAPA, O'Reilly); registration ("DMV", "BMV", "SEC OF STATE"); car wash.
- Amounts: gas $20-$80, EV $5-$30, parking $2-$30, tolls $1-$15, oil change $40-$120, tires $400-$1500.
- Routing: default to coaching entity (elyse_coaching or jeremy_coaching) when paid on a coaching card AND the date/location matches a known coaching trip. If on a coaching card with no trip context, set confidence ~0.70 and ask for review.

**travel** (Schedule C, Line 24a — coaching business travel: airfare, lodging, ground transport)
- Vendors: airfare (Delta, American, United, Southwest, JetBlue, Alaska, Spirit, Frontier, Allegiant, Expedia, Kayak, Priceline-flights); lodging (Hilton, Marriott, Hyatt, Hampton, Holiday Inn, Sheraton, Westin, Courtyard, Embassy Suites, Best Western, Comfort Inn, Wyndham, IHG, Choice, Airbnb-as-guest, VRBO-as-guest, Hotels.com, Booking.com-as-guest); ground (Uber, Lyft, Hertz, Avis, Enterprise, Budget, Sixt, Alamo, National).
- Amounts: airfare $200-$1500, hotel-night $100-$500, rental-day $50-$200, rideshare $5-$80.
- Routing: only when on a coaching card during a multi-day business trip. Personal-card lodging → family_personal/entertainment. Trip TO Whitford House → airbnb_activity/auto_travel.
- Disambiguation: Uber Eats / DoorDash → meals or dining_out, NOT travel.

**meals** (Schedule C, Line 24b — 50% deductible business meals)
- Vendors: restaurants/coffee/fast-casual when paid on a coaching card during a known meeting or trip. Common: Starbucks, Dunkin', Chipotle, Panera, Sweetgreen, Chick-fil-A, plus local "BAR/GRILL/RESTAURANT/CAFE/BISTRO/DINER/PIZZ" descriptions.
- Amounts: $10-$100/ticket; >$200 on a coaching card during travel suggests a client dinner.
- Routing: must be on the coaching entity's card AND have a plausible business context (meeting, trip, client). Otherwise → family_personal/dining_out.
- Disambiguation: HelloFresh, Blue Apron, Home Chef, Factor → groceries (meal-kit subscription, not restaurant). Instacart, Shipt → groceries. Catering for a personal event → entertainment.

**rent_lease_vehicle** (Schedule C, Line 20a — long-term coaching vehicle leases)
- Vendors: monthly auto lease descriptions, Hertz Long-Term, Enterprise Lease, Penske long-term, U-Haul long-term-business.
- Amounts: recurring $300-$800/month.
- Routing: only when there's an explicit recurring monthly lease pattern. One-off rentals during a trip → travel (Sched C) or auto_travel (Sched E).

**auto_travel** (Schedule E, Line 6 — Whitford House vehicle and travel)
- The Schedule E twin of car_and_truck + travel. Same vendor types, but tied to the rental property.
- Routing signals (any one is enough to suggest airbnb_activity / auto_travel):
  * Description contains Vermont geography: "BURLINGTON", "S BURLING", "SOUTH BURL", "VT", "VERMONT", "WINOOSKI", "ESSEX", "COLCHESTER", "SHELBURNE", "WILLISTON", "STOWE".
  * Paid from Wells Fargo 3204, Chase Sapphire 9026, or Jeremy's Venmo (the Whitford-default accounts).
  * Airfare/lodging on dates that line up with a Whitford trip.
- When the geographic signal points to VT but the card is a personal one (e.g., Freedom), still suggest airbnb_activity/auto_travel with confidence ~0.75 and review_required=true with reason code "geographic_signal_vt".

**transportation** (Family / personal — non-business vehicle and personal travel)
- The personal default for any vehicle/travel/parking/toll/rideshare/maintenance/insurance-premium expense on a family_personal account when no Vermont signal and no coaching context.
- Routing: this is the fallback when car_and_truck and auto_travel are both ruled out.

**dining_out** (Family — personal restaurants, coffee, food delivery)
- Vendors: same restaurant/coffee/fast-casual list as meals + delivery (DoorDash, Grubhub, Uber Eats, Postmates, Caviar, Seamless, ChowNow, Toast).
- Amounts: $5-$80/ticket typical; >$150 on a personal card → consider groceries (warehouse run) or entertainment (special occasion).
- Routing: default for restaurant/coffee/delivery on a family_personal account when no business-meeting/trip context.
- Disambiguation: grocery-store delis ("WEGMANS DELI", "WHOLE FOODS PREPARED") → groceries. Catering → entertainment. Bar tabs at events → entertainment.
`;

const SYSTEM_PROMPT_FULL = SYSTEM_PROMPT + CATEGORY_GUIDE;

export async function classifyTransaction(
  env: Env,
  transaction: Transaction,
  accountContext: string,
  historicalExamples: Array<{ merchant: string; entity: string; category_tax: string }>,
  amazonContext?: AmazonContext | null,
  venmoContext?: VenmoContext | null,
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

  const venmoBlock = venmoContext
    ? `\nVenmo context:
- Direction:    ${venmoContext.direction === 'received' ? 'payment received' : venmoContext.direction === 'sent' ? 'payment sent' : 'charge received'}
- Counterparty: ${venmoContext.counterparty ?? '(unknown)'}
- Memo:         ${venmoContext.memo ?? '(none)'}
- Amount:       $${venmoContext.amount.toFixed(2)}`
    : '';

  const userMessage = `Classify this transaction:
- Merchant:     ${transaction.merchant_name ?? '(unknown)'}
- Description:  ${transaction.description}
- Amount:       ${amountStr}
- Date:         ${transaction.posted_date}
- Account:      ${accountContext}
${exampleBlock}
${amazonBlock}
${venmoBlock}

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
      // System prompt is identical across every classification in a batch;
      // marking it as ephemeral cache makes the first call write the cache
      // and every subsequent call within ~5 min hit it. Tools are cached
      // alongside the system block (cache lookup order: tools → system → messages).
      system: [
        { type: 'text', text: SYSTEM_PROMPT_FULL, cache_control: { type: 'ephemeral' } },
      ],
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
    venmoContext?: VenmoContext | null;
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
        item.venmoContext,
      );
      await onResult(item.transaction.id, result);
    } catch (err) {
      await onResult(item.transaction.id, null, String(err));
    }
    // Modest delay to avoid hitting rate limits
    await new Promise(r => setTimeout(r, 200));
  }
}
