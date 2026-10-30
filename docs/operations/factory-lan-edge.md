# Phase 3: Factory LAN server — installation & cutover playbook

**Status:** Development branch only. Independent LAN PostgreSQL is not cloud replication; Phase 4 must implement trusted snapshot/bootstrap, cloud fencing, cross-site conflict reconciliation and synchronization before production LAN-primary mode.

## Topology

```
Factory laptops / barcode PCs (HTTPS only, company trusted CA)
                     |
        https://erp.factory.internal:443
                     |
          LAN IP 192.168.x.x -> Caddy
                     |
              Express ERP + React UI
                     |
           PostgreSQL 17 (Docker internal network)
```

No laptop stores database credentials. The database and application ports are NOT published to the factory network. The reverse proxy publishes HTTPS only, bound to one explicit private IPv4 address. Both local and cloud installations retain their own sessions and their own databases. Network failure to the internet does not prevent local access to the LAN server.

## 1. Before deployment

Use a dedicated factory computer with Linux, Docker Engine + Docker Compose v2, SSD storage protected by full-disk encryption, UPS, firewall allowing TCP 443 only from the factory subnet, tested local DNS (or controlled hosts entries) and monitored disk capacity. Keep physical and remote admin access restricted.

Generate a unique UUID for `EDGE_SITE_ID`. Establish a factory-only DNS name that every laptop resolves to the fixed server IP. Provision a TLS certificate and private key with a **DNS Subject Alternative Name** equal to that name. Install/trust the issuing CA on every factory laptop through OS device management. Do not ignore browser security warnings. A trusted public CA cert with split-horizon DNS is also acceptable; internal names usually require a private CA.

## 2. Configure the factory server

```bash
cp deploy/lan/factory-edge.env.sample deploy/lan/.env
chmod 600 deploy/lan/.env
mkdir -p deploy/lan/certs deploy/lan/backups
chmod 700 deploy/lan/certs deploy/lan/backups
```

Fill `EDGE_BIND_IP`, `EDGE_HOSTNAME`, *a new* `EDGE_SITE_ID`, and two independent random secrets (DB and session, at least 48 characters). Use URL-safe random strings; do not reuse the cloud password or session secret.

Place the certificate at `deploy/lan/certs/server.pem` and private key at `deploy/lan/certs/server-key.pem`. Ensure the private key is mode 600. Never commit these files, the populated `.env`, or data snapshots.

```bash
node scripts/edge/verify-edge-configuration.mjs deploy/lan/.env
docker compose --env-file deploy/lan/.env -f deploy/lan/compose.yaml config -q
docker compose --env-file deploy/lan/.env -f deploy/lan/compose.yaml build
docker compose --env-file deploy/lan/.env -f deploy/lan/compose.yaml up -d
```

`GET https://erp.factory.internal/api/edge/status` identifies `mode: lan`, site UUID and `cloudReplication: not-configured`. `/api/health/ready` returns 503 until the database is provisioned and satisfies the application's critical schema checks. Do not fix that by bypassing health checks or enabling cloud DB connections.

## 3. Prepare data (mandatory before real users)

The Compose database is **empty on first boot**. Startup migrations alone do not import factory companies, users, accounts, inventory, supplier history, vouchers or balances. A separate audited **approved, consistent database snapshot** must be restored in an isolated maintenance window; Phase 4 will automate the verified snapshot-transfer/cutover workflow. DO NOT restore cloud backups into the active database without verifying privacy, signatures, schema version, company boundaries, sequence values, balance totals and journal hashes. Practice the process on a disposable clone.

LAN mode suppresses the cloud-derived background cleanup and repair jobs as well as the main scheduler. Remain in `EDGE_WRITE_MODE=read-only` while the cloud is primary. Session login and company switching are permitted, but business mutations intentionally return 423 `EDGE_READ_ONLY`. No automatic cloud fallback is provided.

## 4. Connect factory laptops

Open `https://<EDGE_HOSTNAME>` from each factory laptop and sign in with its **local** provisioned credentials. Bookmark that URL as “Factory LAN ERP.” Keep the cloud bookmark separate. Confirm `/api/edge/status` shows the expected site ID, HTTPS valid certificate and read-only/primary mode on every laptop. Disconnect the WAN at the router (leave LAN powered) and confirm independent laptops can view company-scoped records and the local API responds. Test reconnect, websocket updates, accounting rules, scanner queues, and local network outage/recovery.

**Do not automatically switch a browser or queued write from LAN to cloud.** A cloud login may have a different session and diverging records. Route affinity and cloud replication are Phase 4 work.

## 5. Exclusive primary writes — prohibit until cross-site cutover

**Phase 7 update (development branch; no production cutover approval):** The old two-setting acknowledgment is no longer enough. LAN-primary must also provide an exact writer epoch and restored-baseline SHA-256, and the database itself must contain a DBA-installed transaction fence. The runtime refuses mutation requests when the app database login is a superuser, a table owner, a privileged DDL-capable role, or any current public business table lacks its enabled Phase 7 trigger.

```ini
# These remain EMPTY/disabled until a supervised, independently reviewed cutover.
EDGE_WRITE_MODE=read-only
EDGE_PRIMARY_ACK=
EDGE_WRITER_EPOCH=
EDGE_BASELINE_SHA256=
```

The proposed DBA-only SQL is `deploy/lan/phase7-install-writer-fence.sql`. It is **not executed by application startup**. It initializes with a *fenced* state; installing it on a live writable cloud database can interrupt transactions, so a planned maintenance window and rollback are mandatory. The database trigger holds a shared lock on the persisted epoch state for each covered business statement, so a DBA fence transition waits for in-flight transactions to finish. The app pool announces its exact site/mode/epoch; stale cloud instances and direct SQL without the matching epoch cannot write covered tables **if** the trigger is installed under a separate, protected DBA role.

Before any DBA changes or LAN-primary operation, all of the following must be independently evidenced:

For a **disposable rehearsal only**, use `scripts/edge/audit-phase7-baseline.mjs` to capture read-only, deterministic table-content, schema, sequence and uploads hashes from separately restored, quiesced copies. The database name must begin `erp_phase7_rehearsal_` or `erp_edge_rehearsal_`, and the auditing role must be able to see all companies (a separate privileged auditor on these isolated clones, never a live business-app credential). Example:

```bash
# Both commands use separate isolated clone databases and uploads directories.
# Do not use the active cloud/factory database. Use an approved ciphertext
# checkpoint manifest SHA-256, independently verified before comparison.
PHASE7_AUDIT_DATABASE_URL='postgresql://.../erp_phase7_rehearsal_source' \
PHASE7_AUDIT_SCOPE=source PHASE7_AUDIT_SNAPSHOT_SHA256='<64-char-approved-manifest-sha256>' \
node scripts/edge/audit-phase7-baseline.mjs capture /isolated/source/uploads /private/phase7-source.json

PHASE7_AUDIT_DATABASE_URL='postgresql://.../erp_phase7_rehearsal_factory' \
PHASE7_AUDIT_SCOPE=restore PHASE7_AUDIT_SNAPSHOT_SHA256='<same-approved-manifest-sha256>' \
node scripts/edge/audit-phase7-baseline.mjs capture /isolated/factory/uploads /private/phase7-restore.json

node scripts/edge/audit-phase7-baseline.mjs compare /private/phase7-source.json /private/phase7-restore.json
```

The comparator reports **only** matching fingerprints, never approval. It cannot establish that the two source snapshots are authentic or that uploads/database were captured atomically; an independent trusted cloud backup, archive signature/provenance, secure key handling, tenant-permission review and balance/file reconciliation remain mandatory. Keep reports private.

1. A transactionally consistent, encrypted cloud database **and uploads** snapshot (including tenants/users/roles, journals, inventory, sequences and backups), its source approval and hash, isolated PostgreSQL restore, and count/balance/permission/file reconciliations.
2. Separate DBA/migration and **restricted application** database roles on both sites. A DBA may *rehearse* `deploy/lan/phase7-prepare-restricted-role.sql` **only after** the database fence is installed and its state is `fenced`. The script creates `erp_edge_runtime` as **NOLOGIN** and grants existing business-table DML without table ownership, CREATE, TRIGGER, or writer-state modification; it revokes legacy PUBLIC CREATE defaults. It does not create a login/password or switch the live application, and requires a DBA-reviewed maintenance plan. Validate grants and startup compatibility on a disposable restored copy first. The current sample Compose deployment uses `POSTGRES_USER=erp_edge` as a superuser and also as the app login; it **does not qualify**. Startup schema migrations currently use the application connection and need a separately provisioned migration step before a restricted role can be enabled.
3. Database fence installation on every business table and verification after schema changes, including cron, WebSocket, integration and direct-writer paths. Privileged DBA writes, DDL changes and non-Postgres file effects require separate operational controls. The HTTP session store is excluded from the business-write fence.
4. Cloud write epoch transitioned durably to `fenced`, all cloud app/worker connections drained, independent cloud read-only verification, then approval for a higher **LAN** epoch only after the trusted restore. An env ACK, HMAC staging receipt or a populated users table is *not* cloud fencing evidence.
5. A supervised failback plan: freeze LAN first, reconcile all LAN-created financial, stock and uploaded-file changes into cloud (Phase 8 onward), then enable a **newer** cloud epoch. Do not simply restart the cloud writer; two independent PostgreSQL databases cannot arbitrate a partition without an external operator/consensus handoff.

This Phase 7 implementation is a **fail-closed development foundation**, not a certified cross-site lease or a production-ready active factory restore. Until the role split, independent cloud fence, audited data baseline and live two-site tests exist, keep LAN read-only and `OFFLINE_MODE_ENABLED=false`.

## Phase 8 development: supervised voucher replay (no continuous sync yet)

The unified development branch contains an **operator-only** cloud apply path for immutable staged `voucher.with-entries.v1` evidence, and a separately signed **read-only** endpoint `POST /api/edge/sync/applied-receipts`. Stage receipts remain `staged-not-applied`. A voucher becomes `cloud-applied` only when one PostgreSQL transaction commits the central accounting posting, source-sequence cursor, immutable receipt, source-to-cloud voucher ID mapping and business date. A lost network acknowledgement returns the original mapping on a retry; no second business posting is authorized.

This initial scope is **only active USD Journal vouchers with two or more balanced, ledger-account-only lines**, no linked party/employee, non-USD, POS, inventory, files, or stock side effects. The LAN write boundary now rejects unsupported with-entries requests rather than promising sync for them. The protected central generic route captures vouchers in the same transaction as the local accounting posting. Other modules remain blocked for Phase 9.

**Default is OFF.** The cloud-apply CLI `server/edge/phase8OperatorApply.ts` has no HTTP apply endpoint, no scheduler and no automatic invocation. It refuses without a separately approved company/baseline/positive cloud epoch, the exact `LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED` acknowledgment, an already-installed `phase7_writer` PostgreSQL fence, restricted (non-owner, non-DDL) runtime database role, signed staging receiver, DBA-controlled time-limited actor approval, currently active Admin/Owner company role and committed immutable staging evidence. A DBA must explicitly install the Phase 8 tables using `ensurePhase8ApplySchema` during a reviewed **fenced cloud maintenance window**; never let the restricted runtime role create or own those objects. It must have SELECT but **no modification privileges** on `factory_edge_apply_approvals` or `phase7_writer.state`, and only the narrow table privileges needed for the posting and cursor.

Only in a **disposable rehearsal with independent cutover oversight**, after freezing LAN writes and verifying no in-flight writers, the authorized operator can set these cloud process variables:

```ini
FACTORY_EDGE_MODE=cloud
FACTORY_CLOUD_WRITE_MODE=fenced
FACTORY_CLOUD_FENCE_ACK=CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF
FACTORY_CLOUD_WRITER_EPOCH=<reviewed-positive-cloud-epoch>
FACTORY_SYNC_RECEIVE_ENABLED=1
FACTORY_SYNC_SITE_ID=<approved-factory-site-uuid>
FACTORY_SYNC_HMAC_KEY=<staging-only-shared-key-from-secret-manager>
FACTORY_PHASE8_RECEIPTS_ENABLED=1
FACTORY_PHASE8_APPLY_ENABLED=1
FACTORY_PHASE8_APPLY_ACK=LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED
FACTORY_PHASE8_BASELINE_SHA256=<approved-pre-cutover-baseline-hash>
FACTORY_PHASE8_COMPANY_ID=<approved-single-company-id>
```

Then, using that environment on an isolated operator host with the exact audited build and its restricted PostgreSQL connection, run one sequence at a time:

```bash
node --import tsx server/edge/phase8OperatorApply.ts 1
# Verify the returned cloud voucher ID and ledger rows independently.
# On the factory LAN, after signed staging and successful cloud COMMIT:
node scripts/edge/fetch-applied-receipts.mjs
```

The cloud remains HTTP-fenced and its ordinary schedulers disabled throughout the handoff; only the supervised replay process runs against the approved DB epoch. The LAN receipt downloader compares the cloud receipt to the local immutable outbox identity, SHA-256, company, actor, voucher ID and source business date before adding an append-only local `cloud-applied` receipt. No stage ACK, missing DB row, 5xx, WAN error, invalid TLS, mismatch or partial transaction is treated as applied. Repeat a sequence only to retrieve a **durable committed** receipt.

**Not certified:** A manual env acknowledgment cannot prove two independent PostgreSQL servers are not simultaneously writable. This development path is suitable only for a frozen-LAN failback rehearsal, not live concurrent LAN writes with cloud replication. It does not install/approve the source cloud dataset, transfer uploaded files or test actual production ERP accounting. The full program still needs a reviewed Phase 7 restricted-role rollout, full PostgreSQL posting fixture, independently signed baseline and authority review, real hardware and WAN/restore drills, plus Phases 9–11. Keep production offline mode and LAN-primary disabled.

## 6. Backup, recovery and upgrades

Back up **both** the PostgreSQL database (the `postgres_data` volume) and durable uploaded files (the `uploads_data` volume); validate encrypted backups on a separate device and regularly rehearse restore to a new isolated database. Record WAL/database version, schema migrations, site UUID and client versions. Do not place unencrypted backups on laptop shares or GitHub.

On every upgrade: back up, stop company writes, pin the reviewed image/source commit, use Compose `build`, restart, verify `/api/health/ready` and migration report, test authenticated factory operations, then resume. Rollback must restore an appropriate schema+data snapshot; merely swapping an older image may not reverse migrations. The app image carries the same baseline schema/route migrations as the cloud, but **not the cloud data**.

### Encrypted backup

Install the age CLI on the factory host, and store the **private age identity** offline on a separate recovery device. Put only its public age1 recipient in `EDGE_BACKUP_AGE_RECIPIENT`. Run `bash deploy/lan/backup-encrypted.sh`. It refuses invalid TLS/settings, streams PostgreSQL and uploaded files directly into encryption (no plaintext files on disk), deletes partial archives on failure, and prints completed encrypted archive paths. Copy encrypted files off the host and **test an isolated restore** before authorizing writes. The script does NOT certify successful recovery or perform destructive restores.

## Explicit limits

Phase 3 delivers a guarded LAN runtime, **not** multi-site synchronization. The LAN is a separate authority. Client browser caches cannot confer login rights. Features dependent on third-party internet APIs, external document generation services, and cloud communications may remain unavailable without WAN. Production go-live still needs real factory hardware acceptance, signed/verified data provisioning, safe writer fencing, encrypted backup/restore drills, and Phase 4 synchronization.
