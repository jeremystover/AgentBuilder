/**
 * Bank-connect dispatch. Supports Teller (production bank sync) and Plaid
 * (Venmo, Patelco, Northwestern Mutual, EastRise CU). Provider is selected
 * by passing `provider` in the request body / query string; defaults to
 * Teller if both are configured.
 */

import { z } from 'zod';
import type { BankProvider, Env } from '../types';
import { getUserId, jsonError, jsonOk } from '../types';
import { isPlaidConfigured, PLAID_INSTITUTIONS } from '../lib/plaid';
import {
  connectTellerEnrollmentForUser,
  getTellerBankConfig,
  syncTellerTransactionsForUser,
} from './teller';
import {
  startPlaidConnect,
  connectPlaidItemForUser,
  syncPlaidTransactionsForUser,
  type PlaidConnectPayload,
} from './plaid';

const ProviderSchema = z.enum(['teller', 'plaid']);
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
  if (isPlaidConfigured(env)) providers.push('plaid');
  return providers;
}

function getDefaultProvider(env: Env): BankProvider {
  if (isTellerConfigured(env)) return 'teller';
  if (isPlaidConfigured(env)) return 'plaid';
  return 'teller';
}

function resolveProvider(env: Env, requested?: string | null): BankProvider {
  const provider = requested ?? getDefaultProvider(env);
  const parsed = ProviderSchema.safeParse(provider);
  if (!parsed.success) {
    throw new Error(`Unsupported bank provider "${requested ?? ''}". Supported: teller, plaid.`);
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
        plaid: {
          configured: isPlaidConfigured(env),
          environment: env.PLAID_ENV ?? 'sandbox',
          institutions: PLAID_INSTITUTIONS,
        },
      },
    });
  } catch (err) {
    return jsonError(String(err), 400);
  }
}

// ── POST /bank/connect/start ──────────────────────────────────────────────────
export async function handleStartBankConnect(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    // No body is fine.
  }

  const requestedProvider = typeof body.provider === 'string' ? body.provider : null;
  const institutionKey = typeof body.institution_key === 'string' ? body.institution_key : undefined;

  try {
    const provider = resolveProvider(env, requestedProvider);
    if (provider === 'plaid') {
      return jsonOk(await startPlaidConnect(env, userId, institutionKey));
    }
    return jsonOk(getTellerBankConfig(env));
  } catch (err) {
    return jsonError(String(err), 400);
  }
}

// ── POST /bank/connect/complete ───────────────────────────────────────────────
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
      const payload: PlaidConnectPayload = {
        public_token: z.string().min(1).parse(body.public_token),
        institution_key: z.string().min(1).parse(body.institution_key),
        institution_name: typeof body.institution_name === 'string' ? body.institution_name : null,
        plaid_institution_id: typeof body.plaid_institution_id === 'string' ? body.plaid_institution_id : null,
      };
      const result = await connectPlaidItemForUser(env, userId, payload);
      return jsonOk({ provider, ...result }, 201);
    }

    // Teller path (unchanged)
    const nestedEnrollment = typeof body.enrollment === 'object' && body.enrollment
      ? body.enrollment as Record<string, unknown>
      : null;
    const nestedInstitution = typeof nestedEnrollment?.institution === 'object' && nestedEnrollment?.institution
      ? nestedEnrollment.institution as Record<string, unknown>
      : null;

    const accessToken = z.string().min(1).parse(body.access_token ?? body.accessToken);
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
    console.error('Bank connect complete failed', { userId, body, error: String(err) });
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
    if (provider === 'plaid') {
      const result = await syncPlaidTransactionsForUser(env, userId, parsed.data.account_ids);
      return jsonOk({ provider, ...result });
    }
    const result = await syncTellerTransactionsForUser(
      env,
      userId,
      null,
      null,
      parsed.data.account_ids,
    );
    return jsonOk({ provider, ...result });
  } catch (err) {
    return jsonError(String(err), 400);
  }
}
