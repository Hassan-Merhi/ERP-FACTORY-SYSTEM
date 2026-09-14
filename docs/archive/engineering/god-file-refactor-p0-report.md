# God-File Refactor — P0 Traceability Report

Date: 2026-09-12 · Branch: `arena/01a094de-erp-factory-system` · PR: #1422

This report covers the **P0 tranche** of the god-file cleanup: the three
largest, most entangled entry files in the codebase. P1, P2, and the
repository-wide re-scan are intentionally out of scope for this PR and are
listed at the end as remaining work.

## Per-file traceability

### 1. `server/chatService.ts` — 777 → 301 lines

| | |
|---|---|
| **Original size** | 777 lines |
| **Final size** | 301 lines (orchestration only) |
| **Responsibilities found** | chat pipeline orchestration and intent branching; code_read/code_edit prompt assembly and AI patch parsing; verify-container draft detection + container/supplier/proforma DB lookup; Phase 1 data-query classification (giant keyword regex) and execution; PO text extraction; error shaping (API-key/quota/catch-all); `getConfiguredProviders()`; re-export barrel for persistence/erpContext |
| **Extracted modules** | `server/chat/codeAgentContext.ts` (276) — code prompts + patch parsing · `server/chat/verifyContainerDraft.ts` (92) — verify-container lookup · `server/chat/phase1Classifier.ts` (161) — pure keyword/date/classifier-prompt logic · `server/chat/phase1DataQuery.ts` (71) — classified data-query runner · `server/chat/poTextExtraction.ts` (77) — PO extraction; `getConfiguredProviders` moved into `server/chat/aiProviders.ts` |
| **Public surface** | Unchanged: `chat`, `getConfiguredProviders`, `extractPOFromText`, persistence re-exports (`saveMessage`, `getConversationHistory`, `getConversationHistoryForAI`, `getAllChatHistory`, `saveFeedback`), `getERPContext`/`clearERPContextCache` |
| **Tests added** | `tests/chat-codeedit-response-parsing.test.ts` (single/multi-file patch JSON, stale-guard fallback, prose fallthrough) · `tests/chat-phase1-classifier.test.ts` (keyword matcher, date context, classifier prompt) |
| **Behavioral verification** | `chat()` flow order, early hard-return for deterministic multi-source stock transfers, skip conditions, log messages, and error shaping verified line-by-line against the original; `tests/chat-multi-source-stock-transfer.test.ts` keeps importing `chat` from the same path |

### 2. `server/index.ts` — 874 → 276 lines

| | |
|---|---|
| **Original size** | 874 lines |
| **Final size** | 276 lines (composition only) |
| **Responsibilities found** | middleware stack composition (compression, helmet/CSP, session + PG store, body limits, trust proxy, Capacitor CORS, no-ETag, view-only write blocking, build-version header, request logging, bandwidth debug, API no-cache, slow-API logging, rate limit, origin guard, CSRF, CSP reports); request/session TypeScript module augmentations; boot/build-info endpoints; final error handler; dev Vite vs production static serving + SPA fallback; listen with EADDRINUSE retry + graceful shutdown; startup sequence (warmup → always-on DDL → migrations → listen); always-running schema repairs (exchange-rates index, multi-currency columns, fiscal/factory tables); post-startup background jobs |
| **Extracted modules** | `server/startup/sessionMiddleware.ts` (77) · `server/startup/ensureRuntimeSchema.ts` (208) · `server/startup/postStartupJobs.ts` (125) · `server/startup/staticServing.ts` (53) · `server/startup/listenWithRetry.ts` (63) · `server/middleware/capacitorCors.ts` (36) · `server/middleware/httpConventions.ts` (45) · `server/middleware/errorHandler.ts` (52) · `server/security/csrfProtection.ts` (56) · `server/types/expressRequestSession.d.ts` (50) |
| **Tests added** | `tests/server-http-middleware-extractions.test.ts` — CORS header/preflight behavior, build-version/no-cache headers, CSRF token issuance/enforce/warn-only flows, error handler 400/503 mapping |
| **Behavioral verification** | Middleware registration order verified identical to the original (programmatic extraction of both files' `app.use`/registration sequences). Startup SQL statements and post-startup job bodies extracted verbatim (whitespace-insensitive diff confirms no semantic change). Timings (30 s / 3 s / 90 s, 30-min interval), env flags (`CSRF_ENFORCE`, `RUN_STARTUP_MIGRATIONS`, `ENABLE_SCHEDULERS`), and the migrations-before-listen gate preserved. |

### 3. `client/src/pages/Agents.tsx` — 892 → 196 lines

| | |
|---|---|
| **Original size** | 892 lines |
| **Final size** | 196 lines (composition only) |
| **Responsibilities found** | accounts + agent-accounts queries with envelope normalization; transactions and pre-period-balance queries; voucher grouping; opening/running/closing balance math with supplier Cr/Dr sign rules; add/remove agent mutations with toast + cache invalidation; Excel export builder (FX-note row, opening row); print via react-to-print; three UI panels (agent list, statement, add dialog) |
| **Extracted modules** | `client/src/pages/agents/useAgentLedger.ts` (135) — all queries/mutations · `agentStatementMath.ts` (134) — pure calculations · `agentStatementExcel.ts` (59) — export · `AgentListPanel.tsx` (152), `AgentStatementPanel.tsx` (378), `AddAgentDialog.tsx` (99) — presentation |
| **Tests added** | `agentStatementMath.test.ts` (grouping, opening/running/closing balances, Dr/Cr labels) · `agentStatementExcel.test.ts` (row shapes incl. FX-note row) |
| **Behavioral verification** | All `data-testid`s, query keys, toast messages, and sign conventions preserved; existing suites (`wave-h-populated-core-pages`, `renders-uncovered-pages`) pass. Mobile-responsive contract anchors (`tests/ui/mobile-responsive-phase1-critical-flows.test.ts`, `scripts/verify-mobile-responsive-phase1-critical-flows.mjs`) repointed to the new panel modules with the same assertions. |

## Gates executed (all passing)

| Gate | Result |
|---|---|
| `npm run check` (tsc --noEmit) | ✅ |
| `npm run lint` (3292 files) | ✅ 0 errors / 0 warnings |
| `npm run test:frontend` | ✅ 159 files / 1007 tests |
| `npm run build` (vite + server bundle + runtime checks) | ✅ |
| `npm run audit:god-files` | ✅ (all three files now far under softMaxLines) |
| `npm run audit:type-escapes` | ✅ 0 escapes |
| `npm run audit:doc-index` | ✅ |
| `npm run audit:write-routes` / `audit:write-evidence` | ✅ |
| `npm run audit:toolchain` / `audit:scripts` | ✅ |
| `verify:env-docs`, readable-logging phase 10 | ✅ |
| `vitest.config.i18n-contracts` suite | ✅ 13 tests |
| New DB-free backend tests (36 tests) | ✅ locally |
| Backend / Database Tests | ⏳ CI (Postgres service job — cannot run locally without a DB) |

## i18n baseline re-review (required by CI)

The decomposition surfaced **three pre-existing user-facing strings** that the
i18n scanner could never see before, because of scanner blind spots in the old
files (`/api/*` inside a line comment in `server/index.ts`; `/*` inside a regex
literal in `Agents.tsx`). No new untranslated UI text was added. Following the
audit's documented re-review process, `config/i18n-phase14-baseline.json` was
updated: `backend-messages` 0→2, `other-client` 0→1, with the re-review
justification recorded in the baseline description and commit message.

## Remaining god-file candidates (out of scope — follow-up PR)

- **P1**: `Suppliers.tsx`, `SalesReportDetail.tsx`, `VoucherEditDialog.tsx`, `FactoryInvoices.tsx`, `FactoryProformas.tsx`, `WasteDispatchOptimized.tsx`, `OffloadDialog.tsx`, `StockAdjustmentFormView.tsx`
- **P2**: `POS.tsx`, `services/export-data/fetch.ts`, `services/export-excel/workbook.ts`
- **Repository-wide scan** for any further unjustified god files.
