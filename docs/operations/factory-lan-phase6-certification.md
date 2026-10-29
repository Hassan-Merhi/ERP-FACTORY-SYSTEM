# Factory offline Phase 6 — independent release certification

**Status: candidate-only, not approval to enable offline mode.** This runbook is independent of the unfinished Phase 4 checkpoint/cloud handoff and Phase 5 conflict/synchronization work. The Phase 6 gate refuses an incomplete release. It never changes either database, fences a writer, submits an ERP operation, or starts synchronization.

## Acceptance scope

Phase 6 tests and records evidence for: exact-release-head CI, independent security review, Phase 4 transactional cloud reconciliation, Phase 5 conflict and permission handling, exclusive cloud and LAN writer fencing, two factory laptops operating with the WAN disconnected, offline authentication and authorization, interrupted sync and lost acknowledgement, idempotent posting, stock/ledger reconciliation, attachment integrity, host power loss, encrypted backup restored to an **isolated** database, and supervised cloud failback.

Each drill must use a dedicated **nonproduction** factory tenant and an operator-approved procedure; collect no customer exports, cookies, passwords, raw SQL backups, secret values, or encryption keys. Write a small de-identified evidence record per drill explaining environment, device count, exact commit, assertions, observations, reviewer and timestamp. Keep these private and under 2 MiB each; commit only the example manifest, never evidence data.

## Run the non-destructive gate

1. Obtain a signed-off Phase 4 cloud/app/DB exclusive-write policy and a verified transactionally consistent baseline. The Phase 4 archive uploader alone does not qualify. Prove an outbox or change stream and cloud-side idempotent apply with receipts, attachment and sequence reconciliation.
2. Obtain the Phase 5 conflict/resolution and permission-revocation implementation with explicit tests of duplicate retry and two-device concurrent edits. Do not label a manually shipped encrypted snapshot as automated reconciliation.
3. With a real disposable factory deployment and an operator, run the acceptance drills above. Capture separate immutable proof files with SHA-256 digests and UTC timestamps at the **exact proposed release commit**. CI checks on another SHA are not transferable.
4. Copy `deploy/lan/offline-phase6-evidence.example.json` **outside the repository** and replace placeholder fields with the real release SHA, LAN site UUID, exact HTTPS edge origin, expected writer mode, and a `drills` record for every key exported in `REQUIRED_DRILLS` from `scripts/edge/certify-offline-phase6.mjs`. Every record has `result: "pass"`, `releaseSha`, `recordedAt` in UTC, relative `file`, and `sha256` of the proof contents. Proofs expire after 14 days. Use one proof file per drill.
5. In `deploy/lan/.env`, set `EDGE_RELEASE_SHA` to the exact deployed 40-character release commit and rebuild/restart the **staging** LAN application from that same reviewed commit. The gate verifies the value exposed at `/api/build-info`. The value is operator-controlled, so retain independent built-image provenance evidence; an environment variable by itself cannot establish binary identity.
6. Run:

```bash
node --test tests/offline-phase6-certification.node.test.mjs
node scripts/edge/certify-offline-phase6.mjs \
  --manifest /private/phase6-evidence.json \
  --evidence-root /private/phase6-proofs \
  --output /private/phase6-report.json
```

The verifier reads exactly three endpoints on the operator-configured LAN origin over verified HTTPS: `GET /api/edge/status`, `GET /api/health/ready` and `GET /api/build-info`. Redirects, unauthenticated status errors, unprovisioned databases and any cloud replication state other than explicit `cloudReplication: "verified"` block certification. TLS verification is **not** disabled; no mutable HTTP requests are sent. `--no-network` is useful for checking local evidence but *always* returns a blocking `LIVE_PROBE_REQUIRED`. Reports are created only if the output path does not exist.

## External release gates (not automated by this tool)

An independent security/database reviewer must inspect the actual implementation and evidence, verify that all cloud workers, SQL writers and app instances are fenced before authorizing LAN-primary, and sign the final operational approval. The certificate only validates the presence, freshness and SHA-256 integrity of operator evidence **plus read-only runtime status**; it cannot establish that the evidence is truthful or that stock/voucher math is correct. Complete the full existing CI/build/security suite at the exact release SHA, and conduct a real browser/offline restart, factory scanner, backup-restore and rollback drill.

**No production go-live** until Phase 4 and Phase 5 are integrated, hardware acceptance is passed, cold-start authentication and storage encryption risks are addressed, and the owner explicitly approves. Leave `OFFLINE_MODE_ENABLED=false`; retain LAN read-only unless supervised cutover is fully proven. Do not auto-merge this Phase 6 branch or any unfinished phase.
