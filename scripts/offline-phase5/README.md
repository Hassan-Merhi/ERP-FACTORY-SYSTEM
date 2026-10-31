# Phase 5 (independent slice): factory LAN outage acceptance

## Scope and dependencies

This branch starts from main, not the in-progress Phase 4 branch. The user-facing six-phase roadmap has **no committed Phase 5 definition** in the current repository. This is therefore an independently mergeable Phase 5 *acceptance and recovery safety slice*, not a claim that Phase 5 or all offline functionality is finished.

Phase 1/2: durable browser outbox and scoped cached reads remain behind their existing release gate.
Phase 3: the factory HTTPS edge server is required for real probes; see its planned public \`GET /api/edge/status\` API.
Phase 4: cloud write fencing, authoritative restore, reconciliation and replication are prerequisites to safe \`lan-primary\` cutover. This harness **does not implement or verify any of them**.

## What the harness actually proves

A factory laptop can reach a particular HTTPS LAN edge identity before, during, and after an *operator-executed* WAN outage. It separately shows the expected cloud HTTPS endpoint is reachable before and after, but not reachable during, the outage. During the outage the edge must explicitly report \`lan-primary\`; a read-only edge fails the write-availability check.

It never submits business writes, never reads sessions or customer records, never saves credentials, never bypasses TLS, and never changes network routing or performs cutover. An HTTPS 503 **is a reachable WAN server**, not an outage; a TLS validation failure cannot be used to prove disconnection. A server status lacking the Phase 3 expected fields fails closed. JSON evidence includes only coarse status, verified site identity and probe origins.

## Factory operator procedure

1. Use a **nonproduction tenant**, a dedicated factory laptop on the actual factory LAN, a valid trusted HTTPS certificate, a working factory edge with a locally persisted PostgreSQL database, and a distinct cloud HTTPS health URL. Do not share cloud session cookies with LAN. Use a site UUID obtained through the trusted edge provisioning process, not one guessed from the browser.
2. Confirm that Phase 4's cloud write fence and the operator-approved LAN-primary cutover process are complete before enabling local business writes. Never use this probe to decide that cutover itself is safe.
3. Run baseline **while WAN is connected**:

\`\`\`sh
node scripts/offline-phase5/acceptance.mjs --stage baseline \
  --edge https://factory.example.lan --cloud https://erp.example.com/health \
  --expected-site 4caa4fb0-9c6a-4a55-92d2-14f826879a5c \
  --output ./offline-acceptance.json
\`\`\`

4. After controlled WAN disconnection and approved cutover, run the same command with \`--stage outage\`. Do not disable LAN Wi-Fi or unplug factory Ethernet when simulating loss of external internet. Observe actual laptop sign-in, offline data preparation, authorized entry/replay, multi-laptop behavior and backup restore as **separate manual checks**.
5. Restore WAN access and run \`--stage restored\`. Keep the same edge, cloud health URL, expected site and report path for all stages. Failed stages may be retried after correcting conditions. Never delete a failed report to misrepresent readiness.
6. Inspect the saved report and run \`node --test tests/offline-phase5-acceptance.test.mjs\`. A three-stage pass is only **connectivity evidence**. Require separate Phase 4 replication/audit reconciliation, cloud/edge write fences, idempotent replay, stock/accounting totals, restore-from-backup, role-permission and security tests before production activation.

If the server returns a different edge-status JSON schema than \`{ mode: "lan", siteId: "UUID", writeMode: "read-only" | "lan-primary" }\`, coordinate the contract with Phase 3 instead of loosening the checks in production. Operator environment values are illustrative only; provide the actual LAN certificate, URLs and UUID at deployment.

## Verification and known blockers

\`\`\`sh
node --test tests/offline-phase5-acceptance.test.mjs
\`\`\`

Unit tests use mocked HTTP responses; they do not replace hardware, real WAN failure, PostgreSQL restore, browser service-worker or cross-database integration tests. The production offline feature flag must remain disabled until these gates are independently demonstrated. Do not merge the Phase 4 branch as part of Phase 5.
