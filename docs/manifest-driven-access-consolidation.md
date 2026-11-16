# Manifest-driven access consolidation — implementation track

Branch: `refactor/manifest-driven-access-layer`. **Work in progress — not production ready.**

## Baseline observed on main (2026-11-16)

- `config/route-manifest.json`: **2,439 registrations** and **142 middleware mounts**.
- **78 repeated method/path registrations**. These can represent intentional prerequisite or fallthrough routes; do not deduplicate.
- Existing `server/middleware/*Scope*` and other global boundaries perform overlapping but sometimes distinct authorization, isolation, maintenance and route classification checks.
- Guard chains contain anonymous handlers. A handler name is **not** an authoritative permission policy.
- Existing controls including PostgreSQL RLS, CSRF, auth, upload restrictions and sensitive-operation checks must remain in effect.

## Required phases and gates

1. **Inventory and contract**: retain the ordered registration snapshot, audit 38 proposed scope middleware replacements, and define explicit rule fields `companyScope`, `permission`, and `roles`. The coverage verifier introduced here fails on missing, duplicate, stale, or invalid declarations. Registration ordinal is part of identity to preserve duplicate/fallthrough registrations.
2. **Policy extraction with human verification**: write `config/route-access-manifest.json` with one *reviewed* rule per registration. No automatic `allow`, Admin, or Developer fallback for unknown routes. Preserve exact webhook/public/service authentication and denial semantics; do not guess permissions from URL paths or `<anonymous>`.
3. **Single access boundary**: implement centralized dispatch that resolves the registered route's manifest declaration, effective live company role, permission and company scope; default deny on unknown entries. Ensure Express registration timing and `next('route')` fallthrough cannot bypass the boundary.
4. **Incremental route cutover**: replace only scope/role/permission guards proven equivalent to the centralized boundary. Keep independent business invariant checks, database row ownership and RLS in place.
5. **Certification**: run backend suites, route snapshot test, 403/401/404 authorization matrix for every role and company mode, negative-company tests, duplicate/fallthrough tests, webhooks, uploads, and production boot. Verify deleting any one access rule makes CI fail. Merge only when fully green.

## Access manifest contract (planned)

```json
{
  "formatVersion": 1,
  "rules": [
    {
      "id": "REGISTRATION_ORDINAL:METHOD /api/example",
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
