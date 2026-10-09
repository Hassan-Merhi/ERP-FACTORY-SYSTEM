# Automatic Priority Printing & Loading — Phase 1 handoff

## Status

Phase 1 code has been committed on `feat/automatic-priority-print-loading`. It has **not** been compiled, executed, or tested; Claude owns verification and CI. The wider feature (Phases 2–8) is still incomplete and must not be enabled in production.

## Scope

- Factory Settings exposes an independent Automatic Priority Printing & Loading switch.
- A newly selected factory company has the mode **OFF** unless an authorized operator explicitly turns it on.
- `GET /api/factory/automatic-priority-mode` returns `{ enabled, canEdit }`, using active session-company scope and `Cache-Control: private, no-store`.
- `PUT /api/factory/automatic-priority-mode` accepts **only** `{ "enabled": boolean }`. The shared role middleware restricts writes to Admin and Owner (Developer is implicitly allowed).
- Switching OFF stops **future** automatic allocations; no bale link, scan, label, or historical allocation is changed by the settings operation.
- Settings changes are serialized by the Priority Scan company advisory lock and write an audit event atomically in the same database transaction.
- Existing ordinary Factory Settings saves and `Enable All` cannot flip the protected switch. Updates to other JSONB settings use an atomic merge so concurrent saves cannot overwrite it.
- The switch reads the current server state; the UI does not optimistically display a saved ON state. It fails closed when loading or encountering API errors, and offers a Retry action.
- The switch uses a company-scoped query key, preventing the previous company's state from being displayed after company selection changes.
- The dedicated switch shares the original feature defaults when it creates a factory settings row; enabling it cannot disable unrelated factory modules.

## Verification delegated to Claude

The unrun regression suite is `tests/automatic-priority-mode-phase1.test.ts`. Verify:

1. New company starts OFF and can read the switch.
2. Only Admin, Owner and Developer can change it.
3. Invalid payloads, arbitrary company IDs and unauthorized writes are rejected.
4. State persists after reload and remains independent across different companies.
5. Ordinary Save/Enable All cannot bypass the dedicated write endpoint or overwrite the setting, including under concurrent saves.
6. Setting transitions create audit events; repeated no-op writes do not create redundant entries.
7. Disabling the switch does not reverse previously allocated bales.
8. Frontend error/loading states remain fail-closed.
9. Run TypeScript, the relevant tests and full CI **only when Claude begins verification**; no checks have been run during implementation.

## Changed Phase 1 files

- `server/routes/factory-intelligence/settings.ts`
- `client/src/pages/factory/factorysettings/AutomaticPriorityPrintingCard.tsx`
- `client/src/pages/factory/factorysettings/FactorySettingsView.tsx`
- `client/src/pages/factory/factorysettings/useFactorySettingsModel.ts` (existing protected-flag exclusion)
- `tests/automatic-priority-mode-phase1.test.ts`

The draft PR will encompass all phases on this same branch. Do not merge or enable the mode before Claude finishes review.
