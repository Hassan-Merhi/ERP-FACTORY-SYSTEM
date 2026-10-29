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
cp deploy/lan/.env.example deploy/lan/.env
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

Remain in `EDGE_WRITE_MODE=read-only` while the cloud is primary. Session login and company switching are permitted, but business mutations intentionally return 423 `EDGE_READ_ONLY`. No automatic cloud fallback is provided.

## 4. Connect factory laptops

Open `https://<EDGE_HOSTNAME>` from each factory laptop and sign in with its **local** provisioned credentials. Bookmark that URL as “Factory LAN ERP.” Keep the cloud bookmark separate. Confirm `/api/edge/status` shows the expected site ID, HTTPS valid certificate and read-only/primary mode on every laptop. Disconnect the WAN at the router (leave LAN powered) and confirm independent laptops can view company-scoped records and the local API responds. Test reconnect, websocket updates, accounting rules, scanner queues, and local network outage/recovery.

**Do not automatically switch a browser or queued write from LAN to cloud.** A cloud login may have a different session and diverging records. Route affinity and cloud replication are Phase 4 work.

## 5. Exclusive primary writes — prohibit until cross-site cutover

Only after the **cloud application has stopped accepting writes for these companies**, the local database has been fully seeded and verified, and an authorized owner has documented cutover may the operator set:

```ini
EDGE_WRITE_MODE=lan-primary
EDGE_PRIMARY_ACK=CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED
```

Then restart the LAN app in a maintenance window. This acknowledgment is a human operational control, **not a cryptographic or automatic cloud write fence**. Running cloud-primary and LAN-primary simultaneously without replication creates split-brain balances and duplicate inventory postings. Never enable during Phase 3 evaluation.

## 6. Backup, recovery and upgrades

Back up **both** the PostgreSQL database (the `postgres_data` volume) and durable uploaded files (the `uploads_data` volume); validate encrypted backups on a separate device and regularly rehearse restore to a new isolated database. Record WAL/database version, schema migrations, site UUID and client versions. Do not place unencrypted backups on laptop shares or GitHub.

On every upgrade: back up, stop company writes, pin the reviewed image/source commit, use Compose `build`, restart, verify `/api/health/ready` and migration report, test authenticated factory operations, then resume. Rollback must restore an appropriate schema+data snapshot; merely swapping an older image may not reverse migrations. The app image carries the same baseline schema/route migrations as the cloud, but **not the cloud data**.

## Explicit limits

Phase 3 delivers a guarded LAN runtime, **not** multi-site synchronization. The LAN is a separate authority. Client browser caches cannot confer login rights. Features dependent on third-party internet APIs, external document generation services, and cloud communications may remain unavailable without WAN. Production go-live still needs real factory hardware acceptance, signed/verified data provisioning, safe writer fencing, encrypted backup/restore drills, and Phase 4 synchronization.
