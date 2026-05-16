/**
 * CFO worker entrypoint.
 *
 * Surfaces:
 *   - GET    /health                            db + email sync health
 *   - GET    /login                             login form
 *   - POST   /login                             create cookie session
 *   - GET    /logout                            destroy session, redirect
 *   - GET    /api/web/snapshot                  dashboard counters
 *   - GET    /api/web/entities                  entity dropdown
 *   - GET    /api/web/categories                category dropdown
 *   - GET    /api/web/accounts                  gather accounts list
 *   - PUT    /api/web/accounts/:id              update account entity/active
 *   - GET    /api/web/review                    review queue (filtered/paged)
 *   - GET    /api/web/review/:id                review row detail
 *   - PUT    /api/web/review/:id                edit fields on a review row
 *   - POST   /api/web/review/:id/approve        promote raw → transactions
 *   - POST   /api/web/review/:id/advance        promote waiting → staged
 *   - POST   /api/web/review/bulk               bulk action over ids/filter
 *   - GET    /api/web/transactions              approved transactions
 *   - PUT    /api/web/transactions/:id          edit / re-open
 *   - GET    /api/web/rules                     rules list
 *   - POST   /api/web/rules                     create rule
 *   - GET    /api/web/gather/status             sync health for Gather page
 *   - POST   /api/web/gather/sync/:source       manual sync trigger
 *   - GET    /api/web/review/status              queue counts (also a tool)
 *   - GET    /api/web/review/next                interview-mode next row
 *   - GET    /api/web/transactions/summary       entity/category rollup
 *   - POST   /api/web/chat                       SSE streaming chat (10 tools)
 *   - GET    /api/web/spending/report            run a spending report
 *   - GET    /api/web/spending/views             list saved spending views
 *   - POST   /api/web/spending/views             save a spending view
 *   - PUT    /api/web/spending/views/:id         update a spending view
 *   - DELETE /api/web/spending/views/:id         delete a spending view
 *   - GET    /api/web/spending/groups            list category groups
 *   - POST   /api/web/spending/groups            create a category group
 *   - PUT    /api/web/spending/groups/:id        update a category group
 *   - DELETE /api/web/spending/groups/:id        delete a category group
 *   - GET    /api/web/spending/plans             list selectable plans
 *   - GET    /api/web/plans/active               get the active plan id
 *   - PUT    /api/web/plans/active               set the active plan id
 *   - GET    /api/web/reports/configs            list saved report configs
 *   - POST   /api/web/reports/configs            create config
 *   - PUT    /api/web/reports/configs/:id        update config
 *   - GET    /api/web/reports/configs/:id/runs   run history for config
 *   - POST   /api/web/reports/configs/:id/generate
 *                                               generate report → Drive link
 *   - GET    /api/web/reports/runs/:id           single run detail
 *   - POST   /mcp                                JSON-RPC 2.0 (Bearer MCP_HTTP_KEY)
 *   - POST   /teller/enroll, GET /teller/accounts, POST /teller/sync,
 *     DELETE /teller/enrollments/:id            external Teller surface
 *   - GET    /gmail/status, POST /gmail/sync, POST /gmail/sync/:vendor
 *                                               external Gmail surface
 *   - GET   any unmatched (cookie-gated)        SPA shell from ASSETS
 *
 * Scheduled:
 *   - "0 9 * * *"  → nightly Teller sync + email enrichment + auto-classify
 *                    (runs at ~05:00 ET).
 */

import { runCron, withObservability, handleClientError, logRequestError } from '@agentbuilder/observability';
import type { Env } from './types';
import { jsonError } from './types';

import { db } from './lib/db';
import { handleHealth } from './routes/health';
import {
  handleTellerEnroll, handleTellerListAccounts, handleTellerSync,
  handleTellerDeleteEnrollment, runTellerSync,
} from './routes/teller';
import { handleGmailSyncAll, handleGmailSyncVendor, handleGmailStatus } from './routes/gmail';
import { handleOAuthStart, handleOAuthCallback } from './routes/oauth';
import { runEmailSync } from './lib/email-sync';
import { runEmailDiscovery } from './lib/email-discovery';

import { handleSnapshot } from './routes/web-snapshot';
import {
  handleListEntities, handleListCategories, handleListAccounts, handleUpdateAccount,
} from './routes/web-lookups';
import {
  handleListReview, handleGetReview, handleUpdateReview,
  handleApproveReview, handleBulkReview, handleAdvanceWaiting,
  handleReviewNext, handleReviewStatus,
} from './routes/web-review';
import { handleListTransactions, handleUpdateTransaction, handleTransactionsSummary } from './routes/web-transactions';
import { handleListRules, handleCreateRule } from './routes/web-rules';
import { handleGatherStatus, handleGatherSync, handleGatherSyncStream } from './routes/web-gather';
import {
  handleListReportConfigs, handleCreateReportConfig, handleUpdateReportConfig,
  handleListReportRuns, handleGetReportRun, handleGenerateReport,
} from './routes/reports';
import {
  handleSpendingReport, handleListViews, handleCreateView, handleUpdateView, handleDeleteView,
  handleListGroups, handleCreateGroup, handleUpdateGroup, handleDeleteGroup,
  handleListPlans as handleListPlansForSpending, handleGetActivePlan, handleSetActivePlan,
} from './routes/spending';
import {
  handleListPlans, handleCreatePlan, handleGetPlan, handleUpdatePlan, handleArchivePlan,
  handleDuplicatePlan, handleExtendPlan, handleSetActivePlanV2,
  handleResolvePlan, handleForecastPlan,
  handleListPlanCategories, handleUpsertPlanCategory, handleSuggestPlanCategory, handleSuggestAllPlanCategories,
  handleListOneTimeItems, handleCreateOneTimeItem, handleUpdateOneTimeItem, handleDeleteOneTimeItem,
} from './routes/planning';
import {
  handleListProfiles, handleUpdateProfile,
  handleGetStateTimeline, handlePutStateTimeline,
  handleListTaxBrackets, handleUpsertTaxBracket,
  handleListDeductions, handlePutDeductions,
} from './routes/tax-config';
import {
  handleListScenarioAccounts, handleCreateScenarioAccount, handleGetScenarioAccount,
  handleUpdateScenarioAccount, handleArchiveScenarioAccount,
  handleGetRateSchedule, handleReplaceRateSchedule,
  handleListBalanceHistory, handleCreateBalanceEntry, handleUpdateBalanceEntry, handleDeleteBalanceEntry,
  handleRateComparison,
  handleListScenarios, handleCreateScenario, handleGetScenario, handleUpdateScenario, handleDeleteScenario,
  handleRunScenario, handleScenarioStatus, handleGetSnapshot,
  handleSaleProceeds, handleAcceptRothProposal,
  runAndSaveProjection, type ScenarioJobMessage,
} from './routes/scenarios';
import { handleMcp, type JsonRpcMessage } from './mcp-tools';
import {
  handleExtensionListAccounts, handleExtensionAnalyzePage,
  handleUploadCheckImage, handleListCheckImages, handleGetCheckImage, handleGetCheckImageContent,
} from './routes/extension-checks';
import { processCheckImage, type CheckQueueMessage } from './lib/check-vision';
import { handleWebChat } from './web-chat';
import { runClassify } from './lib/classify';

import {
  createSession, destroySession, requireWebSession, requireApiAuth,
  setSessionCookieHeader, clearSessionCookieHeader, verifyPassword, loginHtml,
} from './lib/sessions';

type Handler = (req: Request, env: Env, ...params: string[]) => Promise<Response>;
interface Route { method: string; pattern: RegExp; handler: Handler; auth: 'public' | 'cookie' | 'api' }

const ROUTES: Route[] = [
  // Public ops surfaces (Teller webhook-style + health).
  { method: 'GET',    pattern: /^\/health$/,                            auth: 'public', handler: (req, env) => handleHealth(req, env) },
  { method: 'POST',   pattern: /^\/api\/v1\/client-error$/,             auth: 'public', handler: (req, env) => handleClientError(req, env, 'cfo') },
  { method: 'POST',   pattern: /^\/teller\/enroll$/,                    auth: 'public', handler: (req, env) => handleTellerEnroll(req, env) },
  { method: 'GET',    pattern: /^\/teller\/accounts$/,                  auth: 'public', handler: (req, env) => handleTellerListAccounts(req, env) },
  { method: 'POST',   pattern: /^\/teller\/sync$/,                      auth: 'public', handler: (req, env) => handleTellerSync(req, env) },
  { method: 'DELETE', pattern: /^\/teller\/enrollments\/([^/]+)$/,      auth: 'public', handler: (req, env, id) => handleTellerDeleteEnrollment(req, env, id!) },
  { method: 'GET',    pattern: /^\/oauth\/google\/start$/,              auth: 'public', handler: (req, env) => handleOAuthStart(req, env) },
  { method: 'GET',    pattern: /^\/oauth\/google\/callback$/,           auth: 'public', handler: (req, env) => handleOAuthCallback(req, env) },
  { method: 'GET',    pattern: /^\/gmail\/status$/,                     auth: 'public', handler: (req, env) => handleGmailStatus(req, env) },
  { method: 'POST',   pattern: /^\/gmail\/sync$/,                       auth: 'public', handler: (req, env) => handleGmailSyncAll(req, env) },
  { method: 'POST',   pattern: /^\/gmail\/sync\/([^/]+)$/,              auth: 'public', handler: (req, env, vendor) => handleGmailSyncVendor(req, env, vendor!) },

  // SPA-facing API (cookie or bearer)
  { method: 'GET',    pattern: /^\/api\/web\/snapshot$/,                auth: 'api',    handler: (req, env) => handleSnapshot(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/entities$/,                auth: 'api',    handler: (req, env) => handleListEntities(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/categories$/,              auth: 'api',    handler: (req, env) => handleListCategories(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/accounts$/,                auth: 'api',    handler: (req, env) => handleListAccounts(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/accounts\/([^/]+)$/,       auth: 'api',    handler: (req, env, id) => handleUpdateAccount(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/review$/,                  auth: 'api',    handler: (req, env) => handleListReview(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/status$/,          auth: 'api',    handler: (req, env) => handleReviewStatus(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/next$/,            auth: 'api',    handler: (req, env) => handleReviewNext(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/review\/bulk$/,            auth: 'api',    handler: (req, env) => handleBulkReview(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/([^/]+)$/,         auth: 'api',    handler: (req, env, id) => handleGetReview(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/review\/([^/]+)$/,         auth: 'api',    handler: (req, env, id) => handleUpdateReview(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/review\/([^/]+)\/approve$/,auth: 'api',    handler: (req, env, id) => handleApproveReview(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/review\/([^/]+)\/advance$/,auth: 'api',    handler: (req, env, id) => handleAdvanceWaiting(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/transactions$/,            auth: 'api',    handler: (req, env) => handleListTransactions(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/transactions\/summary$/,   auth: 'api',    handler: (req, env) => handleTransactionsSummary(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/transactions\/([^/]+)$/,   auth: 'api',    handler: (req, env, id) => handleUpdateTransaction(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/chat$/,                    auth: 'api',    handler: (req, env) => handleWebChat(req, env) },

  // Reporting
  { method: 'GET',    pattern: /^\/api\/web\/reports\/configs$/,                       auth: 'api', handler: (req, env) => handleListReportConfigs(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/reports\/configs$/,                       auth: 'api', handler: (req, env) => handleCreateReportConfig(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/reports\/configs\/([^/]+)$/,              auth: 'api', handler: (req, env, id) => handleUpdateReportConfig(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/reports\/configs\/([^/]+)\/runs$/,        auth: 'api', handler: (req, env, id) => handleListReportRuns(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/reports\/configs\/([^/]+)\/generate$/,    auth: 'api', handler: (req, env, id) => handleGenerateReport(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/reports\/runs\/([^/]+)$/,                 auth: 'api', handler: (req, env, id) => handleGetReportRun(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/rules$/,                   auth: 'api',    handler: (req, env) => handleListRules(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/rules$/,                   auth: 'api',    handler: (req, env) => handleCreateRule(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/gather\/status$/,          auth: 'api',    handler: (req, env) => handleGatherStatus(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/gather\/sync-stream\/(.+)$/, auth: 'api',  handler: async (req, env, source) => handleGatherSyncStream(req, env, source!) },
  // NOTE: gather sync POST is handled separately in fetch() below to get ctx for waitUntil

  // Spending (Module 4)
  { method: 'GET',    pattern: /^\/api\/web\/spending\/report$/,             auth: 'api', handler: (req, env) => handleSpendingReport(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/spending\/views$/,              auth: 'api', handler: (req, env) => handleListViews(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/spending\/views$/,              auth: 'api', handler: (req, env) => handleCreateView(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/spending\/views\/([^/]+)$/,     auth: 'api', handler: (req, env, id) => handleUpdateView(req, env, id!) },
  { method: 'DELETE', pattern: /^\/api\/web\/spending\/views\/([^/]+)$/,     auth: 'api', handler: (req, env, id) => handleDeleteView(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/spending\/groups$/,             auth: 'api', handler: (req, env) => handleListGroups(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/spending\/groups$/,             auth: 'api', handler: (req, env) => handleCreateGroup(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/spending\/groups\/([^/]+)$/,    auth: 'api', handler: (req, env, id) => handleUpdateGroup(req, env, id!) },
  { method: 'DELETE', pattern: /^\/api\/web\/spending\/groups\/([^/]+)$/,    auth: 'api', handler: (req, env, id) => handleDeleteGroup(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/spending\/plans$/,              auth: 'api', handler: (req, env) => handleListPlansForSpending(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/active$/,                auth: 'api', handler: (req, env) => handleGetActivePlan(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/plans\/active$/,                auth: 'api', handler: (req, env) => handleSetActivePlan(req, env) },

  // Planning (Module 3)
  { method: 'GET',    pattern: /^\/api\/web\/plans$/,                                              auth: 'api', handler: (req, env) => handleListPlans(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/plans$/,                                              auth: 'api', handler: (req, env) => handleCreatePlan(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)$/,                                     auth: 'api', handler: (req, env, id) => handleGetPlan(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/plans\/([^/]+)$/,                                     auth: 'api', handler: (req, env, id) => handleUpdatePlan(req, env, id!) },
  { method: 'DELETE', pattern: /^\/api\/web\/plans\/([^/]+)$/,                                     auth: 'api', handler: (req, env, id) => handleArchivePlan(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/plans\/([^/]+)\/duplicate$/,                          auth: 'api', handler: (req, env, id) => handleDuplicatePlan(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/plans\/([^/]+)\/extend$/,                             auth: 'api', handler: (req, env, id) => handleExtendPlan(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/plans\/([^/]+)\/set-active$/,                         auth: 'api', handler: (req, env, id) => handleSetActivePlanV2(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)\/resolve$/,                            auth: 'api', handler: (req, env, id) => handleResolvePlan(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)\/forecast$/,                           auth: 'api', handler: (req, env, id) => handleForecastPlan(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)\/categories$/,                         auth: 'api', handler: (req, env, id) => handleListPlanCategories(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/plans\/([^/]+)\/categories\/([^/]+)$/,                auth: 'api', handler: (req, env, id, cid) => handleUpsertPlanCategory(req, env, id!, cid!) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)\/categories\/suggest-all$/,            auth: 'api', handler: (req, env, id) => handleSuggestAllPlanCategories(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)\/categories\/([^/]+)\/suggest$/,       auth: 'api', handler: (req, env, id, cid) => handleSuggestPlanCategory(req, env, id!, cid!) },
  { method: 'GET',    pattern: /^\/api\/web\/plans\/([^/]+)\/one-time-items$/,                     auth: 'api', handler: (req, env, id) => handleListOneTimeItems(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/plans\/([^/]+)\/one-time-items$/,                     auth: 'api', handler: (req, env, id) => handleCreateOneTimeItem(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/plans\/([^/]+)\/one-time-items\/([^/]+)$/,            auth: 'api', handler: (req, env, id, iid) => handleUpdateOneTimeItem(req, env, id!, iid!) },
  { method: 'DELETE', pattern: /^\/api\/web\/plans\/([^/]+)\/one-time-items\/([^/]+)$/,            auth: 'api', handler: (req, env, id, iid) => handleDeleteOneTimeItem(req, env, id!, iid!) },

  // Scenarios (Module 5) — Phase 5: Account Setup + Historical View
  { method: 'GET',    pattern: /^\/api\/web\/scenario-accounts$/,                                          auth: 'api', handler: (req, env) => handleListScenarioAccounts(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/scenario-accounts$/,                                          auth: 'api', handler: (req, env) => handleCreateScenarioAccount(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)$/,                                 auth: 'api', handler: (req, env, id) => handleGetScenarioAccount(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)$/,                                 auth: 'api', handler: (req, env, id) => handleUpdateScenarioAccount(req, env, id!) },
  { method: 'DELETE', pattern: /^\/api\/web\/scenario-accounts\/([^/]+)$/,                                 auth: 'api', handler: (req, env, id) => handleArchiveScenarioAccount(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/rate-schedule$/,                  auth: 'api', handler: (req, env, id) => handleGetRateSchedule(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/rate-schedule$/,                  auth: 'api', handler: (req, env, id) => handleReplaceRateSchedule(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/balance-history$/,                auth: 'api', handler: (req, env, id) => handleListBalanceHistory(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/balance-history$/,                auth: 'api', handler: (req, env, id) => handleCreateBalanceEntry(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/balance-history\/([^/]+)$/,       auth: 'api', handler: (req, env, id, eid) => handleUpdateBalanceEntry(req, env, id!, eid!) },
  { method: 'DELETE', pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/balance-history\/([^/]+)$/,       auth: 'api', handler: (req, env, id, eid) => handleDeleteBalanceEntry(req, env, id!, eid!) },
  { method: 'GET',    pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/rate-comparison$/,                auth: 'api', handler: (req, env, id) => handleRateComparison(req, env, id!) },

  // Scenarios (Module 5) — Phase 6: scenario CRUD + async run + results
  { method: 'GET',    pattern: /^\/api\/web\/scenarios$/,                                                  auth: 'api', handler: (req, env) => handleListScenarios(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/scenarios$/,                                                  auth: 'api', handler: (req, env) => handleCreateScenario(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/scenarios\/([^/]+)$/,                                         auth: 'api', handler: (req, env, id) => handleGetScenario(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/scenarios\/([^/]+)$/,                                         auth: 'api', handler: (req, env, id) => handleUpdateScenario(req, env, id!) },
  { method: 'DELETE', pattern: /^\/api\/web\/scenarios\/([^/]+)$/,                                         auth: 'api', handler: (req, env, id) => handleDeleteScenario(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/scenarios\/([^/]+)\/run$/,                                    auth: 'api', handler: (req, env, id) => handleRunScenario(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/scenarios\/([^/]+)\/status$/,                                 auth: 'api', handler: (req, env, id) => handleScenarioStatus(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/scenarios\/([^/]+)\/snapshots\/([^/]+)$/,                     auth: 'api', handler: (req, env, id, sid) => handleGetSnapshot(req, env, id!, sid!) },
  { method: 'POST',   pattern: /^\/api\/web\/scenarios\/([^/]+)\/roth-proposals\/accept$/,                  auth: 'api', handler: (req, env, id) => handleAcceptRothProposal(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/scenario-accounts\/([^/]+)\/sale-calc$/,                       auth: 'api', handler: (req, env, id) => handleSaleProceeds(req, env, id!) },

  // Tax & profile configuration
  { method: 'GET',    pattern: /^\/api\/web\/profiles$/,                                                   auth: 'api', handler: (req, env) => handleListProfiles(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/profiles\/([^/]+)$/,                                          auth: 'api', handler: (req, env, id) => handleUpdateProfile(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/state-timeline$/,                                             auth: 'api', handler: (req, env) => handleGetStateTimeline(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/state-timeline$/,                                             auth: 'api', handler: (req, env) => handlePutStateTimeline(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/tax-brackets$/,                                               auth: 'api', handler: (req, env) => handleListTaxBrackets(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/tax-brackets$/,                                               auth: 'api', handler: (req, env) => handleUpsertTaxBracket(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/deductions$/,                                                 auth: 'api', handler: (req, env) => handleListDeductions(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/deductions$/,                                                 auth: 'api', handler: (req, env) => handlePutDeductions(req, env) },

  // Chrome extension surface (cookie or bearer)
  { method: 'GET',    pattern: /^\/api\/extension\/v1\/accounts$/,                                         auth: 'api', handler: (req, env) => handleExtensionListAccounts(req, env) },
  { method: 'POST',   pattern: /^\/api\/extension\/v1\/analyze-page$/,                                     auth: 'api', handler: (req, env) => handleExtensionAnalyzePage(req, env) },
  { method: 'POST',   pattern: /^\/api\/extension\/v1\/check-images$/,                                     auth: 'api', handler: (req, env) => handleUploadCheckImage(req, env) },
  { method: 'GET',    pattern: /^\/api\/extension\/v1\/check-images$/,                                     auth: 'api', handler: (req, env) => handleListCheckImages(req, env) },
  { method: 'GET',    pattern: /^\/api\/extension\/v1\/check-images\/([^/]+)$/,                            auth: 'api', handler: (req, env, id) => handleGetCheckImage(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/extension\/v1\/check-images\/([^/]+)\/image\/([^/]+)$/,            auth: 'api', handler: (req, env, id, side) => handleGetCheckImageContent(req, env, id!, side!) },

  // SPA-facing read of check images attached to a transaction (review drawer + transactions row)
  { method: 'GET',    pattern: /^\/api\/web\/transactions\/([^/]+)\/check-images$/,                        auth: 'api', handler: (req, env, id) => handleCheckImagesForTransaction(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/([^/]+)\/check-images$/,                              auth: 'api', handler: (req, env, id) => handleCheckImagesForRaw(req, env, id!) },
];

async function handleCheckImagesForTransaction(_req: Request, env: Env, transactionId: string): Promise<Response> {
  const sql = (await import('./lib/db')).db(env);
  try {
    const rows = await sql<Array<{
      id: string; check_number: string | null; extracted_payee: string | null;
      extracted_amount: string | null; extraction_confidence: string | null;
      status: string; has_back: boolean;
    }>>`
      SELECT id, check_number, extracted_payee, extracted_amount, extraction_confidence, status,
             (back_image_key IS NOT NULL) AS has_back
      FROM check_images WHERE matched_transaction_id = ${transactionId}
    `;
    return new Response(JSON.stringify({ check_images: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function handleCheckImagesForRaw(_req: Request, env: Env, rawId: string): Promise<Response> {
  const sql = (await import('./lib/db')).db(env);
  try {
    const rows = await sql<Array<{
      id: string; check_number: string | null; extracted_payee: string | null;
      extracted_amount: string | null; extraction_confidence: string | null;
      status: string; has_back: boolean;
    }>>`
      SELECT id, check_number, extracted_payee, extracted_amount, extraction_confidence, status,
             (back_image_key IS NOT NULL) AS has_back
      FROM check_images WHERE matched_raw_id = ${rawId}
    `;
    return new Response(JSON.stringify({ check_images: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

function requireMcpAuth(request: Request, env: Env): { ok: true } | { ok: false; response: Response } {
  const expected = env.MCP_HTTP_KEY ?? '';
  if (!expected) return { ok: true }; // dev only
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';
  if (token && token === expected) return { ok: true };
  return { ok: false, response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }) };
}

async function handleNightlySync(env: Env): Promise<void> {
  await runTellerSync(env);
  await runEmailSync(env);
  // Reverse enrichment: identify whatever known-vendor sync couldn't.
  await runEmailDiscovery(env).catch(err => console.warn('[cron] email discovery failed', err));
  // Auto-categorize anything newly staged before the user wakes up.
  await runClassify(env).catch(err => console.warn('[cron] classify failed', err));
}

const cfoWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Login / logout ────────────────────────────────────────────────────
    if (path === '/login' && method === 'GET') {
      return new Response(loginHtml(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/login' && method === 'POST') {
      if (!env.WEB_UI_PASSWORD) {
        return new Response(loginHtml({ error: 'WEB_UI_PASSWORD is not configured.' }), {
          status: 500, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const form = await request.formData().catch(() => null);
      const password = form?.get('password') ?? '';
      if (!verifyPassword(env, password)) {
        return new Response(loginHtml({ error: 'Wrong password.' }), {
          status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const { sessionId } = await createSession(env);
      const secure = url.protocol === 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': setSessionCookieHeader(sessionId, { secure }),
        },
      });
    }
    if (path === '/logout') {
      const session = await requireWebSession(request, env, { mode: 'page' });
      if (session.ok && session.sessionId) await destroySession(env, session.sessionId);
      const secure = url.protocol === 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          location: '/login',
          'set-cookie': clearSessionCookieHeader({ secure }),
        },
      });
    }

    // ── MCP JSON-RPC ─────────────────────────────────────────────────────
    if (path === '/mcp' && method === 'POST') {
      const auth = requireMcpAuth(request, env);
      if (!auth.ok) return auth.response;
      let msg: JsonRpcMessage;
      try {
        msg = await request.json() as JsonRpcMessage;
      } catch {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      try {
        const out = await handleMcp(msg, env);
        if (out === null) return new Response(null, { status: 204 });
        return Response.json(out);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message } });
      }
    }

    // ── Gather sync: needs ctx for waitUntil, so not in ROUTES table ────────
    const gatherSyncMatch = method === 'POST' && path.match(/^\/api\/web\/gather\/sync\/(.+)$/);
    if (gatherSyncMatch) {
      const auth = await requireApiAuth(request, env);
      if (!auth.ok) return auth.response;
      const response = handleGatherSync(request, env, ctx, gatherSyncMatch[1]!);
      response.headers.set('Access-Control-Allow-Origin', '*');
      return response;
    }

    // ── Match registered routes ───────────────────────────────────────────
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const match = path.match(route.pattern);
      if (!match) continue;

      if (route.auth === 'api') {
        const auth = await requireApiAuth(request, env);
        if (!auth.ok) return auth.response;
      }
      try {
        const params = match.slice(1).map(p => p ?? '');
        const response = await route.handler(request, env, ...params);
        response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
      } catch (err) {
        console.error(`Error in ${method} ${path}:`, err);
        ctx.waitUntil(logRequestError(env, 'cfo', 'request', err, { method, path }));
        return jsonError(`Internal server error: ${String(err)}`, 500);
      }
    }

    // ── SPA shell: cookie-gated, fall through to ASSETS ───────────────────
    if (method === 'GET') {
      const session = await requireWebSession(request, env, { mode: 'page' });
      if (!session.ok) return session.response;
      // Vite-built static assets land under /assets/* (hashed). Anything
      // else is the SPA shell.
      if (path.startsWith('/assets/')) return env.ASSETS.fetch(request);
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), request));
    }

    return jsonError('Not found', 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(
        runCron(
          env,
          { agentId: 'cfo', trigger: 'nightly-sync', cron: event.cron },
          () => handleNightlySync(env),
        ),
      );
      return;
    }
    if (event.cron === '*/4 * * * *') {
      ctx.waitUntil((async () => {
        const sql = db(env);
        try {
          await sql`SELECT 1`;
        } finally {
          await sql.end({ timeout: 5 });
        }
      })());
      return;
    }
    console.warn('[scheduled] unknown cron expression', event.cron);
  },

  // Cloudflare Queue consumer — dispatches by queue name. One queue per
  // job type, one binding per producer. SCENARIO_QUEUE -> scenario
  // projections; CHECK_QUEUE -> check-image vision/match.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === 'cfo-scenarios') {
      for (const message of batch.messages as Message<ScenarioJobMessage>[]) {
        try {
          await runAndSaveProjection(env, message.body);
          message.ack();
        } catch (err) {
          console.error('[queue] scenario job failed', err);
          message.ack();
        }
      }
      return;
    }
    if (batch.queue === 'cfo-check-images') {
      for (const message of batch.messages as Message<CheckQueueMessage>[]) {
        try {
          await processCheckImage(env, message.body);
          message.ack();
        } catch (err) {
          console.error('[queue] check-image job failed', err);
          // processCheckImage swallows its own errors; this catch is belt-and-suspenders.
          message.retry();
        }
      }
      return;
    }
    console.warn('[queue] unknown queue', batch.queue);
    for (const message of batch.messages) message.ack();
  },
} satisfies ExportedHandler<Env, ScenarioJobMessage>;

// Wrap fetch so any uncaught throw is recorded to fleet_errors in
// agentbuilder-core D1. scheduled/queue keep their own error handling.
export default {
  ...cfoWorker,
  fetch: withObservability('cfo', cfoWorker.fetch),
} satisfies ExportedHandler<Env, ScenarioJobMessage>;
