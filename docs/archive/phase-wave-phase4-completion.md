# Phase 4 — Compatibility and semantic filename enforcement

**Status: COMPLETE.** Branch: `refactor/phase-wave-semantic-names`. Nothing merged into `main`.

## Compatibility repairs
- Repaired **121 historical script/module/test path references in 22 active GitHub Actions workflows**. Every replacement was verified against the tracked tree before commit.
- Deleted two completed, branch-only **one-shot** mass-rename workflows: `.github/workflows/backend-phase2-apply.yml` and `.github/workflows/frontend-test-script-semantic-rename.yml`. They are not permanent checks and would have attempted to rename already-renamed files on subsequent triggers.
- Preserved eight established phase-numbered workflow filenames (offline contracts, edge validation and factory theme checks) so their workflow identity, direct links, and trigger configurations do not change unexpectedly.
- Preserved published package.json script aliases even when their implementation filenames changed.
- Preserved historical migration paths, data-repair scripts, and deployment SQL identifiers. No migrations or production database were executed.
- Created `config/semantic-filename-compat-map.json` with reviewed overrides for ambiguous legacy path mappings.
- Created `config/semantic-filename-exceptions.json` with **31 exact legacy backend test paths**; new numbered backend test filenames are rejected rather than implicitly exempted.
- Verified the established persisted identifiers / environment keys remain stable: `INVENTORY_VALUATION_WAVE6_REPAIR`, `RUN_WAVE3_INDEX_REPAIR`, the `erp.inventory-valuation-wave6-repair.applied` symbol, and `phase7_writer.state`.

## Permanent checks
- `scripts/verify-semantic-filename-policy.mjs` fails on new numbered runtime/frontend/scripts/build files, unapproved numbered backend tests or workflows, deleted required compatibility paths, or nonexistent executable/source references in the active workflow manifests and `package.json`.
- `.github/workflows/semantic-filename-policy.yml` runs on branch pushes, pull requests targeting `main`, and after merge to `main`.
- `tests/semantic-filename-policy.node.test.mjs` includes negative test cases for numbered runtime modules, unapproved numbered backend tests and nonexistent workflow commands; positive cases test preserved migrations/workflows and persisted runtime identifiers.

## Evidence: verified 2026-11-17
- [Semantic filename policy and entrypoint compatibility](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/44033390455): **passed**.
  - **5 tests passed; 0 failed**.
  - **47** entrypoint manifests scanned, **583** explicit tracked-file references checked, **0** stale/unauthorized references.
- [Backend semantic rename verification](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/44033390573): **passed**.
- [Full phase/wave filename inventory](https://github.com/Hassan-Merhi/ERP-FACTORY-SYSTEM/actions/runs/44033390462): **passed**.

## Scope and next phase
Phase 4 is complete as **compatibility repair and naming enforcement**. Remaining old phase/wave identifiers in historical migrations, docs, deployment keys and reviewed legacy backend test filenames are deliberate exceptions, not missed runtime renames. Phase 5 must still run broader end-to-end regression, release checks and final review before any merge.

**No production data changed, no main branch modified, and no deployment/merge was executed.**
