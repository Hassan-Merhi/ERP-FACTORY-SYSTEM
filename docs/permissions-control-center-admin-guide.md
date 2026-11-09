# Permissions Control Center — Administrator Guide (Shadow Mode)

**Scope:** A staging and review workflow. The new matrix does **not** change live users' permissions today.

## Access the control center

1. Sign in with your assigned **Admin** or **Developer** access for the target company.
2. Confirm the active company and open **Settings → Users & Permissions**.
3. Use **Role Templates** to inspect the action matrix by module and role. `Inherit` means no additional V2 rule; it does not guarantee permission.
4. In **User Access — Shadow Overrides**, choose a company member. The existing Company Roles editor still manages actual role and location assignments; these override cells are only drafts.
5. Use the diagnostic user preview only to compare the hypothetical role / user decision. It is **not** actual impersonation, an effective legacy permission guarantee, or approval to run an operation.
6. For a proposed edit, change individual cells, explain why (at least 10 characters), **Review** all diffs, then save. The server rejects stale revisions (409); reload and compare again rather than resubmitting blindly.
7. Use **Reset visible to role** to stage `Inherit` decisions for displayed cells. This requires review and save like other edits.
8. Inspect **Permission change audit** for actor, role/user, revision, timestamp, reason and per-cell before/after differences. This log is append-only. The viewer returns the newest 100 entries for the active company.

## Troubleshooting

| Symptom | Meaning | Response |
| --- | --- | --- |
| HTTP 503 / missing shadow schema | The migration was not applied to this environment | Do not run SQL in production; request a reviewed staging migration |
| HTTP 403 | Current account cannot manage that company's permissions | Confirm canonical company membership; do not bypass the access guard |
| HTTP 409 stale revision | Another administrator saved first | Refresh the matrix, compare new rules, and enter a new review |
| Role or user missing | The user is not assigned to the active company | Use the existing approved Company Roles workflow |
| Preview says `Allow` | Hypothetical action-level decision only | Check actual legacy role, location, accounting periods and backend status before taking action |
| Create Only absent from role picker | `PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT` is not `enabled` on the server | Keep it off until every release gate is verified; see the activation runbook |
| 409 `CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED` | Someone tried to assign Create Only while the switch is off | Expected; do not work around it |
| Create Only user sees "not available to Create Only users" | They tried to change, delete, approve or import an existing record | Expected; a person with an editing role must make the change |
| 403 `BUSINESS_ACTION_DENIED` on a new record | The form carried a field Create Only may not set (opening balance, opening stock, backdated contract, another company) | Create the record without it; an editing role adds balances later |

## The Create Only role

Create Only users can browse company data like View Only and add these new records: suppliers, customers, stock items, Factory bale batches and customer order drafts, rental units and contracts, retail products and SP sales. They cannot edit, delete, approve, void, reverse, finalize, import or bulk-change any existing record, including records they created themselves, and they can only date records today. Money and cost fields stay hidden unless you enable them for the role. Switching a page off for the role in Role Permissions also stops creating on it.

Assigning the role is switched off until the release is approved. Follow [the activation runbook](permissions-control-center-activation.md) for the pilot rollout, monitoring and rollback.

## Operational security

- Do not copy security credentials, employee PII, vouchers or banking data into change reasons.
- Do not share temporary elevated access or approve your own policy changes.
- Treat an unexpectedly high volume of 403s or unusual access requests as an incident requiring investigation; check HTTP logs, deny audits and changed policy revisions.
- Preserve a protected backup and the audit trail before any rollback.
- Leave the role picker, company assignment, accounting restrictions, and old authorization middleware in place until a documented company-by-company rollout is approved.

## Release handoff

The current gate registry is `config/permissions-v2-release-readiness.json`. Every gate must carry independently verifiable evidence, pass staging, and receive separate explicit production authorization. The presence of a green workflow does not substitute for database integrity, permission parity, rollback drills, or human sign-off.
