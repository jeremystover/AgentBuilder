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
  * Whitford House is physically located in South Burlington / Burlington, Vermont (VT). When a transaction description or merchant location contains geographic hints such as "BURLINGTON", "S BURLING", "SOUTH BURL", "VT", "VERMONT", "CHARLOTTE", "ADDISON", "MIDDLEBURY", "VERGENNES", "FERRISBURGH", "HINESBURG", "WINOOSKI", "ESSEX", "COLCHESTER", "SHELBURNE", "WILLISTON", "STOWE", or other Vermont place names, it may be a Whitford House expense even if paid on a personal card — especially for gas stations, hardware stores, utility companies, plumbers, and other home/property services. Use the combination of geography + merchant type + account to decide; set confidence ≤ 0.80 and review_required=true with reason code "geographic_signal_vt" when Vermont geography is the key signal.
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
- Vendors: airfare — primary carriers are United and Delta; also Southwest, JetBlue, Alaska, American, Expedia, Kayak, Google Flights. Key city airports: SFO/SJC/OAK (San Francisco), DCA/IAD/BWI (Washington DC), BTV (Burlington VT), ATL (Atlanta), JFK/LGA/EWR (New York), GSP (Greenville SC). Lodging — any hotel chain (agnostic: Hilton, Marriott, Hyatt, IHG, Choice, Wyndham, etc.); also Airbnb/VRBO when traveling as a guest. Ground — Uber, Lyft, Hertz, Avis, Enterprise, Budget, Sixt.
- Amounts: airfare $200-$1500, hotel-night $100-$500, rental-day $50-$200, rideshare $5-$80.
- Routing: on a coaching card → coaching entity travel. Personal-card lodging → family_personal/entertainment. Hotel/flight to Vermont → airbnb_activity/auto_travel (managing the property), NOT coaching travel.
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
  * Description contains Vermont geography: BURLINGTON, S BURLING, SOUTH BURL, VT, VERMONT, WINOOSKI, ESSEX, COLCHESTER, SHELBURNE, WILLISTON, STOWE, CHARLOTTE VT, ADDISON, MIDDLEBURY, VERGENNES, FERRISBURGH, HINESBURG, RICHMOND VT, BRISTOL VT, MONKTON.
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

### Group B — Property operations and business-facility overlap

These categories share many of the same vendor types but route to different entities
(Whitford House vs. coaching business vs. personal). The key signals are: Vermont
geography (→ Whitford), coaching card (→ coaching), personal card (→ family).

**cleaning_maintenance** (Schedule E, Line 7 — Whitford House cleaning and upkeep)
- Vendors: cleaning services (local housekeepers, Handy, TaskRabbit-cleaning, Molly Maid, Two Maids, Merry Maids, ZURU, "CLEANING", "HOUSEKEEPER"); lawn/garden (lawn care companies, TruGreen, "LAWN", "LANDSCAP", "MOWING", "SNOW REMOVAL", "PLOWING"); pest control (Orkin, Terminix, Western Pest, "PEST"); pool/spa; pressure washing; chimney sweep.
- Amounts: housekeeper $80-$400/visit, lawn $50-$200/visit, pest control $80-$300.
- Routing: any cleaning/lawn/pest vendor with a Vermont address signal or paid from Whitford-default accounts → airbnb_activity/cleaning_maintenance. On a personal card with no Vermont signal: flag for review (may still be Whitford).
- Disambiguation: cleaning supplies bought at a store (Costco, Target) → supplies_rental (Sched E) or supplies (Sched C). Cleaning labor is this category; cleaning products are supplies.

**repairs_rental** (Schedule E, Line 14 — Whitford House repairs)
- Vendors: contractors (general contractor descriptions, "CONTRACTING", "REMODEL"), plumbers ("PLUMB", "DRAIN", "ROOTER"), electricians ("ELECTRIC", "ELECTRICAL"), HVAC ("HVAC", "HEATING", "COOLING", "FURNACE", "AIR CONDITION"), roofers ("ROOF"), handyman services, Home Depot, Lowe's, Menards, Ace Hardware, True Value — when purchased for the property. Also: appliance repair (Sears Home Services, A&E Factory, local appliance repair).
- Amounts: plumber visit $100-$500, contractor invoice $500-$20,000, appliance repair $100-$400, hardware run $20-$500.
- Routing: Vermont address signal or Whitford-default accounts → airbnb_activity/repairs_rental. Same vendors with no Vermont signal on a personal card → could be personal home repairs (family_personal/housing) or coaching office repairs (if home-office) — flag for review.
- Disambiguation: Home Depot / Lowe's on a personal card with no Vermont signal is ambiguous — could be repairs_rental (Whitford), housing (personal), or supplies — flag with confidence ~0.65.

**repairs_maintenance** (Schedule C, Line 21 — coaching business office/equipment repairs)
- Vendors: computer repair (Micro Center, Best Buy Geek Squad, uBreakiFix, Apple Store-repair), printer/office equipment repair, IT services. Rarely hardware stores unless there's a clear home-office context.
- Amounts: $50-$500 typical.
- Routing: on a coaching card with a tech/equipment description → coaching entity. Vermont + hardware → repairs_rental (Sched E) wins.

**utilities_rental** (Schedule E, Line 17 — Whitford House utilities)
- Vendors: electricity (Green Mountain Power, GMP, "ELECTRIC"), natural gas / oil heat (Vermont Gas Systems, Dead River, Irving Oil, National Fuel), water/sewer ("WATER DEPT", "WATER DISTRICT", "DPW"), internet/cable (Comcast, Spectrum, Burlington Telecom, "INTERNET", "CABLE"), trash (Casella Waste, "WASTE", "TRASH", "RUBBISH"), propane (AmeriGas, Ferrellgas, Suburban Propane, "PROPANE").
- Amounts: electricity $60-$300/mo, gas/oil $100-$600/mo, water $30-$100/mo, internet $50-$150/mo, trash $30-$80/mo, propane delivery $200-$800.
- Routing: Vermont utility names almost certainly airbnb_activity/utilities_rental. National names (Comcast, Spectrum) on a personal card without Vermont signal → family_personal/housing (home internet/cable).
- Disambiguation: cell phone bill → subscriptions (family) or office_expense (coaching). Streaming services (Netflix, Hulu, Spotify) → subscriptions (family) or office_expense if business.

**utilities** (Schedule C, Line 25 — coaching business utilities: internet, phone, software as utility)
- Vendors: internet service for the coaching office (Comcast Business, AT&T Business, Verizon Business), dedicated business phone line, coworking space utilities. Note: most "utility" costs for a coaching business run through SaaS subscriptions, not traditional utilities.
- Routing: only coaching-card + clearly business-service description. Residential internet on a personal card → family_personal/housing. Vermont utilities → utilities_rental (Sched E).

**insurance_rental** (Schedule E, Line 9 — Whitford House property insurance)
- Vendors: property/landlord insurance (State Farm, Allstate, Travelers, Liberty Mutual, Amica, USAA, Stillwater, Foremost, descriptions containing "PROPERTY INS", "LANDLORD INS", "HOMEOWNER", "DWELLING"), umbrella policies, flood insurance (FEMA NFIP), vacation-rental liability (Proper Insurance, Proper.insure, vacation-rental rider descriptions).
- Amounts: annual premium $1,000-$5,000 paid monthly ($100-$500) or as lump sum; flood separately $500-$2,500/yr.
- Routing: insurance on Whitford-default accounts or Vermont address → airbnb_activity/insurance_rental. Auto insurance → car_and_truck (Sched C) or transportation (family). Health/dental → healthcare (family). Business liability for coaching → insurance (Sched C).

**insurance** (Schedule C, Line 15 — coaching business insurance)
- Vendors: professional liability / E&O insurance for coaches (Hiscox, Next Insurance, Thimble, FLIP, descriptions with "PROFESSIONAL LIABILITY", "E&O", "ERRORS AND OMISSIONS"), business owners policy (BOP), cyber liability.
- Amounts: $50-$300/mo or $500-$3,000/yr.
- Routing: coaching-card + insurance description with no Vermont/property context → coaching entity. Otherwise see insurance_rental.

**mortgage_interest** (Schedule E, Line 12 — Whitford House mortgage interest)
- Vendors: mortgage servicers (Nationstar, Mr. Cooper, Wells Fargo Home Mortgage, Chase Mortgage, Quicken/Rocket Mortgage, LoanDepot, PenFed, Truist, "MORTGAGE PMT", "LOAN PMT").
- Amounts: typically $1,000-$5,000/mo; principal + interest together may be higher.
- Routing: HARD RULE — personal mortgage interest → family_personal/interest_mortgage. Only the Whitford House mortgage (property at Grandey Road / South Burlington) goes to airbnb_activity/mortgage_interest. Distinguishing signal: if paid from Wells Fargo 3204 or Chase Sapphire 9026, it is likely the Whitford mortgage.

**other_interest** (Schedule E, Line 13 — Whitford House other interest)
- Vendors: HELOC payments, business credit line interest, bridge loan interest tied to the property.
- Amounts: varies.
- Routing: interest on debt secured by Whitford House → airbnb_activity/other_interest. Credit card interest on personal cards → family_personal/other_personal. Credit card interest on coaching cards → other_expenses (Sched C).

### Group C — Operating overhead (SaaS, professional services, and business tools)

**office_expense** (Schedule C, Line 18 — software, subscriptions, and services used to run the coaching business)
- Vendors: video/comms (Zoom, Loom, Riverside.fm, Descript, Otter.ai, Rev); productivity (Google Workspace, Google One, Notion, Airtable, ClickUp, Asana, Trello, Monday.com, Coda, Basecamp); file storage (Dropbox, Box, iCloud Business, Google Drive); email marketing (ConvertKit, Beehiiv, Mailchimp, ActiveCampaign, Flodesk, AWeber); course/community platforms (Kajabi, Teachable, Thinkific, Podia, Circle, Mighty Networks, Skool, Systeme.io); scheduling (Calendly, Acuity, Doodle, SavvyCal, Zcal); website/hosting (Dreamhost, Bluehost, WP Engine, Kinsta, Squarespace, Webflow, Wix, Netlify, Vercel, WordPress.com, Namecheap, GoDaddy-domains); CRM (HubSpot, Dubsado, Honeybook, Pipedrive, Close); forms/surveys (Typeform, Jotform, SurveyMonkey, Tally.so); accounting (QuickBooks, FreshBooks, Wave, Bench, Tiller, 1-800-Accountant); contract/legal (HelloSign, DocuSign, Adobe Sign, PandaDoc); AI tools (ChatGPT/OpenAI, Claude/Anthropic, Jasper, Copy.ai, Midjourney, Canva Pro, Adobe CC).
- Amounts: SaaS $5-$500/mo; annual plans $50-$5,000.
- Routing: on Elyse's coaching card (Delta Skymiles 8005) or Jeremy's coaching account → coaching entity/office_expense. Same vendor on a personal card → subscriptions (family).
- Disambiguation: Apple billing — if for iCloud personal storage → subscriptions (family); if for business apps → office_expense. Amazon AWS → office_expense if clearly dev/hosting. Netflix/Spotify/Disney+ → subscriptions (family).

**supplies** (Schedule C, Line 22 — tangible supplies consumed by the coaching business)
- Vendors: office supplies (Staples, Office Depot, Amazon-shipped-to-home-office for office items); printer ink/toner; postage/shipping (USPS, FedEx, UPS, Stamps.com) for business mail; background/props for video content; microphones, webcams, ring lights, podcast equipment; business cards/stationery (Moo, Vistaprint, Zazzle).
- Amounts: $5-$500 typical; tech peripherals up to $300 before depreciation threshold.
- Routing: coaching card + tangible-item or shipping description → coaching entity/supplies.
- Disambiguation: Amazon orders with products shipped to a home office address (Edna St) may be supplies; shipped to Grandey Rd → supplies_rental (Sched E).

**advertising** (Schedule C, Line 8 — paid marketing for the coaching business)
- Vendors: social media ads (Meta/Facebook Ads, Instagram Ads, LinkedIn Ads, Pinterest Ads, Twitter/X Ads, TikTok for Business); search ads (Google Ads, Microsoft/Bing Ads); podcast advertising (AdvertiseCast, Midroll); PR / media placements; copywriting contractors paid per campaign; graphic design tools used exclusively for ad creation.
- Amounts: ad spend $50-$5,000+/mo (varies widely); one-off creative $50-$500.
- Routing: coaching card + "ADS", "ADVERTISING", "MARKETING", "PROMOTED", "SPONSORED" → coaching entity/advertising.

**advertising_rental** (Schedule E, Line 5 — Whitford House listing and marketing costs)
- Vendors: Airbnb host fees beyond the platform commission (extra listing boosts, professional photography for listing), VRBO listing fees, Furnished Finder, Lodgify, Hospitable, Hostfully, PriceLabs, Beyond Pricing, Wheelhouse (dynamic pricing tools).
- Amounts: dynamic pricing tools $10-$60/mo; photography $200-$800 one-off.
- Routing: Whitford-default accounts + rental-listing/management description → airbnb_activity/advertising_rental.

**legal_professional** (Schedule C, Line 17 — legal, accounting, and professional fees for coaching)
- Vendors: attorneys (law firm names, "ATTORNEY", "LAW OFFICE", "LEGAL"); CPAs/accountants ("CPA", "ACCOUNTING", "TAX PREP"); business coaches hired by Elyse or Jeremy for their coaching businesses; professional consultants; LegalZoom/Rocket Lawyer/Clerky for business formation documents.
- Amounts: attorney $200-$500/hr; CPA $200-$600/filing; consultant $100-$500/hr.
- Routing: coaching card → coaching entity/legal_professional. If clearly for Whitford House (landlord-tenant issue, property title work) → airbnb_activity/legal_professional_r.

**legal_professional_r** (Schedule E, Line 10 — legal and professional fees for Whitford House)
- Vendors: same as legal_professional but context is rental property — real estate attorney, property management contract review, short-term rental compliance consulting, local permit fees paid to an agent.
- Routing: Whitford-default accounts + legal/professional description → airbnb_activity/legal_professional_r.

**commissions_and_fees** (Schedule C, Line 10 — fees paid to platforms or contractors for coaching revenue)
- Vendors: payment processing (Stripe, Square, PayPal-fees, Braintree); platform marketplace fees (if coaching on a platform that takes a cut); bank fees charged on business accounts.
- Amounts: processing fees typically 2.5-3% of transaction, shown as small deductions.
- Routing: coaching card/account + fee description → coaching entity/commissions_and_fees.

**commissions** (Schedule E, Line 8 — Airbnb/VRBO platform commissions on rental income)
- Vendors: Airbnb host service fee (appears as a deduction from payout), VRBO service fee, Booking.com commission. Often visible as a negative on the income payout rather than a separate charge.
- Routing: any "AIRBNB FEE", "VRBO FEE", "BOOKING.COM FEE" → airbnb_activity/commissions. HARD RULE in place.

**management_fees** (Schedule E, Line 11 — third-party property management fees)
- Vendors: local property management companies ("PROPERTY MGMT", "VACATION RENTAL MGMT"), concierge co-host services, Evolve Vacation Rental, Vacasa, Turnkey, Guesty.
- Amounts: typically 10-30% of rental revenue, or a flat $100-$500/mo.
- Routing: Whitford-default accounts + management description → airbnb_activity/management_fees.

**taxes_licenses** (Schedule C, Line 23 — coaching business taxes and licenses)
- Vendors: state business registration fees ("SECRETARY OF STATE", "DEPT OF STATE", "SOS"), local business license ("CITY CLERK", "BUSINESS LICENSE"), sales tax remitted on coaching products, self-employment tax installments (IRS EFTPS — though these are more personal; check).
- Amounts: registration $50-$500/yr; license $25-$200/yr.
- Routing: coaching card/account + govt-fee description → coaching entity/taxes_licenses.

**taxes_rental** (Schedule E, Line 16 — property taxes on Whitford House)
- Vendors: City of South Burlington, Town of South Burlington, Vermont property tax bills, "PROPERTY TAX", "REAL ESTATE TAX", "TAX COLLECTOR".
- Amounts: annual property tax varies widely; often $3,000-$12,000/yr paid in installments.
- Routing: Whitford-default accounts + property tax description → airbnb_activity/taxes_rental. IRS estimated tax payments (Form 1040-ES) → family_personal/potentially_deductible (personal income tax, not deductible as rental expense).

**contract_labor** (Schedule C, Line 11 — 1099 contractors paid by coaching business)
- Vendors: individual contractors paid via Venmo/Zelle/ACH with a business description, Fiverr, Upwork, Toptal, 99designs, Guru. Often no merchant name — just a person's name in the Venmo memo.
- Amounts: $50-$5,000+ per engagement.
- Routing: coaching card/Venmo with memo suggesting work performed (e.g., "video editing", "web design", "VA work") → coaching entity/contract_labor. Generic Venmo with no memo → flag for review.

**wages** (Schedule C, Line 26 — W-2 employee wages from the coaching business)
- Vendors: ADP, Gusto, Rippling, Justworks, Paychex, "PAYROLL" descriptions, direct deposits to employees.
- Amounts: payroll varies.
- Routing: if the coaching business has employees, payroll-processor descriptions on the coaching account → coaching entity/wages.

**subscriptions** (Family — personal recurring services)
- Vendors: streaming (Netflix, Hulu, Disney+, Max, Peacock, Paramount+, Apple TV+, Amazon Prime Video); music (Spotify, Apple Music, Tidal, Amazon Music); news (NYT, WSJ, Washington Post, The Atlantic, Substack); cloud storage (iCloud+, Google One — personal tier); gaming (Xbox Game Pass, PlayStation Plus, Nintendo); fitness apps (Peloton, Noom, Calm, Headspace); other recurring personal services.
- Amounts: $5-$30/mo each; total household $100-$300/mo is common.
- Routing: personal card → family_personal/subscriptions. Same vendor on coaching card → office_expense.
- Disambiguation: SaaS business tools (Zoom, Notion, Kajabi) → office_expense when on coaching card. Annual Apple iCloud → subscriptions; Apple developer program annual fee → office_expense.

### Group D — Personal day-to-day spending

**groceries** (Family)
- Vendors: supermarkets (Whole Foods, Trader Joe's, Sprouts, Wegmans, Stop & Shop, Hannaford, Shaw's, Market Basket, Price Chopper, Aldi, Lidl, H-E-B, Kroger, Safeway, Albertsons, Publix); warehouse clubs (Costco, Sam's Club, BJ's — food portions); specialty (ethnic grocery stores, natural food co-ops, local farm stands, CSA subscriptions); grocery delivery (Instacart, Shipt, Amazon Fresh, FreshDirect, Thrive Market — when description is clearly food); meal kits (HelloFresh, Blue Apron, Home Chef, Green Chef, Factor, Gobble, Sunbasket).
- Amounts: grocery run $30-$300; Costco $50-$600 (bulk + non-food items often mixed in).
- Routing: personal card + grocery chain → family_personal/groceries. Coaching card + grocery = flag for review (possible client-meeting supplies → meals, or personal charge on wrong card).
- Disambiguation: Costco/Sam's large receipts may include household supplies — lean groceries unless the amount is extremely large ($600+). Restaurant and takeout → dining_out. Pharmacy purchases at a grocery store (CVS, Walgreens counter) → healthcare.

**entertainment** (Family)
- Vendors: live events (Ticketmaster, StubHub, AXS, SeatGeek, Eventbrite, live venue names); movies (AMC, Regal, Cinemark, Fandango, Alamo Drafthouse); concerts/theater; sports teams and arenas; amusement parks (Disney parks, Universal, Six Flags); museums, zoos, aquariums; mini-golf, bowling, escape rooms, axe-throwing; vacation experiences (tours, activities booked through Viator, GetYourGuide, Airbnb Experiences-as-guest); gaming (Steam, PlayStation Store, Xbox/Microsoft Store, Nintendo eShop, in-app purchases); books/audiobooks (Audible, Kindle, Barnes & Noble).
- Amounts: movie $10-$30; event tickets $30-$300+; park entry $50-$200+.
- Routing: personal card + leisure description → family_personal/entertainment. Coaching card + event = flag for review (conference/seminar → travel or other_expenses; client-entertainment → meals if food involved, other_expenses if activity).
- Disambiguation: vacation hotel/flight on a personal card → entertainment. Business conference registration → other_expenses (Sched C). Charity gala ticket with donation portion → charitable_giving (the deductible amount).

**healthcare** (Family)
- Vendors: pharmacies (CVS, Walgreens, Rite Aid, Duane Reade, local pharmacy); doctors and specialists (office visit descriptions, urgent care: CityMD, MedExpress, "MEDICAL", "MD", "DR.", "CLINIC"); dental (dentist office names, "DENTAL", "ORTHODONT"); vision (LensCrafters, Warby Parker, America's Best, "OPTOM", "VISION CENTER"); hospitals ("HOSPITAL", "MEDICAL CENTER"); mental health (therapist/psychiatry offices, BetterHelp, Talkspace, Alma); labs (LabCorp, Quest Diagnostics); health insurance premiums (Aetna, BCBS, UnitedHealth, Cigna, Kaiser — if paid out-of-pocket); FSA/HSA purchases; fitness (gym membership: Planet Fitness, Equinox, LA Fitness, local gyms — if health-motivated); medical equipment.
- Amounts: pharmacy $5-$200; doctor visit copay $20-$100; specialist $100-$500; premium $200-$1,000/mo.
- Routing: personal card + medical description → family_personal/healthcare.
- Disambiguation: gym memberships and fitness apps (Peloton, ClassPass, Noom) can be healthcare OR personal_care — lean healthcare for gyms, personal_care for beauty/wellness apps. Health insurance premiums paid by the coaching business → insurance (Sched C) for self-employed health insurance deduction.

**education** (Family)
- Vendors: tuition payments ("TUITION", "UNIVERSITY", "COLLEGE", school names); online learning (Coursera, Udemy, LinkedIn Learning, Skillshare, MasterClass, Khan Academy, Duolingo Plus); tutoring (Wyzant, Tutor.com, local tutor); books for school; school supplies; SAT/ACT prep; extracurricular programs for children.
- Amounts: tuition varies; online course $10-$500; tutoring $50-$200/hr.
- Routing: personal card + education description → family_personal/education.
- Disambiguation: professional courses/certifications that directly improve the coaching business → office_expense or other_expenses (Sched C), NOT family education. Children's activities (sports leagues, camps) → education or entertainment — lean education for structured learning, entertainment for purely recreational.

**personal_care** (Family)
- Vendors: hair salons (Great Clips, Supercuts, local salon names, "HAIR", "SALON", "BARBER"); nail salons ("NAIL", "MANICURE", "PEDICURE"); spa and massage ("SPA", "MASSAGE", "DAY SPA", "MASSAGE ENVY"); beauty products (Sephora, Ulta, MAC, local beauty supply); personal grooming (razor subscriptions: Dollar Shave Club, Harry's, Billie; deodorant/personal items when the primary purchase); laundry/dry cleaning ("DRY CLEAN", "LAUNDRY", "WASH", "CLEANER'S"); tailoring/alterations.
- Amounts: haircut $20-$150; salon visit $50-$300; spa $75-$300; Sephora/Ulta $20-$200.
- Routing: personal card + grooming/beauty description → family_personal/personal_care.
- Disambiguation: professional grooming that is business-required (e.g., hair and makeup for a coaching photoshoot or speaking event) could be supplies (Sched C) — flag for review if on a coaching card.

**shopping** (Family — personal non-essential retail)
- Vendors: department stores (Nordstrom, Macy's, Bloomingdale's, Saks, Neiman Marcus, JCPenney, Kohl's, Target); fast fashion (H&M, Zara, Gap, Old Navy, Banana Republic, J.Crew, Uniqlo); clothing specialty (Lululemon, Athleta, Patagonia, REI, L.L.Bean, Nike, Adidas); shoes (DSW, Foot Locker, Steve Madden, Zappos); home goods (Williams-Sonoma, Pottery Barn, West Elm, Restoration Hardware/RH, Crate & Barrel, IKEA, Wayfair, HomeGoods/TJX/Marshalls); electronics (Best Buy, Apple Store-hardware, B&H Photo, Adorama); Amazon orders shipped to personal home (Edna St) with non-office products.
- Amounts: $20-$1,000+; wide range.
- Routing: personal card + retail description → family_personal/shopping. Amazon to Edna St → shopping unless product is clearly business-related. Amazon to Grandey Rd → supplies_rental (Sched E).
- Disambiguation: clothing bought for a coaching photoshoot or speaking event → flag for review (could be supplies Sched C, though IRS scrutiny is high on clothing deductions). REI/outdoor gear for a Vermont property trip → shopping vs. supplies_rental — flag for review.

**charitable_giving** (Family)
- Vendors: non-profits and charities (GoFundMe, charity names, "DONATION", "CHARITY", church names, United Way, Red Cross, local food bank, school fundraisers, political campaigns — though political donations are NOT deductible); Facebook Fundraisers; Daffy; Fidelity Charitable; community foundations.
- Amounts: $5-$10,000+.
- Routing: personal card + charity description → family_personal/charitable_giving.
- Disambiguation: gala tickets / charity dinners — only the portion above fair-market-value is deductible; lean charitable_giving with a note, or potentially_deductible. Political donations (Act Blue, Win Red, candidate names) → other_personal (not deductible).

**housing** (Family — primary home costs)
- Vendors: personal rent or mortgage (personal-residence mortgage servicers: Mr. Cooper, Wells Fargo Home Mortgage, etc. — on personal accounts and NOT the Whitford mortgage); renters/homeowners insurance (on a personal account); HOA fees ("HOA", "HOMEOWNERS ASSOC"); home improvement for personal residence (Home Depot, Lowe's on a personal card without Vermont signal); personal utilities (internet/cable/electric/gas on a personal account when no Vermont signal — see utilities_rental for the Vermont version).
- Routing: personal card + housing description + no Vermont signal → family_personal/housing.
- Disambiguation: Vermont property costs → airbnb_activity (repairs_rental, utilities_rental, etc.). Renting an office space for coaching → rent_lease_property (Sched C). Hotel during personal travel → entertainment.

### Group E — Income, depreciation, and catch-all categories

**income** (Schedule C, Line 1 — coaching gross receipts)
- Signals: positive deposit (income/credit) into Elyse's or Jeremy's coaching accounts. Elyse: Wells Fargo 9953 or Elyse's Venmo from clients/students; Square Inc. deposits for 2025 paid-products; course platform payouts (Kajabi, Teachable, Thinkific, PayPal-business, Stripe deposits). Jeremy: similar pattern on Jeremy's designated coaching account.
- Amounts: client payment $100-$5,000+; course launch $500-$50,000+; platform payout schedule varies (weekly/monthly).
- Routing: positive credit on coaching account from a client, platform, or payment processor → coaching entity/income.
- Disambiguation: Airbnb/VRBO/Booking.com payouts → airbnb_activity/rental_income (NOT coaching income). Square deposits that land in Wells Fargo 3204 → treat as Whitford income (guest payments) unless clearly from a coaching client. Refund from a business vendor (negative-amount reversal) → not income; reverse the original expense category.

**rental_income** (Schedule E, Line 3 — Whitford House rental income)
- Signals: positive deposit into Wells Fargo 3204 from Airbnb, VRBO, Booking.com, Square Inc. (guest payments), mobile check deposits, ATM deposits with guest-related descriptions.
- Amounts: short-term rental payout $500-$5,000 per booking cycle; net of Airbnb's host fee.
- Routing: Whitford-default accounts + rental-platform or guest-payment description → airbnb_activity/rental_income. HARD RULE: Airbnb/VRBO platform payouts always rental_income.
- Disambiguation: Airbnb credit card rewards redemption (if travel credit) → family_personal/other_personal. Security deposit received is NOT income (it's a liability until earned or kept).

**depreciation** (Schedule C, Line 13 — coaching business asset depreciation)
- This category is typically entered manually at tax time by an accountant, not from bank transactions. Flag any transaction classified here for review — it's almost certainly an error if it came from a bank feed. Vehicles, computers, and equipment purchased for the coaching business are depreciated on Form 4562, not as a line-item expense deduction.

**depreciation_rental** (Schedule E, Line 18 — Whitford House depreciation)
- Same note as above — depreciation is a non-cash adjustment entered at tax prep, not a bank transaction. Flag automatically.

**rent_lease_property** (Schedule C, Line 20b — coaching business office rent)
- Vendors: co-working space memberships (WeWork, Regus, IWG, Industrious, The Wing, local co-working names, "COWORKING", "SHARED OFFICE"); studio rental for content creation; storage unit rented for business inventory.
- Amounts: co-working $150-$800/mo; studio rental $50-$300/session.
- Routing: coaching card + office/studio/storage rent description → coaching entity/rent_lease_property.

**other_expenses** (Schedule C, Line 27 — coaching miscellaneous business expenses)
- Use for legitimate coaching business expenses that don't fit any other specific Schedule C line. Examples: professional membership dues (ICF coaching certification, coaching associations), conference registration fees, business gifts to clients (≤$25/recipient per IRS), bank fees on business accounts, credit card annual fees on coaching cards, foreign transaction fees on business travel.
- Routing: coaching card + business-purpose description that doesn't match a more specific category → coaching entity/other_expenses. Do NOT use as a dumping ground for personal charges that happened to land on the coaching card.

**other_rental** (Schedule E, Line 19 — Whitford House miscellaneous rental expenses)
- Use for legitimate Whitford House expenses that don't fit any other Schedule E line. Examples: host/STR licensing and permit fees to the City of Burlington, co-host gifts to guests (>$25 worth of amenities), smart-home device subscriptions for the property (Nest, Ring, August Lock), STR platform subscription tools.
- Routing: Whitford-default accounts + property-management description that doesn't fit a more specific Sched E category → airbnb_activity/other_rental.

**other_personal** (Family — personal spending that doesn't fit anywhere else)
- Use only when none of the other family categories apply. Examples: legal/political fees (bail, fines, parking tickets — NOT deductible), ATM withdrawals (cash), fees with no description, international wire transfers for personal reasons.
- ATM cash withdrawals are common: classify as family_personal/other_personal unless context strongly implies a specific category.
- Routing: personal card + unclassifiable description → family_personal/other_personal. This is the final fallback.

**potentially_deductible** (Family — items that might be deductible on personal return)
- Use for personal expenses that may generate a deduction on the Form 1040 (not Schedule C/E). Examples: mortgage interest and property taxes on the primary residence (Schedule A if itemizing), student loan interest (Form 1040 line 21), self-employed health insurance premiums (Form 1040 line 17 — note: may overlap with coaching entities), IRA/HSA contributions, child/dependent care (Form 2441), educator expenses, home energy credits.
- Routing: personal card + description suggesting a personal deduction → family_personal/potentially_deductible. This is intentionally broad — the accountant will confirm at tax time.
- Disambiguation: business deductions go on Schedule C/E, not here. This is only for personal-return deductions. Do NOT put coaching business expenses here.
`;

const SYSTEM_PROMPT_FULL = SYSTEM_PROMPT + CATEGORY_GUIDE;

// Cached system block — identical across every call in a batch, so Anthropic
// reuses the KV cache entry and charges only ~10% of normal input tokens after
// the first call in a 5-minute window.
const CACHED_SYSTEM = [
  { type: 'text' as const, text: SYSTEM_PROMPT_FULL, cache_control: { type: 'ephemeral' as const } },
];

type ContentBlock = {
  type: string;
  id?: string;
  name?: string;
  input?: AIClassification;
};

// ── First-pass: forced single classify_transaction call ───────────────────────
async function callClaudeFirstPass(
  env: Env,
  userMessage: string,
): Promise<{ result: AIClassification; diagnostics: ReturnType<typeof getClaudeDiagnostics> }> {
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
      system: CACHED_SYSTEM,
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
    const suffix = res.status === 401 ? ` | diagnostics=${JSON.stringify(diagnostics)}` : '';
    throw new Error(`Claude API error ${res.status}: ${err}${suffix}`);
  }

  const data = await res.json() as { content: ContentBlock[] };
  const toolUse = data.content.find(b => b.type === 'tool_use' && b.name === 'classify_transaction');
  if (!toolUse?.input) throw new Error('Claude did not return a classification tool call');

  return { result: toolUse.input, diagnostics };
}

// ── Second-pass: web search enabled for unknown merchants ─────────────────────
// Only fires when first-pass confidence < 0.75. Uses Anthropic's built-in
// web_search_20250305 server tool so no external search API key is required.
// Runs a multi-turn loop (max 4 turns) to let the model search → read →
// classify. If search doesn't help (or fails), falls back to first-pass result.
async function callClaudeWithWebSearch(
  env: Env,
  userMessage: string,
): Promise<AIClassification | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webSearchTool = { type: 'web_search_20250305', name: 'web_search' } as any;

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    {
      role: 'user',
      content:
        userMessage +
        '\n\nNote: if the merchant name is unfamiliar or ambiguous, use web_search to look it up first. Then call classify_transaction.',
    },
  ];

  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        tools: [webSearchTool, CLASSIFICATION_TOOL],
        tool_choice: { type: 'auto' },
        system: CACHED_SYSTEM,
        messages,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json() as { stop_reason: string; content: ContentBlock[] };

    // If classify_transaction appeared in this turn, we're done
    const classifyBlock = data.content.find(
      b => b.type === 'tool_use' && b.name === 'classify_transaction',
    );
    if (classifyBlock?.input) return classifyBlock.input;

    if (data.stop_reason === 'end_turn') return null;

    // Add this assistant turn and submit placeholder tool_results so the loop
    // can continue. For web_search, Anthropic's server has already executed the
    // search and included results in the response content; the placeholder here
    // satisfies the API's requirement to acknowledge every tool_use block.
    messages.push({ role: 'assistant', content: data.content });
    const toolUseBlocks = data.content.filter(b => b.type === 'tool_use' && b.id);
    if (toolUseBlocks.length === 0) return null;

    messages.push({
      role: 'user',
      content: toolUseBlocks.map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: '',
      })),
    });
  }

  return null;
}

export async function classifyTransaction(
  env: Env,
  transaction: Transaction,
  accountContext: string,
  historicalExamples: Array<{ merchant: string; entity: string; category_tax: string }>,
  amazonContext?: AmazonContext | null,
  venmoContext?: VenmoContext | null,
): Promise<AIClassification> {
  // DB convention: expenses stored as negative, income as positive
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

  // ── Pass 1: fast forced single tool call ────────────────────────────────────
  const { result: first } = await callClaudeFirstPass(env, userMessage);

  // Auto-accept if confidence is high enough — skip the search pass entirely
  if (first.confidence >= 0.75) {
    if (first.confidence < 0.9) first.review_required = true;
    return first;
  }

  // ── Pass 2: web search for unknown merchants (only when confidence < 0.75) ──
  try {
    const searched = await callClaudeWithWebSearch(env, userMessage);
    if (searched && searched.confidence > first.confidence) {
      if (searched.confidence < 0.9) searched.review_required = true;
      return searched;
    }
  } catch (err) {
    // Web search pass failed — not fatal, fall through to first result
    console.warn('Web search pass failed, using first-pass result', String(err));
  }

  // Fall back to first-pass result
  if (first.confidence < 0.9) first.review_required = true;
  return first;
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
