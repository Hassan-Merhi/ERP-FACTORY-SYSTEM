# Offline Phase 5 — encrypted prepared-read snapshots (independent branch)

**Branch:** `feat/offline-phase5-secure-snapshots-20261030`
**Base commit:** `5415e21866b61852d3b9f456f5be326a04e5b5e1` (Phase 1–2 draft).
**Global production toggle:** `OFFLINE_MODE_ENABLED=false`; **do not enable** as a result of this work.

## What this independent phase adds

- New WebCrypto AES-256-GCM encryption for Phase 2 prepared response snapshots, with a random 96-bit nonce per response and authenticated metadata binding to the verified company, user, exact GET URL, creation time and expiry.
- PBKDF2-SHA-256 at 310,000 iterations and a new random 128-bit salt per preparation. The passphrase and extractable keys are never saved; the only in-memory key is WebCrypto nonextractable and scoped to the current actor.
- A sealed verification sentry lets an authenticated tab unlock prepared data after a page reload without transmitting a password. Failed unlocks, malformed ciphertext, replaced response bodies and changed company/user/snapshot metadata fail closed.
- A fully downloaded preparation is encrypted *before* the Dexie transaction promotes its complete snapshot/grant generation. The IndexedDB transaction contains no asynchronous crypto operations.
- UI for setting the preparation passphrase and explicitly locking/unlocking sealed snapshots. Losing the passphrase requires preparing again while online.
- Regression tests and a narrow Phase 5 GitHub Actions workflow.

## Why Phase 4 and unfinished work are not modified

Phase 3 owns the factory HTTPS LAN edge, local PostgreSQL installation and site session lifecycle. Phase 4 owns cloud/edge replication, write fencing, authoritative cutover, deduplication and reconciliation. None of those branches or implementations are changed here. Phase 5 encrypts only browser-prepared GET snapshots and does not introduce server or database replication.

**Dependencies:** Phase 5 needs the Phase 1–2 draft's Dexie v8 scoped snapshot model, live authenticated identity and exact-URL read policy. It does not depend on Phase 4 completion. The branch must be rebased/validated against final Phase 2 and integrated with final Phases 3–4 before rollout.

## Security / compatibility boundaries

1. **Not offline sign-in.** Without a live verified authenticated session in this tab, encrypted records are inaccessible, even with the correct passphrase. Cold-start offline login needs a separately reviewed authorization design or the local Phase 3 server.
2. **Only the Phase 2 prepared-read snapshots are encrypted.** Existing legacy Dexie entities, local drafts, pre-existing offline packages, Phase 1 write outbox, attachments, service-worker assets, and other browser storage are outside Phase 5. No claim of full-device disk encryption is made.
3. **Legacy Phase 2 snapshots remain readable in legacy mode** for safe backward compatibility; protected grants refuse plaintext downgrade and protected rows lacking their grant cannot be read. Before enabling production offline mode, add an explicit, tested purge/re-encryption migration for legacy caches and require encrypted preparation everywhere.
4. PBKDF2 slows password guessing but does not make weak, guessable passphrases safe from an attacker with a full storage dump. Use a strong, unique device passphrase and factory OS full-disk encryption. Browser profile compromise/malicious JavaScript/XSS remains a threat.
5. Existing Phase 1/2 protections still apply: no cached `/api/auth/me`; only exact allowlisted GET responses; no offline write replay from this code; no cross-actor reads; 8-hour TTL and revocation on sign-out/company change.
6. The current UI is feature-flagged off, and no claim is made that ERP, Factory, Retail, or mobile device workflows are yet fully offline.

## Acceptance tests

- Secure round trip, random key derivation salt/nonce, nonextractable keys, rejected wrong passphrase.
- AES-GCM authenticated scope for company ID, user ID, URL, `cachedAt`, `expiresAt`.
- Encrypted batch persisted without sensitive plaintext, read unlocked only under a live verified actor, lock and unlock transitions.
- Reject changed grant salt, raw body injected in an encrypted grant, expired grant, wrong-actor unlock, and cold-start unlock.
- Existing Phase 2 read-cache/pagination regressions.
- Typecheck and Prettier check in `.github/workflows/offline-phase5-check.yml`.

## Remaining operational acceptance

On a disposable test tenant, prepare a dataset online using a passphrase, verify IndexedDB contains only ciphertext **in the new snapshot table**, disconnect WAN without losing the authenticated tab, inspect the offline marker header and data, lock and retry, unlock with an incorrect/correct passphrase, switch company/sign out from another tab, reload under a new verified session, and expire grants. Review the other browser stores separately.

A factory server outage, a browser cold start without network, recovery from a stolen/cleared device, cloud/edge conflict reconciliation, database backups, role revocation during an outage and factory-laptop deployment **still require additional phases and real-world signoff**.
