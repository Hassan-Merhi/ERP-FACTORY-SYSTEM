# Stock Transfer Order WhatsApp — Phase 7 certification and rollout gate

## Current status
- Same branch as Phases 1–6: `feature/stock-transfer-order-wa-approval-phase1-20261111`
- Draft review PR: https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/pull/3156
- Certification workflow: `.github/workflows/stock-transfer-order-wa-certification.yml`
- Default-deny production activation: **off** unless `STO_WA_PRODUCTION_ACTIVATED=true` is explicitly configured.
- No production migrations, Render deployments, configuration changes, or real WhatsApp sends are performed by the tests.
- At the start of Phase 7 the branch was 22 commits behind `main`; reconcile conflicts before merging.

## Automated release gates

The dedicated branch-triggered GitHub Actions workflow uses two read-only-production jobs:

### Job 1 — source, types, tests, build
1. Install lockfile-pinned npm dependencies.
2. Run full TypeScript compiler check.
3. Execute all Phase 1–6 targeted Vitest source/unit tests and the startup-schema integrity suite.
4. Verify the repository migration registry and startup migration expectations.
5. Build client/server and verify the final server bundle.

### Job 2 — disposable PostgreSQL certification
1. Start PostgreSQL 18 in a disposable CI service, local to the runner.
2. Create the ERP schema in the test database only via Drizzle push.
3. Apply the full Phase 1/3/5/6 approval-schema ensure twice.
4. Verify exact tables, partial unique indexes, audit immutability triggers, event-type statuses, manual retry constraints, and RLS with FORCE enabled.
5. Use `STO_WA_E2E_DISPOSABLE_DB=1` and a localhost URL; the database test suite refuses to run on a remote or unknown database.

**No CI check is considered passed until the associated GitHub Actions run reports success.** Workflows created in this branch do not approve live stock revisions or call GREEN API.

## Required manual end-to-end QA before activation

Execute with a fake/test company and authorized WhatsApp group/phone. Do not perform inventory writes in the production company during verification.

1. Create two or more saved Stock Transfer Orders for the same receiving destination. Save pending revisions from three or more source locations, including changed quantities for the same article.
2. From the existing Stock Transfer Order **Send to WhatsApp → Request Approval**, select all eligible orders and send one consolidated batch message. Confirm it lists all included order numbers, locations and revision numbers.
3. Have the configured authorized sender reply directly to the exact group message with `DONE`. Verify the entire frozen batch commits together and every included pending revision becomes approved/superseded according to the immutable existing lifecycle.
4. Verify the exported **Excel without cost** includes article names, quantities, location subtotals and total, plus an Approved Orders sheet. It must include no prices, rates, costs, valuations or GL amounts.
5. Verify the original approval group and destination-linked WhatsApp recipient each receive **the same workbook bytes**, with separate provider message IDs. If they are the same chat, confirm only one physical WhatsApp send occurs.
6. Re-send DONE, send DECLINE after DONE, send from an unauthorized number, from another group, without quoting, or quoting an unrelated request. No further approval or duplicate workbook may result.
7. Create a new revision after a request but before DONE; the request must become stale and not approve unseen changes.
8. Simulate database rejection of the second order after the first is processed. Verify the entire transaction rolls back and all stock, vouchers and audit remain unaltered.
9. Simulate a GREEN API timeout and a worker crash during an upload. Delivery must remain uncertain and never automatically re-upload; an administrator must inspect both chat and provider history.
10. Test manual verification and the three explicit admin retry authorizations, with a note, frozen recipient, and audited identity.
11. Test tenant separation and roles: other-company users, Managers, Testers, and Workers cannot change administrator reconciliation.
12. Verify reversal/denial paths, independent delivery status, original sender audit, and no production scheduler work when the kill switch is off.

## Production prerequisites

- Reconcile all 22+ main-branch changes and resolve merge conflicts.
- All dedicated GitHub Actions checks and relevant main PR checks green.
- Verified local/disposable PostgreSQL migration, database backup and rollback procedure.
- The main GREEN API instance connected and authorized.
- Configure `STO_WA_GREEN_API_WEBHOOK_TOKEN` (at least 32 random bytes in printable form) on Render, and matching `webhookUrlToken=Bearer <token>` on the same GREEN API instance.
- Enable the incoming webhook and ensure the existing instance webhook integration is preserved. Do not replace another production callback URL without fan-out.
- Configure the authorized approval phone, approval group, and every receiving destination's original recipient in ERP Settings → Export Center.
- `STO_WA_APPROVAL_EXECUTION_ENABLED` and `STO_WA_DELIVERY_ENABLED` must not be `false`, and the authoritative ERP scheduler must be enabled.
- Only **after** all tests and the above checks pass should the release owner deliberately set `STO_WA_PRODUCTION_ACTIVATED=true` and perform a supervised test batch.

## Safety and rollback

1. Set `STO_WA_PRODUCTION_ACTIVATED=false` or remove it to pause approval execution, new approval requests and final Excel delivery.
2. Do not delete or rewrite immutable WhatsApp approval/audit rows; these form the forensic history.
3. Preserve pending/uncertain deliveries for manual reconciliation; do not blindly re-send a timeout result.
4. Code rollback can restore the prior Render deploy; leave additive schema intact unless a separately reviewed migration explicitly requires removal.
5. Never classify GREEN API acceptance alone as proof that a human received/read the Excel.

## Known blockers at initial Phase 7 audit

- Real GREEN API callback and file delivery cannot be certified from a source test; requires a configured instance and test chat.
- Render workspace access from the current connector returned an internal tool error. No deployment or secret installation was made.
- Draft PR is not merged and branch was behind `main`. Do not assert production completion until integration passes.
