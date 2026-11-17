# Phase 3 — Environment rollout cleanup

Branch: `refactor/remove-any-and-obsolete-env-flags`

## Applied changes

- Root `.env.example` reduced from **859** to **824 lines** (35 removed; count verified from the fetched branch file).
- Consolidated duplicate variable assignments while retaining one documented declaration and the fuller operation notes for each surviving variable.
- Retired the two historical operations explicitly described in the original environment file as **already completed** and **do not rerun**:
  - `ERP_REPAIR_FACTORY_RENT_SAFE_20261109` — Factory rent history cleanup, company 12.
  - `ERP_REWORK_POS_JNAH_VOUCHERS_20261109` — POS Jnah original-voucher rework, company 17.
- Removed their dynamic post-startup launch blocks in `server/startup/postStartupJobs.ts`.
- Deleted their single-use implementation files:
  - `server/startup/runApprovedFactoryRentSafeRepair.ts`
  - `server/startup/posJnahOriginalVoucherRework.ts`
- The historical implementation remains recoverable from Git history. No database actions or scripts were executed.

## Rationale and scope

The removed switches were marked completed before this branch; leaving a previously executed, opt-in production repair callable from every startup creates unnecessary reactivation risk. Retirement removes both the example entries and the executable startup path, rather than silently hiding an environment variable still consumed in production code.

**Do not generalize this to other one-time repairs.** In particular, the HADI ERP consolidation/prepaid opening, Factory October supplier corrections, accounting migration cutover, remote-support staged controls, Factory LAN/cloud sync safeguards, and permissions V2 rollout have not been proven safely removable.

## Deferred verification

User requested CI and full scans at the end. Consequently this is a source-reviewed change, not a completed test certification.

Run at final verification:
```bash
npm run verify:env-docs
npm run check
npm run lint
npm test
npm run build
```

Also search the entire checkout (including scripts/docs) for the two retired flag names or imports, verify no deployment config expects them, and resolve any existing production environment variables by removing them from the platform's configuration. The branch cannot change Render environment settings.

## Status

**Targeted cleanup committed.** Other historic flags remain deliberately preserved until rollout/repair status, their consumers, and rollback/audit requirements can be verified. This report does not claim all obsolete flags are identified or that Phase 3 is CI-certified.
