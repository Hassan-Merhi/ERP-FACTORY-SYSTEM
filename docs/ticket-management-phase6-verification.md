# Ticket Management — Phase 6 verification and staging release gate

## Scope and current state

Phase 6 is the **verification and hardening** stage after the implemented Phase 1–5 ticket features. It does not authorize a deployment or migrations against the live ERP/Factory database. The existing pull request remains draft. Ticket notifications remain **disabled by default**.

### Automated acceptance matrix

Run:

```bash
npm run check
npm run verify:migrations
npm run verify:startup-migrations
npm run test:backend -- tests/ticket-management-phase1.test.ts tests/ticket-management-phase2.test.ts tests/ticket-management-phase3.test.ts tests/ticket-management-phase4.test.ts tests/ticket-management-phase5.test.ts tests/ticket-management-phase6.test.ts
npm run format:check:changed
npm run build
```

The Phase 6 suite checks:
- Cross-company and unrelated-user denial, read-access roles, and denied-page behavior.
- Assignee-only finalization with mandatory resolution note.
- Administrator dashboard/export permissions separate from ticket participation.
- Tenant injection and invalid date, priority, status, source, category and assignee report filters.
- Parameterized report filters, inclusive UTC end-of-day and company isolation.
- CSV formula injection, escaped quotes, control characters and Unicode.
- Private file signature, size and filename path validation.
- External notification minimal-content guarantees, recipient de-duplication and safe HTTPS links.

These are **unit-level contractual checks**, not proof of database isolation, HTTP authorization or actual provider delivery.

### Required disposable PostgreSQL integration pass (NOT YET CERTIFIED)

1. Provision a disposable database isolated from every production tenant.
2. Run migrations 001, 002 and 003 in exact registry order and verify repeatability.
3. Create at least two separate test companies with independent Admin, Manager, Normal User, reporter, assignee and participant accounts.
4. Verify all ticket API endpoints under different active company contexts. Cross-company ticket IDs, evidence blobs, voucher IDs and admin dashboard/export URLs must not leak existence, values, or file bytes.
5. Verify Creator vs Assignee vs Manager status transitions, ticket event audit immutability and concurrent status updates.
6. Simulate 24h overdue and 48h repeat reminder boundaries, multiple workers and duplicate retries. Check that finalized tickets stop receiving overdue alerts.
7. Revoke company membership/consent during queued external notification delivery; verify suppression. Use only sandbox destinations.
8. Check 10,001-row CSV cap, exact UTC boundaries, malformed query arrays, and formula-prefixed or Unicode text.
9. Test responsive Factory/ERP dashboard and mobile camera capture, PDFs, link navigation and browser downloads.
10. Verify untouched accounting/voucher/stock journal totals before and after testing.

### Production blockers

- All CI workflows including Semgrep, CodeQL, security, UI quality and full project typecheck must pass on the final candidate SHA.
- The branch must be reconciled with `main`, then CI and regression tests rerun on that **new exact SHA**.
- Staging database evidence and browser/device test evidence must be retained; a skipped database test is **not** a pass.
- SMTP/WhatsApp consent and provider smoke tests must be approved before setting `TICKET_NOTIFICATIONS_ENABLED=true`.
- Deploy only after explicit owner approval. No rollback should delete ticket audit events or irreversible evidence.

## Phase 6 delivery checklist

- [x] Dedicated automated acceptance matrix added to source control.
- [x] Report due-time label made accurate for variable deadlines.
- [x] Existing private evidence response hardened with browser sandbox CSP (earlier security commit).
- [ ] Final candidate CI completely green.
- [ ] Disposable PostgreSQL migration and HTTP integration run.
- [ ] Real responsive/browser/provider smoke checks.
- [ ] Main-branch reconciliation and new green candidate SHA.
- [ ] Explicit release approval.

**Phase 6 code hardening is delivered; Phase 6 release certification is blocked until the unchecked evidence exists.**
