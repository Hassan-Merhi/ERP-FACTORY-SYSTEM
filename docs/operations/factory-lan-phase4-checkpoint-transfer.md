# Phase 4 checkpoint transport — guarded, **not live ERP replication**

Status: development branch only; no live factory or cloud rollout approved. This
phase establishes a fail-closed cloud HTTP write fence and an encrypted archive
handoff to private object storage. **It does not automatically merge local
PostgreSQL transactions into the cloud or make two databases simultaneously
writable.** The API intentionally continues to report `cloudReplication:
"not-configured"`.

## What this implementation protects

- Cloud defaults remain unchanged. To begin a supervised cutover, every cloud
  API instance can be restarted with `FACTORY_CLOUD_WRITE_MODE=fenced` and
  `FACTORY_CLOUD_FENCE_ACK=CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF`.
  Business HTTP POST/PUT/PATCH/DELETE then return 423
  `CLOUD_WRITES_FENCED`; session/logout/company selection still work. Startup
  background jobs are disabled. This is an HTTP/app-level fence, **not** a
  database-enforced global lock; direct SQL, legacy instances, WebSocket
  mutation paths, existing jobs, integrations and other writer processes MUST
  be separately stopped and independently verified by an operator.
- LAN defaults to read-only. Its separate `lan-primary` switch from Phase 3
  is still forbidden unless cloud writes are comprehensively fenced and an
  audited factory data baseline is restored. The Phase 3 operator ACK alone
  does not prove that another cloud instance has stopped writing.
- Only **age-encrypted** PostgreSQL and upload archives travel to a configured
  private object-store remote; plaintext dumps are never uploaded by this
  command. A signed per-site manifest records file lengths and SHA-256 hashes.
  Each remote ciphertext object is read back and checked byte-for-byte before
  the manifest is published. Remote object names are immutable, and reruns
  verify identical data instead of overwriting differences.
- No browser credentials or PostgreSQL passwords are deployed on laptops or
  stored in the uploaded manifest.

## Configure the encrypted handoff

1. Install `age` and `rclone` on the **factory server**, configure rclone
   with least-privilege access to a private encrypted-backup bucket. Prefer an
   object-store lifecycle policy and separate recovery credentials. Verify the
   cloud location, residency and retention policy with the data owner.
2. Create `deploy/lan/.env` from `factory-edge.env.sample` (owner-readable only). Keep
   the existing `EDGE_BACKUP_AGE_RECIPIENT` as the recipient public key; keep
   the age private identity off the factory host. Set
   `EDGE_SYNC_REMOTE=s3:your-private-backup-bucket/factory-edge` to the name
   of your *preconfigured* rclone remote and bucket/prefix. Set
   `EDGE_SYNC_SIGNING_KEY` to a fresh, independent random 48+ character key
   saved in the disaster-recovery vault. Never reuse a database/session
   password, check in secrets, or email the signing key.
3. Quiesce application writes and uploaded-file changes for a consistent
   point-in-time checkpoint. In a planned maintenance window perform
   `bash deploy/lan/backup-encrypted.sh`. A running-backup script by itself
   cannot prove the database and uploads are mutually consistent; it must not
   be used as an unreviewed replication cutover baseline.
4. Dry-run the paired archives:
   `node scripts/edge/transfer-encrypted-snapshots.mjs --dry-run`.
   Then upload:
   `node scripts/edge/transfer-encrypted-snapshots.mjs`.
   Both commands validate local configuration. The uploader fails closed on
   incomplete pairs, unexpected paths, mismatched hashes or changed archives.
   `rclone cat` is used to verify the bytes stored remotely before the signed
   manifest is published. Remote failures remain errors and can be retried
   without silently replacing objects.
5. Once an approved, immutable checkpoint has been generated, the transfer
   command may be retried on each WAN reconnect or scheduled periodically.
   This only stages ciphertext to cloud object storage. It is **not** a
   cloud ERP database update. Monitor failures and bucket capacity; do not
   interpret a successful network transfer as a restored application.

## Restoring and verifying data

On the isolated recovery machine, download one completed checkpoint's
`edge-checkpoint-<timestamp>.json` and its two matching `.age` files into
the same directory. Supply the expected site UUID and signing key from your
recovery vault, then run:

```sh
export EDGE_SYNC_SITE_ID="your-approved-site-uuid"
# Inject EDGE_SYNC_SIGNING_KEY from your private secret manager; do not put it in shell history.
node scripts/edge/verify-encrypted-checkpoint.mjs /recovery/edge-checkpoint-20261029T223001Z.json
```

The verifier checks site identity, HMAC provenance, both archive hashes and
basic age v1 ciphertext headers. This is a *format and integrity precheck*,
not proof of successful decryption or usable database restoration. Use the
private age identity only during a separately reviewed isolated restore.

No automatic restore/promotion command is supplied: it would be unsafe to
overwrite the independently writable cloud ERP with a factory backup. A
future importer must verify the HMAC manifest and ciphertext on a separate
machine, decrypt with the offline age recovery identity, restore the database
and uploads to a **disposable isolated environment**, verify migrations, all
company/user boundaries, voucher and stock journals, sequence positions,
file/document references, and reconcile the approved authoritative checkpoint.
Only then may an operator approve a separately protected cloud cutover. Never
run an unreviewed `pg_restore --clean` against live cloud data.

## Operations and unfinished release gates

- Disable **all** competing writers (API replicas, workers, direct SQL,
  cron, integrations and WebSocket mutations), rather than relying only on
  the HTTP 423 boundary. Do not reactivate cloud while LAN has unreplicated
  confirmed business writes.
- Define an exclusive writer/epoch transition and a signed trusted bootstrap
  from the cloud into a newly provisioned LAN database.
- Implement a transactionally recorded change stream for each approved ERP,
  Factory and Retail mutation, plus idempotent cloud apply, receipts,
  attachments, sequence reconciliation, conflict review, and stale permissions
  handling. A generic HTTP replay is not safe for money or stock.
- Validate the cutover and failback against disposable **real databases**,
  simultaneous laptop users, WAN failure, LAN power failure, interrupted
  uploads and restore, concurrent edits and financial invariants.
- Obtain independent security/DB review and full CI before production.

**Never set `OFFLINE_MODE_ENABLED=true` or `EDGE_WRITE_MODE=lan-primary` just
because the checkpoint files reached the cloud.** Cloud-to-factory bootstrap,
operation-level cloud synchronization, and production acceptance are still
outstanding Phase 4 requirements.

## LAN voucher capture (development-only, incomplete sync)

In LAN-primary mode, the `POST /api/vouchers/with-entries` posting transaction now
also inserts one immutable record in `factory_edge_voucher_outbox`. The table
is created at LAN startup and enforces a unique operation ID per site and a
unique voucher ID per site/company. Source evidence contains the posted voucher
and entries, actor, company, site, stable request ID when available, plus a
payload digest. An advisory transaction lock serializes insertion so that
the ordered outbox does not skip an earlier uncommitted voucher event.

A failed outbox insert rolls back the voucher transaction; the app never tells
a user that a voucher succeeded if its LAN capture failed. Replayed vouchers
do not generate a second record. In ordinary cloud mode no outbox is created.

LAN-primary now **rejects** POST/PUT/PATCH/DELETE to other business endpoints
with HTTP 423 `EDGE_SYNC_UNSUPPORTED_OPERATION`. The only capture-eligible
business HTTP write is `POST /api/vouchers/with-entries`. This strict
allowlist prevents a seemingly successful local mutation from being omitted
from this outbox. The eligible voucher still remains LOCAL until a cloud
acceptance protocol is certified.

**This is only one audited write path.** POS, inventory, factories, scanner
queues, payments, many other voucher operations, and document attachment
changes are *not* captured through this hook. There is currently no
authenticated cloud receiver, cloud ledger posting, replay receipt, or
cross-database conflict resolution. No process should automatically advance
or delete this outbox based solely on upload success. Do not enable LAN-primary
for a full ERP rollout until these missing paths and a real DB-backed
single-writer cutover are certified.

## Isolated cloud-to-factory bootstrap rehearsal

An operator may use a signed and age-encrypted **approved cloud checkpoint**
to rehearse an initial LAN baseline. Keep the private age identity on a
restricted recovery device, and ensure the PostgreSQL 17 factory server
container is running. Run from the factory server source checkout, using a
**cloud-signed** checkpoint verified against its cloud source site ID:

```sh
# Supply EDGE_SYNC_SITE_ID and EDGE_SYNC_SIGNING_KEY securely from recovery vault.
export EDGE_RESTORE_ACK=DISPOSABLE_DATABASE_ONLY
bash deploy/lan/rehearse-encrypted-bootstrap.sh \
  /secure/edge-checkpoint-20261029T223001Z.json /secure/age-identity.txt
```

This script performs HMAC + ciphertext checks before decrypting, then restores
only into a **new database named `erp_edge_rehearsal_...`** on private
PostgreSQL. It never truncates, restores into or promotes the active
`erp_edge` database. It checks restored users and companies are queryable.
The disposable database still contains sensitive decrypted business data:
protect the factory host, restrict database access and erase the rehearsal
database after approved review. A passing rehearsal is not permission to turn
on LAN-primary. Production provisioning also requires verified uploaded
files, ledger/stock/inventory totals, schema and sequence compatibility,
role isolation and documented operator cutover.

## Optional LAN-to-cloud signed voucher staging (Phase 4 development)

The factory can now transmit **evidence** of vouchers created through the one
approved LAN route to a durable cloud-side inbox. Staging is not the same as
posting the voucher to the cloud ledger. Every positive receiver acknowledgement
is named `staged-not-applied`; neither the receiver nor relay updates cloud
vouchers, stock, customer balances, or accounting journals. The source outbox
remains append-only, and separately stored stage receipts allow retries after
interrupted connectivity. The sender runs only if explicitly enabled.

### Cloud operator setup (no cloud posting)

1. Deploy the SAME reviewed build to factory and cloud. Independently confirm
   cloud writers, background jobs, existing replicas, direct database clients
   and integrations are stopped before any primary handoff; the HTTP fence
   by itself is insufficient.
2. Configure `FACTORY_CLOUD_WRITE_MODE=fenced` and
   `FACTORY_CLOUD_FENCE_ACK=CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF`
   on **every cloud application instance**.
3. Set `FACTORY_SYNC_RECEIVE_ENABLED=1`,
   `FACTORY_SYNC_SITE_ID` to the factory's UUID, and
   `FACTORY_SYNC_HMAC_KEY` to an independent random shared key of at
   least 48 characters. Store the key in a restricted secret manager. The
   service refuses to start the receiver unless the cloud is fenced.
4. The cloud's `POST /api/edge/sync/stage` endpoint requires HTTPS and
   timestamped HMAC-SHA256 over the exact JSON request bytes. No user session
   or browser CSRF cookie is accepted as a substitute. Requests are restricted
   to one configured site, the voucher-evidence schema and at most 25 events,
   and reject changed hashes or invalid sequences. A replay of the same event
   can return an identical staged receipt; a changed replay is rejected.

### Factory relay setup (off by default)

1. Put the **same** site-specific HMAC key in `EDGE_SYNC_API_KEY` within the
   protected `deploy/lan/.env`. Configure `EDGE_SYNC_CLOUD_URL` as the
   cloud's trusted HTTPS **origin**, without a path, for example
   `https://erp.example.com`. Do not disable TLS validation.
2. Ensure factory data has an approved, matching cloud baseline. Keep the
   local writes restricted to the audited voucher route.
3. Start the optional relay using
   `docker compose --env-file deploy/lan/.env -f deploy/lan/compose.yaml
   --profile sync up -d relay`. It attempts transmission immediately and
   again approximately every minute. It can restart safely after outages:
   cloud-side stage records are idempotent, and the LAN receipts are separate
   from accounting vouchers.
4. Shut down the relay at any time with
   `docker compose --env-file deploy/lan/.env -f deploy/lan/compose.yaml
   --profile sync stop relay`. The factory database keeps its durable
   outbox and resumes from the staged receipts on re-enable.
5. Cloud rejects missing earlier sequence numbers, duplicate operation IDs
   with conflicting contents, and different payload hashes. The LAN sender
   refuses a forged cloud response that claims `applied`. A 409 means the
   operator must investigate—**never** skip missing or divergent evidence.

The sequence allocator is transactionally updated along with each LAN voucher
and rolls back if the voucher fails, avoiding identity-sequence gaps that could
otherwise permanently stall a strict cloud receiver. The cloud inbox writes
only to `factory_edge_staged_vouchers` and its cursor; LAN receipts write
only to `factory_edge_stage_receipts`.

**Not implemented:** cloud business ledger posting, idempotent application
receipts, row-ID remapping, stale permissions, cross-company authority,
document/stock/production mutations, dual-writer conflict resolution, live
failover, and automatic cloud-to-factory ERP data merging. The sender is a
staging-only, deliberately limited Phase 4 building block; do not interpret
the relay running as the factory being fully synchronized.
