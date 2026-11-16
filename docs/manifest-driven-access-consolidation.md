# Manifest-driven access consolidation — implementation track

Branch: `refactor/manifest-driven-access-layer`. **Work in progress — not production ready.**

## Baseline observed on main (2026-11-16)

- `config/route-manifest.json`: **2,439 registrations** and **142 middleware mounts**.
- **78 repeated method/path registrations**. These can represent intentional prerequisite or fallthrough routes; do not deduplicate.
- Existing `server/middleware/*Scope*` and other global boundaries perform overlapping but sometimes distinct authorization, isolation, maintenance and route classification checks.
- Guard chains contain anonymous handlers. A handler name is **not** an authoritative permission policy.
- Existing controls including PostgreSQL RLS, CSRF, auth, upload restrictions and sensitive-operation checks must remain in effect.

## Required phases and gates

1. **Inventory and contract**: retain the ordered registration snapshot, audit the claimed 38 scope middleware replacements against actual repository sources, and define explicit rule fields `companyScope`, `permission`, and `roles`. The coverage verifier introduced here fails on missing, duplicate, stale, or invalid declarations. Registration ordinal is part of identity to preserve duplicate/fallthrough registrations.
2. **Policy extraction with human verification**: write `config/route-access-manifest.json` with one *reviewed* rule per registration. No automatic `allow`, Admin, or Developer fallback for unknown routes. Preserve exact webhook/public/service authentication and denial semantics; do not guess permissions from URL paths or `<anonymous>`.
3. **Single access boundary**: implement centralized dispatch that resolves the registered route's manifest declaration, effective live company role, permission and company scope; default deny on unknown entries. Ensure Express registration timing and `next('route')` fallthrough cannot bypass the boundary.
4. **Incremental route cutover**: replace only scope/role/permission guards proven equivalent to the centralized boundary. Keep independent business invariant checks, database row ownership and RLS in place.
5. **Certification**: run backend suites, route snapshot test, 403/401/404 authorization matrix for every role and company mode, negative-company tests, duplicate/fallthrough tests, webhooks, uploads, and production boot. Verify deleting any one access rule makes CI fail. Merge only when fully green.

## Phase 1 implementation evidence

- `scripts/audit-manifest-access-baseline.mjs` dynamically inventories policy-related modules from `server/middleware`, exported functions, and the full route snapshot. This avoids pretending that the claim of 38 corresponds to 38 independently removable files; some are business-invariant or database isolation boundaries.
- `scripts/verify-route-access-coverage.mjs` validates registration-specific policy entries, including guard chains, duplicate route registrations, invalid company scope, missing role and permission, and stale declarations.
- `tests/route-access-coverage.test.ts` supplies negative tests for missing declarations, duplicate registrations, malformed rules, and guard-chain drift.
- **Phase 2 gate:** review each actual access decision before producing the 2,439 production declarations. A structurally complete but guessed authorization table is prohibited.
- Test commands: `node scripts/audit-manifest-access-baseline.mjs` and `npm run test:backend -- tests/route-access-coverage.test.ts`.
- The Phase 1 checker does **not** yet pass against the entire live route set: `config/route-access-manifest.json` intentionally does not exist until Phase 2 review. No runtime behavior has changed.

## Phase 2 current evidence (2026-11-16)

- `config/route-access-review.json` enumerates **all 2,439** current registrations in Express order, preserving duplicate registrations and exact guard chains. It is **non-enforcing**.
- The existing V2 action inventory contains **112** method/path candidates covering **135** registrations; **2,304** registrations have no matching V2 candidate. The candidate inventory explicitly labels these as candidates, **not reviewed**.
- Existing operational policy source supplies explicit permission keys and role exceptions for **259** registrations; **14** also have V2 candidates. The combined evidence covers **380** registrations, leaving **2,059** without either source of evidence. These numbers describe *evidence coverage*, **not approved final policies**. Policy keys include `act_import_data`, `act_bulk_operations` and export permissions; company scopes and the full legacy guard semantics still need verification.
- The 2,439-row ledger marks unverified rules `unreviewed`; Phase 2 is **not complete** until company scope, permission, role, and special authentication/ownership semantics are verified against implementation for each registration.
- The manually verified exceptions live in `config/route-access-reviewed.json`: the **stock-transfer-order Green API Bearer webhook** and **GET /api/health**. These are the only **2 reviewed** registrations; **2,437 remain unreviewed**.
- The extraction also records **8** direct tenant-exception registrations and **25** global maintenance/deleted-item/user-location classifier registrations, as non-enforcing evidence. These may overlap the operational and V2 evidence groups.
- Generator: `node scripts/generate-route-access-review.mjs --write`, audit `--check`.
- Test: `npm run test:backend -- tests/route-access-review-ledger.test.ts`.
- A route's handler names or method/path are not sufficient to infer its authorization. In particular, unreviewed privileged, upload, service-token, anonymous, conditional/fallthrough and cross-company routes must not get guessed `allow` policies.

## Access manifest contract (planned)

```json
{
  "formatVersion": 1,
  "rules": [
    {
      "id": "REGISTRATION_ORDINAL:METHOD /api/example [exact > handler > chain]",
      "companyScope": "active-company",
      "permission": "exact.named.permission",
      "roles": ["Admin"]
    }
  ]
}
```

The example is illustrative only: **no actual routes have been declared or migrated yet**.
`scripts/verify-route-access-coverage.mjs` checks full ordinal coverage and rejects invalid schema; it is intentionally not wired into CI until declarations are reviewed and the runtime boundary is ready. A green schema-only check must not be mistaken for authorization certification.

## Safety constraints

- Reject missing and ambiguous policies; never derive authorization from an endpoint's name alone.
- Distinguish user sessions, anonymous public endpoints, machine tokens and maintenance operations.
- Preserve per-company role changes and company membership checks as live decisions.
- Protect multipart routes, parameterized paths and grouped router mounts.
- Keep `main` untouched until all phases are verified.
