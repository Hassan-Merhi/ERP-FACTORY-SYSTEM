## Summary

Describe what changed and why.

## Validation

- [ ] Relevant automated tests pass.
- [ ] Build, lint, type-check, and required CI checks pass.
- [ ] I reviewed the diff for accidental generated/debug files.

## Security and data safety

- [ ] No secrets, credentials, private keys, customer data, or production dumps are included.
- [ ] New or changed GitHub Actions use least-privilege permissions and immutable action SHAs.
- [ ] Authorization, tenant isolation, accounting, inventory, or other sensitive behavior has focused regression coverage when applicable.
- [ ] Required security checks were not disabled, skipped, suppressed, or weakened.

## Independent code review (advisory, not a branch-protection requirement)

- [ ] A different contributor reviewed the diff and left a GitHub **Approve** review, where an eligible reviewer was available.
- [ ] For changes involving authorization, money, inventory movements, encryption, or deployments, the reviewer checked failure paths, tenant separation, and regression tests.
- [ ] If merged without an independent reviewer, I documented the reason below rather than treating CI or an AI comment as a human approval.

**Reviewer / reason no reviewer was available:** <!-- e.g. @colleague; solo-maintainer / time-critical fix -->

## Database / deployment impact

- [ ] No database or deployment change.
- [ ] Database/deployment changes are documented, reversible where practical, and validated against the release path.
