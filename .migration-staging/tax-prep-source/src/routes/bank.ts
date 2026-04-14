import { z } from 'zod';
import type { BankProvider, Env } from '../types';
import { getUserId, jsonError, jsonOk } from '../types';
import {
  getActiveTaxYearOrThrow,
  getTaxYearDateRange,
  markChecklistItemsCompleteForAccounts,
  reconcileChecklistAccountLinks,
} from '../lib/tax-year';
import {
  createPlaidLinkTokenForUser,
  exchangePlaidPublicTokenForUser,
  syncPlaidTransactionsForUser,
} from './plaid';
import {
  connectTellerEnrollmentForUser,
  getTellerBankConfig,
  syncTellerTransactionsForUser,
} from './teller';

const ProviderSchema = z.enum(['plaid', 'teller']);
const SyncSchema = z.object({
  provider: ProviderSchema.optional(),
  account_ids: z.array(z.string().min(1)).min(1).optional(),
});

function isPlaidConfigured(env: Env): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}

function isTellerConfigured(env: Env): boolean {
  return Boolean(env.TELLER_APPLICATION_ID);
}

function getAvailableProviders(env: Env): BankProvider[] {
  const providers: BankProvider[] = [];
  if (isPlaidConfigured(env)) providers.push('plaid');
  if (isTellerConfigured(env)) providers.push('teller');
  return providers;
}

function getDefaultProvider(env: Env): BankProvider {
  const configured = getAvailableProviders(env);
  const fallback = configured[0] ?? 'plaid';
  const parsed = ProviderSchema.safeParse(env.DEFAULT_BANK_PROVIDER ?? fallback);
  if (!parsed.success) return fallback;
  if (configured.length > 0 && !configured.includes(parsed.data)) return fallback;
  return parsed.data;
}

function resolveProvider(env: Env, requested?: string | null): BankProvider {
  const provider = requested ?? getDefaultProvider(env);
  const parsed = ProviderSchema.safeParse(provider);
  if (!parsed.success) {
    throw new Error(`Unsupported bank provider "${requested ?? ''}".`);
  }

  const available = getAvailableProviders(env);
  if (!available.includes(parsed.data)) {
    throw new Error(`Bank provider "${parsed.data}" is not configured.`);
  }

  return parsed.data;
}

// ── GET /bank/config ──────────────────────────────────────────────────────────
export async function handleGetBankConfig(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const provider = resolveProvider(env, url.searchParams.get('provider'));
    return jsonOk({
      default_provider: getDefaultProvider(env),
      current_provider: provider,
      available_providers: getAvailableProviders(env),
      providers: {
        plaid: {
          configured: isPlaidConfigured(env),
          environment: env.PLAID_ENV,
          sandbox_shortcut: env.PLAID_ENV === 'sandbox',
        },
        teller: {
          configured: isTellerConfigured(env),
          environment: env.TELLER_ENV ?? 'sandbox',
          sandbox_shortcut: (env.TELLER_ENV ?? 'sandbox') === 'sandbox',
        },
      },
    });
  } catch (err) {
    return jsonError(String(err), 400);
  }
}

// ── POST /bank/connect/start ─────────────────────────────────────────────────
export async function handleStartBankConnect(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: { provider?: string } = {};
  try {
    body = await request.json() as { provider?: string };
  } catch {
    // Body is optional.
  }

  try {
    const provider = resolveProvider(env, body.provider);
    if (provider === 'plaid') {
      const result = await createPlaidLinkTokenForUser(env, userId);
      return jsonOk({
        provider,
        environment: env.PLAID_ENV,
        ...result,
      });
    }

    return jsonOk(getTellerBankConfig(env));
  } catch (err) {
    return jsonError(String(err), 400);
  }
}

// ── POST /bank/connect/complete ──────────────────────────────────────────────
export async function handleCompleteBankConnect(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON');
  }

  try {
    const provider = resolveProvider(env, typeof body.provider === 'string' ? body.provider : null);

    if (provider === 'plaid') {
      const publicToken = z.string().min(1).parse(body.public_token);
      const result = await exchangePlaidPublicTokenForUser(env, userId, publicToken);
      return jsonOk({ provider, ...result }, 201);
    }

    const nestedEnrollment = typeof body.enrollment === 'object' && body.enrollment
      ? body.enrollment as Record<string, unknown>
      : null;
    const nestedInstitution = typeof nestedEnrollment?.institution === 'object' && nestedEnrollment?.institution
      ? nestedEnrollment.institution as Record<string, unknown>
      : null;

    const accessToken = z.string().min(1).parse(
      body.access_token ?? body.accessToken,
    );
    const enrollmentId = z.string().min(1).parse(
      body.enrollment_id ?? body.enrollmentId ?? nestedEnrollment?.id,
    );
    const institutionNameValue =
      body.institution_name ?? body.institutionName ?? nestedInstitution?.name ?? null;
    const institutionIdValue =
      body.institution_id ?? body.institutionId ?? nestedInstitution?.id ?? null;
    const institutionName = institutionNameValue == null ? null : z.string().parse(institutionNameValue);
    const institutionId = institutionIdValue == null ? null : z.string().parse(institutionIdValue);

    const result = await connectTellerEnrollmentForUser(env, userId, {
      access_token: accessToken,
      enrollment_id: enrollmentId,
      institution_name: institutionName,
      institution_id: institutionId,
    });
    return jsonOk({ provider, ...result }, 201);
  } catch (err) {
    console.error('Bank connect complete failed', {
      userId,
      body,
      error: String(err),
    });
    return jsonError(String(err), 400);
  }
}

// ── POST /bank/sync ───────────────────────────────────────────────────────────
export async function handleBankSync(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Body is optional.
  }

  const parsed = SyncSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  try {
    const provider = resolveProvider(env, parsed.data.provider);
    const workflow = await getActiveTaxYearOrThrow(env, userId);
    const { dateFrom, dateTo } = getTaxYearDateRange(workflow.tax_year);

    const result = provider === 'plaid'
      ? await syncPlaidTransactionsForUser(env, userId, dateFrom, dateTo)
      : await syncTellerTransactionsForUser(env, userId, dateFrom, dateTo, parsed.data.account_ids);

    await reconcileChecklistAccountLinks(env, userId, workflow.id);
    await markChecklistItemsCompleteForAccounts(
      env,
      userId,
      workflow.id,
      result.account_ids_synced ?? [],
    );

    return jsonOk({ provider, ...result });
  } catch (err) {
    return jsonError(String(err), 400);
  }
}
