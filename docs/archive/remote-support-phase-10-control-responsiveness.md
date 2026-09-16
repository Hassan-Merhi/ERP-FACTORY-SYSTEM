# Remote support Phase 10 — control responsiveness

## Scope

Phase 10 makes remote mouse and keyboard control feel immediate under load. It changes *when* work happens, not *what* is allowed.

Permissions, exact-tab binding, company isolation, password confirmation, sensitive-route protection, emergency stop, and the metadata-only audit contract are all unchanged. No control surface is widened and no new capability is introduced.

Three problems were fixed:

1. every command waited on a synchronous audit insert;
2. rate-limited commands were audited and built before being refused;
3. obsolete pointer moves were replayed from the queue after a stall.

No SQL or schema migration is required.

## Auditing moved off the critical path

Per-command auditing is now batched through a dedicated queue rather than awaited inline.

- The audit row is **built at enqueue time**, so it records the session, route, and capability flags that were in force when the command was authorized — not whatever they have become when the batch lands.
- Rows flush on a 250 ms interval, or immediately once 25 rows are pending. A burst of pointer moves becomes one multi-row insert instead of N serialized inserts.
- A failed batch is returned to the front of the queue, so ordering survives a transient outage.
- The queue is bounded at 500 pending rows.

Auditing still **fails closed**. When the queue cannot promise the row — three consecutive failed flushes, or a full backlog — new commands are refused with `503 REMOTE_SUPPORT_AUDIT_UNAVAILABLE` before publication. Control is never silently unaudited; it is blocked at the door instead of paying for a write per command.

Session start, mouse authorization, keyboard authorization, revocation, sensitive-route blocks, and session stop remain synchronous. These are rare, terminal events where a guaranteed write costs nothing perceptible.

The queue is drained at both natural boundaries, so a batch is never stranded:

- when a session stops, so the history of what was just done is readable immediately rather than after the next interval tick;
- during graceful shutdown, before the database pool closes.

## Fail fast on 429

Rate limiting used to run at the *end* of publication. A command that exceeded the window had already been validated and audited before it was thrown away, so the most expensive path in the system was the one that produced nothing.

Both services now expose an admission check — `assertRemoteMouseCommandAdmission` and `assertRemoteKeyboardCommandAdmission` — that applies the exact session, authorization, target-channel, and rate rules publication applies. Routes call it first:

- a refused command costs no audit write and no queue entry;
- no audit row is ever written for a command that did not ship;
- an admitted command is charged against the rate budget exactly once, not twice.

A refusal no longer consumes budget either. Previously each rejected retry inside a saturated window counted against the limit and pushed the controller further out; now a controller that backs off is admitted as soon as the window rolls.

Refusals carry the remaining window in `retryAfterMs` and a `Retry-After` header. The controller treats a 429 as a pacing signal rather than a session error: it backs off for exactly that long — falling back to 250 ms doubling up to 5 s when no hint is present — and shows no error banner for input the server simply asked it to slow down.

## Superseded pointer moves are dropped

A pointer move carries only "the cursor is here now". When the target stream stalled, the queue filled with positions that were already wrong, and reconnect dragged the remote cursor through the stale trail before catching up.

Publishing a pointer move now drops every **undelivered** pointer move already queued for that session. Each dropped command is reported as `ignored` with reason `superseded-pointer-move`, so the controller's in-flight accounting stays balanced, and the ids are returned to the caller as `supersededCommandIds`.

The rule is deliberately narrow:

- only pointer moves are superseded — clicks and scrolls are discrete actions and always survive;
- only commands that have **not** reached a target stream are eligible, because a delivered move has already executed on screen;
- superseding never crosses session boundaries.

The controller applies the same rule locally: the pointer drain reads only the newest sample, and while the rate gate is closed continuous samples are dropped outright while clicks wait for the window to reopen.

## Verification

Focused tests cover:

- newest-move-only replay after reconnect, and `superseded-pointer-move` results;
- clicks, scrolls, delivered moves, and other sessions never being superseded;
- admission refusal producing no queued command and no audit row;
- the exact retry hint, refusals not extending the block, and per-type budgets staying independent;
- admitted commands being charged once across both mouse and keyboard;
- the command endpoint returning 202 while the audit row is still queued;
- batch coalescing, redaction, ordering across a transient failure, backlog recovery, and the fail-closed 503;
- the controller-side rate gate and command decisions.

Existing remote-support suites — sessions, mouse safety, reliability, keyboard, permissions, sensitive-action policy, audit redaction, rollout, and the Phase 8 release boundary — pass unchanged.
