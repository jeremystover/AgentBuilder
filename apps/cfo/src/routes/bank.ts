/**
 * Bank-connect dispatch. Post-migration this is Teller-only — Plaid was
 * dropped when the agent moved into the AgentBuilder monorepo. The
 * dispatch layer is kept (rather than collapsing straight into teller.ts)
 * because the front-end still speaks the bank/* API and reworking it is
 * out of scope for this migration.
 */

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
  connectTellerEnrollmentForUser,
  getTellerBankConfig,
  syncTellerTransactionsForUser,
} from './teller';

const ProviderSchema = z.enum(['teller']);
const SyncSchema = z.object({
  provider: ProviderSchema.optional(),
  account_ids: z.array(z.string().min(1)).min(1).optional(),
});

function isTellerConfigured(env: Env): boolean {
  return Boolean(env.TELLER_APPLICATION_ID);
}

function getAvailableProviders(env: Env): BankProvider[] {
  const providers: BankProvider[] = [];
  if (isTellerConfigured(env)) providers.push('teller');
  return providers;
}

function getDefaultProvider(_env: Env): BankProvider {
  return 'teller';
}

function resolveProvider(env: Env, requested?: string | null): BankProvider {
  const provider = requested ?? getDefaultProvider(env);
  const parsed = ProviderSchema.safeParse(provider);
  if (!parsed.success) {
    throw new Error(`Unsupported bank provider "${requested ?? ''}". Only "teller" is supported post-migration.`);
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
  // Body is optional, we don't currently need anything from it.
  try {
    await request.json();
  } catch {
    // No body is fine.
  }

  try {
    resolveProvider(env, 'teller');
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

    const result = await syncTellerTransactionsForUser(
      env,
      userId,
      dateFrom,
      dateTo,
      parsed.data.account_ids,
    );

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
