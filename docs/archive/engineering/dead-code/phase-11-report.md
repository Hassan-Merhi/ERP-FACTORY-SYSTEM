# Phase 11 — Assets, styles and documentation

**Status: COMPLETE.** Branch `refactor/erp-dead-code-cleanup`.

## Assets and styles

- All 23 files under `client/public/` are in use: icons through `manifest.json`, the service
  worker, `robots.txt`, and the label artwork through dynamic paths
  (`/labels/hmd-${slug}.jpg`, `/labels/previews/hmd-${slug}-preview.webp` in
  `useLabelDesignColors.ts`). **Nothing removed.**
- All 13 stylesheets are imported by the shells, `main.tsx`, `index.html` or components.
  Per-rule CSS dead-selector removal was not attempted: class names are built dynamically and
  the payoff does not justify the risk to responsive layouts.
- Unused UI components and their packages were removed in Phases 4 and 8.

## Documentation

| Change | Reason |
|---|---|
| `docs/engineering/dead-code/*` and `docs/dead-code-phase4-frontend-audit.md` → `docs/archive/engineering/dead-code/` (the Phase 4 audit is now `phase-4-report.md`) | These are records of finished work. `scripts/audit-doc-index.mjs` requires every doc to be classified and records to live under `docs/archive/`; the earlier phases had added them unclassified, which would have failed `npm run audit:doc-index`. All are now classified `record`. |
| Root `HARDENING_REPORT.md`, `UI_RESPONSIVENESS_AUDIT.md`, `UI_UX_AUDIT.md` → `docs/archive/root-reports/` | Completed audit write-ups with no references; archived (not deleted) to keep the history. |
| `artifacts/security/codeql-phase1-inventory.md` → `docs/archive/security/` | Generated, dated security inventory; kept as a record. |
| `docs/architecture.md` | Points to `server/storage.ts` and no longer lists the deleted `serverLog.ts` (Phase 6). |

The final report `docs/dead-code-cleanup-final-report.md` is a current handoff document,
classified `reference` and linked from `docs/README.md`.

Kept: `README.md`, `replit.md` (Replit agent context, cited by a startup-schema comment),
`design_guidelines.md`, `.agents/` and `.canvas/` (Replit workspace state), `.circleci/`
(compatibility bridge documented in `docs/ci/branch-protection.md`).
