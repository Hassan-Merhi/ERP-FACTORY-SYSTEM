# Phase 1 — Type safety and environment inventory (main snapshot)

> Scope: audit and classification only. No production flags have been removed.

## Confirmed repository observations

- Root `.env.example`: **859 lines**, **227 assignment entries**, **217 distinct keys**. Entries include commented examples and duplicates.
- Existing gate: `scripts/audit-type-escapes.mjs` scans TypeScript AST with `config/type-escape-boundaries.json`; configured baseline is empty and ceiling is 0 in `server`, `client/src`, and `shared` (excluding declaration files). This does **not** certify all tracked TypeScript files or prove the current checkout passes.
- Existing env-doc gate: `scripts/verify-env-documentation.mjs` compares server-side `process.env.X` / `env.X` reads against four example files; it is not a full frontend, scripts or deployment consumer inventory.
- ESLint disables `@typescript-eslint/no-explicit-any` because the separate TypeScript AST gate exists.
- Full local checkout execution required for confirmed per-occurrence `any` inventory and all static environment consumers. New generator: `node scripts/audit-type-env-inventory.mjs` produces `artifacts/type-env-audit/inventory.json`.

## Root `.env.example` variable-by-variable preliminary review

Classifications are **triage labels**, not permission to delete. Deployment platform settings and dynamic references are not observable via static scans.

| Variable | Lines | Preliminary classification |
|---|---:|---|
| `AISSTREAM_API_KEY` | 306 | Preserve — active/uncertain |
| `AISSTREAM_DESTINATION_COORDINATES` | 310 | Preserve — active/uncertain |
| `API_PAGINATION_DEFAULT_LIMIT` | 492 | Preserve — active/uncertain |
| `API_PAGINATION_MAX_LIMIT` | 495 | Preserve — active/uncertain |
| `API_RATE_LIMIT_ANON_MAX` | 201 | Preserve — active/uncertain |
| `API_RATE_LIMIT_MAX` | 199 | Preserve — active/uncertain |
| `API_RATE_LIMIT_WINDOW_MS` | 203 | Preserve — active/uncertain |
| `BALE_SCAN_AUDIT_SCHEMA_MODE` | 825 | Rollout/cutover — verify before deletion |
| `BANDWIDTH_DEBUG` | 505 | Preserve — active/uncertain |
| `BANDWIDTH_DEBUG_API_WINDOW_BUDGET_MB` | 517 | Preserve — active/uncertain |
| `BANDWIDTH_DEBUG_ENDPOINT_WINDOW_BUDGET_MB` | 519 | Preserve — active/uncertain |
| `BANDWIDTH_DEBUG_REPORT_INTERVAL_MS` | 511 | Preserve — active/uncertain |
| `BANDWIDTH_DEBUG_STATIC_WINDOW_BUDGET_MB` | 518 | Preserve — active/uncertain |
| `BANDWIDTH_DEBUG_THRESHOLD_KB` | 508 | Preserve — active/uncertain |
| `BANDWIDTH_DEBUG_TOP_N` | 514 | Preserve — active/uncertain |
| `BUILD_VERSION` | 41 | Preserve — active/uncertain |
| `CAPACITOR_ENABLED` | 217 | Preserve — active/uncertain |
| `CLIENT_ERROR_DEDUPE_MS` | 358 | Preserve — active/uncertain |
| `CLIENT_ERROR_RATE_LIMIT` | 355 | Preserve — active/uncertain |
| `CMA_CGM_API_KEY` | 279 | Preserve — active/uncertain |
| `CMA_PUBLIC_TRACKING_ENABLED` | 302 | Preserve — active/uncertain |
| `COMPANY_SCOPE_RLS_MODE` | 826 | Rollout/cutover — verify before deletion |
| `CRITICAL_SECURITY_SCHEMA_MODE` | 827 | Rollout/cutover — verify before deletion |
| `CSRF_ALLOW_WARN_ONLY_IN_PRODUCTION` | 80, 191 | Preserve — active/uncertain |
| `CSRF_ENFORCE` | 188 | Preserve — active/uncertain |
| `DATABASE_STARTUP_SCHEMA_MODE` | 837 | Rollout/cutover — verify before deletion |
| `DATABASE_URL` | 21 | Preserve — active/uncertain |
| `DEBUG_HISTORICAL_INVENTORY` | 400 | Preserve — active/uncertain |
| `DISABLE_SCREEN_FEED` | 396 | Preserve — active/uncertain |
| `ENABLE_SCHEDULERS` | 93 | Preserve — active/uncertain |
| `ENDPOINT_QUEUE_MAX_DEPTH` | 430, 452 | Preserve — active/uncertain |
| `ENDPOINT_QUEUE_MAX_WAIT_MS` | 426, 456 | Preserve — active/uncertain |
| `ERP_CONTEXT_CACHE_MAX_ENTRIES` | 564 | Preserve — active/uncertain |
| `ERP_MERGE_HADI_ERP_RENT_EXPENSE_20261106` | 54, 646, 801 | One-time control — verify repair/audit |
| `ERP_RECONCILE_FACTORY_HISTORICAL_FX_20261014` | 634 | One-time control — verify repair/audit |
| `ERP_RECONCILE_FREIGHT_HISTORY_20261014` | 678 | One-time control — verify repair/audit |
| `ERP_RECONCILE_FX_DAYBOOK_20261014` | 670 | One-time control — verify repair/audit |
| `ERP_RECONCILE_INVOICES_20261014` | 624 | One-time control — verify repair/audit |
| `ERP_RECONCILE_SUPPLIER_FX_20261014` | 666 | One-time control — verify repair/audit |
| `ERP_RECONCILE_SUPPLIERS_20261014` | 629 | One-time control — verify repair/audit |
| `ERP_REPAIR_FACTORY_RENT_SAFE_20261109` | 85, 661 | Completed candidate — verify removal |
| `ERP_REPAIR_FREIGHT_PAYEES_20261014` | 682 | One-time control — verify repair/audit |
| `ERP_REPAIR_HADI_LSHI_PREPAID_OPENING_20261106` | 59, 651, 802 | One-time control — verify repair/audit |
| `ERP_REPAIR_HADI_PREPAID_20261103` | 641 | One-time control — verify repair/audit |
| `ERP_REPAIR_POST_OFFLOAD_LINKS_20261014` | 674 | One-time control — verify repair/audit |
| `ERP_REPAIR_SUPPLIER_PAYMENTS_20261014` | 662 | One-time control — verify repair/audit |
| `ERP_REWORK_POS_JNAH_VOUCHERS_20261109` | 89, 656 | Completed candidate — verify removal |
| `EXPORT_BRIDGE_FILE_MAX_AGE_MS` | 467 | Preserve — active/uncertain |
| `EXPORT_BRIDGE_TEMP_DIR` | 464 | Preserve — active/uncertain |
| `EXPORT_BUFFER_BRIDGE_DISABLED` | 461 | Preserve — active/uncertain |
| `EXPORT_CHUNK_BRIDGE_MIN_BYTES` | 470 | Preserve — active/uncertain |
| `EXPORT_JOB_MAX_ENTRIES` | 568 | Preserve — active/uncertain |
| `EXPORT_JOB_MAX_STEPS` | 572 | Preserve — active/uncertain |
| `EXPORT_TEMP_FILE_MAX_AGE_MS` | 448 | Preserve — active/uncertain |
| `EXTERNAL_DEPENDENCY_SLOW_MS` | 351 | Preserve — active/uncertain |
| `FACTORY_ABO_JABER_REASSIGN_20261015` | 696 | One-time control — verify repair/audit |
| `FACTORY_ABO_SOBHI_GOODS82_20261015` | 695 | One-time control — verify repair/audit |
| `FACTORY_BILINGUAL_SCHEMA_MODE` | 828 | Rollout/cutover — verify before deletion |
| `FACTORY_CLOUD_FENCE_ACK` | 712 | Preserve — active/uncertain |
| `FACTORY_CLOUD_WRITE_MODE` | 711 | Preserve — active/uncertain |
| `FACTORY_CLOUD_WRITER_EPOCH` | 715 | Rollout/cutover — verify before deletion |
| `FACTORY_CONTAINER_SCHEMA_MODE` | 829 | Preserve — active/uncertain |
| `FACTORY_EDGE_APPROVED_PLAN_BATCHES` | 729 | Preserve — active/uncertain |
| `FACTORY_EDGE_BASELINE_SHA256` | 725 | Preserve — active/uncertain |
| `FACTORY_EDGE_HOSTNAME` | 719 | Preserve — active/uncertain |
| `FACTORY_EDGE_MODE` | 717 | Rollout/cutover — verify before deletion |
| `FACTORY_EDGE_PRIMARY_ACK` | 721 | Preserve — active/uncertain |
| `FACTORY_EDGE_SITE_ID` | 718 | Rollout/cutover — verify before deletion |
| `FACTORY_EDGE_WRITE_MODE` | 720 | Preserve — active/uncertain |
| `FACTORY_EDGE_WRITER_EPOCH` | 724 | Preserve — active/uncertain |
| `FACTORY_IMPORT_PAYABLE_UNDO_20261015` | 689 | One-time control — verify repair/audit |
| `FACTORY_MIX_INTEGRITY_MONITOR_ENABLED` | 100 | Preserve — active/uncertain |
| `FACTORY_MULTILINGUAL_SCHEMA_MODE` | 830 | Preserve — active/uncertain |
| `FACTORY_OFFLINE_SCHEMA_INSTALL_ACK` | 766 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE8_APPLY_ACK` | 752 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE8_APPLY_ENABLED` | 751 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE8_BASELINE_SHA256` | 753 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE8_COMPANY_ID` | 754 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE8_RECEIPTS_ENABLED` | 747 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE9_APPLY_ENABLED` | 763 | Rollout/cutover — verify before deletion |
| `FACTORY_PHASE9_RECEIPTS_ENABLED` | 759 | Rollout/cutover — verify before deletion |
| `FACTORY_SYNC_HMAC_KEY` | 743 | Preserve — active/uncertain |
| `FACTORY_SYNC_RECEIVE_ENABLED` | 741 | Preserve — active/uncertain |
| `FACTORY_SYNC_SITE_ID` | 742 | Preserve — active/uncertain |
| `FACTORY_UK_BASMA_REPAIR_20261015` | 697 | One-time control — verify repair/audit |
| `FIXED_PRODUCTION_PLANNER_SCHEMA_MODE` | 831 | Preserve — active/uncertain |
| `GEMINI_API_KEY` | 265 | Preserve — active/uncertain |
| `GIT_COMMIT` | 704 | Preserve — active/uncertain |
| `GIT_IMPORT_UNDO_MAX_ENTRIES` | 576 | Preserve — active/uncertain |
| `GITHUB_REPO_URL` | 527 | Preserve — active/uncertain |
| `GITHUB_TOKEN` | 528 | Preserve — active/uncertain |
| `GREEN_API_POS_API_URL` | 857 | Preserve — active/uncertain |
| `GREEN_API_POS_INSTANCE_ID` | 856 | Preserve — active/uncertain |
| `GREEN_API_POS_MEDIA_URL` | 858 | Preserve — active/uncertain |
| `HEAVY_EXPORT_MAX_CONCURRENT` | 438 | Preserve — active/uncertain |
| `HEAVY_EXPORT_MAX_QUEUE` | 441 | Preserve — active/uncertain |
| `HEAVY_EXPORT_WAIT_TIMEOUT_MS` | 444 | Preserve — active/uncertain |
| `HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH` | 67 | One-time control — verify repair/audit |
| `HISTORICAL_SALES_COST_REPAIR_COMPANY_IDS` | 65 | One-time control — verify repair/audit |
| `HISTORICAL_SALES_COST_REPAIR_MODE` | 64 | One-time control — verify repair/audit |
| `HISTORICAL_SALES_COST_REPAIR_PARTIAL_CONFIRMATION` | 73 | Preserve — active/uncertain |
| `HISTORICAL_SALES_COST_REPAIR_ROLLBACK_CONFIRMATION` | 74 | Preserve — active/uncertain |
| `HISTORICAL_SALES_COST_REPAIR_RUN_ID` | 66 | One-time control — verify repair/audit |
| `HISTORICAL_SALES_COST_REPAIR_TARGET_HASH` | 72 | Preserve — active/uncertain |
| `JSONCARGO_API_KEY` | 282 | Preserve — active/uncertain |
| `JSONCARGO_BASE_URL` | 283 | Preserve — active/uncertain |
| `JSONCARGO_REFRESH_HOURS` | 286 | Preserve — active/uncertain |
| `LEGACY_STARTUP_MIGRATION_MODE` | 838 | Rollout/cutover — verify before deletion |
| `LOGIN_RATE_LIMIT_MAX` | 210 | Preserve — active/uncertain |
| `LOGIN_RATE_LIMIT_WINDOW_MS` | 212 | Preserve — active/uncertain |
| `MAERSK_CONSUMER_KEY` | 275 | Preserve — active/uncertain |
| `MAERSK_CONSUMER_SECRET` | 276 | Preserve — active/uncertain |
| `MASTER_PASSWORD` | 240 | Preserve — active/uncertain |
| `MASTER_PASSWORD_ENABLED` | 241 | Preserve — active/uncertain |
| `MASTER_PASSWORD_EXPIRES_AT` | 242 | Preserve — active/uncertain |
| `MEMORY_HARD_RSS_MB` | 413 | Preserve — active/uncertain |
| `MEMORY_HARD_SAMPLES_BEFORE_EXIT` | 416 | Preserve — active/uncertain |
| `MEMORY_SAMPLE_INTERVAL_MS` | 419 | Preserve — active/uncertain |
| `MEMORY_SOFT_RSS_MB` | 410 | Preserve — active/uncertain |
| `NODE_ENV` | 34 | Preserve — active/uncertain |
| `OBSERVABILITY_ALERT_EVALUATION_MS` | 365 | Preserve — active/uncertain |
| `OBSERVABILITY_ALERT_WEBHOOK_TOKEN` | 369 | Preserve — active/uncertain |
| `OBSERVABILITY_ALERT_WEBHOOK_URL` | 368 | Preserve — active/uncertain |
| `OBSERVABILITY_ALERTS_ENABLED` | 362 | Preserve — active/uncertain |
| `OBSERVABILITY_WEBHOOK_TOKEN` | 373 | Preserve — active/uncertain |
| `OBSERVABILITY_WEBHOOK_URL` | 372 | Preserve — active/uncertain |
| `OCTOBER_PAYROLL_JOURNAL_INSPECTION` | 49, 785 | One-time control — verify repair/audit |
| `OFFLINE_BROWSER_SYNC_ENABLED` | 736 | Preserve — active/uncertain |
| `OPENAI_API_KEY` | 264 | Preserve — active/uncertain |
| `OPS_DB_POOL_WAITING_WARNING` | 389 | Preserve — active/uncertain |
| `OPS_HEAP_CRITICAL_MB` | 386 | Preserve — active/uncertain |
| `OPS_HEAP_WARNING_MB` | 385 | Preserve — active/uncertain |
| `OPS_RECENT_CRITICAL_EVENTS_WARNING` | 392 | Preserve — active/uncertain |
| `OPS_SERVER_ERROR_CRITICAL_PERCENT` | 378 | Preserve — active/uncertain |
| `OPS_SERVER_ERROR_WARNING_PERCENT` | 377 | Preserve — active/uncertain |
| `OPS_SLOW_REQUEST_CRITICAL_PERCENT` | 382 | Preserve — active/uncertain |
| `OPS_SLOW_REQUEST_WARNING_PERCENT` | 381 | Preserve — active/uncertain |
| `PARCELSAPP_API_BASE_URL` | 290 | Preserve — active/uncertain |
| `PARCELSAPP_API_KEY` | 289 | Preserve — active/uncertain |
| `PARCELSAPP_MONTHLY_LIMIT` | 292 | Preserve — active/uncertain |
| `PASSKEY_ORIGIN` | 226 | Preserve — active/uncertain |
| `PASSKEY_RP_ID` | 222 | Preserve — active/uncertain |
| `PERMISSIONS_V2_COMPANY_ACTIVATION` | 813 | Preserve — active/uncertain |
| `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT` | 809 | Preserve — active/uncertain |
| `PERMISSIONS_V2_ENFORCEMENT` | 818 | Preserve — active/uncertain |
| `PG_CONNECTION_TIMEOUT_MS` | 150 | Preserve — active/uncertain |
| `PG_IDLE_TIMEOUT_MS` | 153 | Preserve — active/uncertain |
| `PG_POOL_MAX` | 143 | Preserve — active/uncertain |
| `PG_POOL_MIN` | 147 | Preserve — active/uncertain |
| `PG_SESSION_POOL_MAX` | 162 | Preserve — active/uncertain |
| `PG_SLOW_QUERY_MS` | 159 | Preserve — active/uncertain |
| `PG_STATEMENT_TIMEOUT_MS` | 156 | Preserve — active/uncertain |
| `PGDATABASE` | 117 | Preserve — active/uncertain |
| `PGHOST` | 113 | Preserve — active/uncertain |
| `PGPASSWORD` | 116 | Preserve — active/uncertain |
| `PGPORT` | 114 | Preserve — active/uncertain |
| `PGSSL_REJECT_UNAUTHORIZED` | 136 | Preserve — active/uncertain |
| `PGSSLMODE` | 121 | Preserve — active/uncertain |
| `PGSSLROOTCERT` | 131 | Preserve — active/uncertain |
| `PGUSER` | 115 | Preserve — active/uncertain |
| `PORT` | 37 | Preserve — active/uncertain |
| `POS_TEMP_FILE_MAX_BYTES` | 582 | Preserve — active/uncertain |
| `POS_TEMP_FILE_MAX_ENTRIES` | 579 | Preserve — active/uncertain |
| `PUBLIC_CARRIER_TRACKING_ENABLED` | 301 | Preserve — active/uncertain |
| `PUPPETEER_BROWSER_IDLE_MS` | 598 | Preserve — active/uncertain |
| `PUPPETEER_EXECUTABLE_PATH` | 319 | Preserve — active/uncertain |
| `PUPPETEER_MAX_CONCURRENT` | 322 | Preserve — active/uncertain |
| `PUPPETEER_MAX_QUEUE_DEPTH` | 325 | Preserve — active/uncertain |
| `PUPPETEER_PREWARM` | 602 | Preserve — active/uncertain |
| `PUPPETEER_QUEUE_WAIT_TIMEOUT_MS` | 328 | Preserve — active/uncertain |
| `READINESS_SCHEMA_CACHE_MS` | 104 | Preserve — active/uncertain |
| `REMOTE_SUPPORT_CANARY_COMPANY_IDS` | 545 | Rollout/cutover — verify before deletion |
| `REMOTE_SUPPORT_INTERNAL_CONTROLLER_USER_IDS` | 549 | Preserve — active/uncertain |
| `REMOTE_SUPPORT_ROLLOUT_STAGE` | 541 | Rollout/cutover — verify before deletion |
| `RENDER_EXTERNAL_URL` | 251 | Preserve — active/uncertain |
| `REQUEST_LOG_SAMPLE_RATE` | 345 | Preserve — active/uncertain |
| `RUN_STARTUP_MIGRATIONS` | 45 | Rollout/cutover — verify before deletion |
| `SCHEDULED_ATTACHMENT_CLEANUP_DELAY_MS` | 477 | Preserve — active/uncertain |
| `SCHEDULED_ATTACHMENT_FORCE` | 484 | Preserve — active/uncertain |
| `SCHEDULED_ATTACHMENT_MIN_BYTES` | 474 | Preserve — active/uncertain |
| `SCHEDULED_ATTACHMENT_ORPHAN_CLEANUP_DELAY_MS` | 480 | Preserve — active/uncertain |
| `SCHEDULED_WHATSAPP_SCHEMA_MODE` | 832 | Preserve — active/uncertain |
| `SESSION_SECRET` | 26 | Preserve — active/uncertain |
| `SEVENTEENTRACK_API_KEY` | 295 | Preserve — active/uncertain |
| `SEVENTEENTRACK_MONTHLY_LIMIT` | 296 | Preserve — active/uncertain |
| `SIMPLE_CACHE_MAX_ENTRIES` | 560 | Preserve — active/uncertain |
| `SLOW_REQUEST_MS` | 348 | Preserve — active/uncertain |
| `STARTUP_MIGRATION_LOCK_FAIL_OPEN` | 177 | Rollout/cutover — verify before deletion |
| `STARTUP_MIGRATION_LOCK_POLL_MS` | 172 | Rollout/cutover — verify before deletion |
| `STARTUP_MIGRATION_LOCK_WAIT_MS` | 169 | Rollout/cutover — verify before deletion |
| `STARTUP_WARNING_SCHEMA_MODE` | 833 | Preserve — active/uncertain |
| `STO_WA_APPROVAL_EXECUTION_ENABLED` | 851 | Preserve — active/uncertain |
| `STO_WA_DELIVERY_ENABLED` | 852 | Preserve — active/uncertain |
| `STO_WA_GREEN_API_WEBHOOK_TOKEN` | 848 | Preserve — active/uncertain |
| `STO_WA_PRODUCTION_ACTIVATED` | 844 | Rollout/cutover — verify before deletion |
| `SUPPLIER_SCOPE_SCHEMA_MODE` | 834 | Preserve — active/uncertain |
| `TICKET_APP_BASE_URL` | 789 | Rollout/cutover — verify before deletion |
| `TICKET_NOTIFICATIONS_ENABLED` | 788 | Rollout/cutover — verify before deletion |
| `TICKET_SMTP_FROM` | 795 | Preserve — active/uncertain |
| `TICKET_SMTP_HOST` | 790 | Rollout/cutover — verify before deletion |
| `TICKET_SMTP_PASS` | 794 | Preserve — active/uncertain |
| `TICKET_SMTP_PORT` | 791 | Rollout/cutover — verify before deletion |
| `TICKET_SMTP_SECURE` | 792 | Preserve — active/uncertain |
| `TICKET_SMTP_USER` | 793 | Preserve — active/uncertain |
| `TRACKING_RATE_LIMIT_MAX_ENTRIES` | 587 | Preserve — active/uncertain |
| `TRAINING_GATEWAY_READ_SECRET` | 774 | Preserve — active/uncertain |
| `TRAINING_MEDIA_GATEWAY_URL` | 773 | Preserve — active/uncertain |
| `TRAINING_MEDIA_PROVIDER` | 772 | Preserve — active/uncertain |
| `TRAINING_MEDIA_S3_ACCESS_KEY` | 778 | Preserve — active/uncertain |
| `TRAINING_MEDIA_S3_BUCKET` | 777 | Preserve — active/uncertain |
| `TRAINING_MEDIA_S3_ENDPOINT` | 776 | Preserve — active/uncertain |
| `TRAINING_MEDIA_S3_REGION` | 780 | Preserve — active/uncertain |
| `TRAINING_MEDIA_S3_SECRET_KEY` | 779 | Preserve — active/uncertain |
| `TRAINING_MEDIA_S3_URL_STYLE` | 781 | Preserve — active/uncertain |
| `UNIFIED_ACCOUNTING_RELEASE_SHA` | 705 | Preserve — active/uncertain |
| `WHATSAPP_PUBLIC_BASE_URL` | 255 | Preserve — active/uncertain |
| `XAI_API_KEY` | 266 | Preserve — active/uncertain |

## Completion/verification gates

1. On a full checkout, run `node scripts/audit-type-env-inventory.mjs` and retain generated `inventory.json` as audit evidence.
2. Run `npm run audit:type-escapes` and `npm run verify:env-docs`; capture outputs and resolve discrepancies.
3. Review dynamic env access, platform settings, client `VITE_` values, and temporary operations against owners before Phase 3 removes them.
4. Establish exact zero/positive TypeScript AST count across tracked files; reconcile the user's '21' with the existing scoped zero ceiling.
5. Validate each repair flag's execution status and rollback/replay requirements against deployment/operator records.

## Phase 1 status

**Partial verification.** Source metadata, full root env inventory and existing checks inspected; complete static consumer results and whole-tree AST counts require executing the generator on a checkout. No claim of completed Phase 1 certification is made.

Classification counts: {"Preserve — active/uncertain":166,"Rollout/cutover — verify before deletion":28,"One-time control — verify repair/audit":21,"Completed candidate — verify removal":2}.
