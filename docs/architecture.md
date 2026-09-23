# Architecture

## Overview

Full-stack TypeScript monorepo. A single Express server handles both the REST API and serves the Vite-built frontend. There is no separate frontend deployment step — `npm run build` produces everything and `node dist/index.js` runs it all.

```
client/   → React frontend (Vite)
server/   → Express backend (tsx / esbuild)
shared/   → Types and schema shared by both sides
```

---

## Frontend (`client/src/`)

**Routing** — `wouter`. All routes are defined in `client/src/App.tsx`. The app renders one of three route trees depending on the session role:

- `POS` role → limited route set (`/`, `/pos/edit/:id`, `/location-inventory`, `/pos-daybook`, `/vouchers`, etc.)
- Full ERP user → full route set (`/tracking`, `/financial-overview`, `/pos`, `/location-inventory`, `/stock-items`, `/containers-otw`, `/vouchers`, `/daybook`, `/parties`, `/suppliers`, `/customers`, `/payroll`, `/factory/*`, etc.)

**State / data fetching** — TanStack Query v5. All queries use `queryKey` arrays and a shared default fetcher. Mutations use `apiRequest` from `client/src/lib/queryClient.ts` and invalidate cache after success.

**Forms** — `react-hook-form` + `zodResolver` using insert schemas from `shared/schema`.

**UI components** — `shadcn/ui` (Radix primitives + Tailwind CSS). Source in `client/src/components/ui/`. App-level shared components in `client/src/components/`.

**Contexts** — `client/src/contexts/` (theme, user session, company selection).

**Offline** — Dexie.js + a custom sync engine. Draft autosave and conflict resolution are handled in `client/src/lib/`. An `OfflineBanner` component surfaces the offline state.

**Key directories**

| Path | Purpose |
|---|---|
| `client/src/pages/` | Page components, sub-divided into `factory/`, `pos/`, `properties/`, and root ERP pages |
| `client/src/components/` | Shared UI primitives and feature-specific components |
| `client/src/components/ui/` | shadcn/ui base components |
| `client/src/hooks/` | Custom React hooks |
| `client/src/lib/` | API client, queryClient, offline/sync utilities |
| `client/src/contexts/` | React contexts |

---

## Backend (`server/`)

**Entry point** — `server/index.ts`. Bootstraps Express, configures session (PostgreSQL session store), CSRF protection (two layers: Origin/Referer guard + synchronizer token), and registers all route modules.

**Route registration** — `server/routes.ts` is the barrel that imports and calls every `register*Routes(app)` function. Route modules are organized into sub-directories:

| Directory | Covers |
|---|---|
| `server/routes/` (root files) | Auth, inventory, ledger, vouchers, POS, containers, stock, accounts, customers, suppliers, employees, import/export, admin, stats, reports, AI, WhatsApp, etc. |
| `server/routes/vouchers/` | Voucher create, query, journal, payment, purchase update, sales update, transfer |
| `server/routes/containers/` | Container CRUD, offload, freight, tracking, accounting, documents, costing |
| `server/routes/factory/` | Bales, scanning, customer orders, employees/POS, raw stock, suppliers, production planner, sheets, dispatch batches, transporters, label banners |
| `server/routes/admin/` | User management, company settings, data tools, import/export, deleted items, PO fix, repair |
| `server/routes/payroll/` | Payroll core, advances, worker statements/stats |
| `server/routes/rental/` | Rental units, contracts, accrual config, payments |
| `server/routes/stock/` | Stock groups/items, item management, merge, price list import, transfer/adj |
| `server/routes/stats/` | KPI data, net position, net profit, reports, sales |

**Auth middlewares** (`server/auth.ts`):

| Middleware | Effect |
|---|---|
| `requireAuth` | Verifies session; populates `req.user` |
| `requireRole(...roles)` | Checks `req.user.role`; Developer always passes |
| `canDelete` | Blocks Owner, POS, and Manager without `canDeleteRecords` flag |
| `requireNonPOS` | Blocks the POS role entirely |
| `checkPOSLocation` | Verifies POS user is assigned to the requested location |
| `canModifyDate` | Admin/Developer bypass; POS = today only; Manager/Owner = within `daybookEditDays` window |

**Storage layer** — `server/storage/index.ts` re-exports a unified `storage` object composed from domain modules:

| Module | Covers |
|---|---|
| `server/storage/accounting.ts` | Ledger accounts, vouchers, daybook, bank accounts |
| `server/storage/auth.ts` | Users, sessions, company roles |
| `server/storage/containers.ts` | Containers, offloads, container sales |
| `server/storage/employees.ts` | Employees, groups, salary advances |
| `server/storage/factory.ts` | Factory entities (bales, orders, workers, products, suppliers) |
| `server/storage/inventory.ts` | Inventory rows, stock items, locations |
| `server/storage/pos.ts` | POS sales, shifts, draft sales |
| `server/storage/stockOps.ts` | Stock transfers, adjustments |
| `server/storage/suppliers.ts` | Suppliers, supplier balances |

**Key server helpers**:

| File | Purpose |
|---|---|
| `server/inventoryHelper.ts` | `adjustInventory()` — all inventory mutations; `reverseInventoryByExactValue()` |
| `server/netPositionHelper.ts` | Net position calculation helpers |
| `server/lib/permissionHelpers.ts` | Advanced restriction lookup |
| `server/lib/permissionMiddleware.ts` | `requireModuleAccess`, `requireActionAccess`, `requireExportAccess` |
| `server/lib/dateUtils.ts` | Fiscal date helpers |
| `server/lib/serverLog.ts` | Production-safe logging wrapper |

**Services** (`server/services/`): container tracking scheduler, export job manager, email service, WhatsApp service, scheduler service.

---

## Shared (`shared/`)

`shared/schema.ts` re-exports from the split schema files. Do not import individual schema files directly — always import from `@shared/schema`.

| File | Covers |
|---|---|
| `shared/schema/common.ts` | Companies, locations, users, user-company roles, company settings |
| `shared/schema/accounting.ts` | Ledger accounts, bank accounts, fixed assets |
| `shared/schema/erp.ts` | Vouchers, voucher entries, purchase orders, customers, suppliers, employees, stock transfers/adjustments, sales items, POS shifts, etc. |
| `shared/schema/inventory.ts` | Inventory, stock items, stock groups, containers, container offloads |
| `shared/schema/pos.ts` | POS-specific tables (location price groups, draft sales, pending barcodes) |
| `shared/schema/factory.ts` | Factory bales, products, orders, workers, mix batches |
| `shared/schema/containers.ts` | Container tracking, freight, documents |
| `shared/schema/properties.ts` | Property rental units, contracts, accruals |
| `shared/schema/sp.ts` | Supplier partner (SP) entities |
| `shared/schema/users.ts` | User preferences, passkeys, notifications |
| `shared/permissionConfig.ts` | Full permission catalog (`PERMISSION_CATALOG`) |

---

## How client / server / shared connect

```
shared/schema  ──► Drizzle table defs + Zod insert schemas + TypeScript types
      │
      ├──► server/  uses Drizzle ORM + pg pool to query PostgreSQL
      │    └──► storage modules → route handlers → Express JSON API
      │
      └──► client/ imports insert schemas for form validation (zodResolver)
           └──► TanStack Query fetches from /api/* endpoints at runtime
```

---

## Company Types

| Value | Description |
|---|---|
| `erp` | Standard ERP (accounting, inventory, vouchers) |
| `factory` | Factory / bale production system |
| `factory_v2` | Updated factory schema (Needs verification — may overlap with `factory`) |
| `properties` | Property rental management |
| `supplier_partner` | Supplier partner (SP) entity |

---

## Multi-tenancy

Tenant identity is server-owned. The global `tenantIsolationBoundary` resolves the active company from authenticated session/company-role state, rejects forged caller-supplied primary company IDs, and membership-checks intentional secondary-company references. Factory and Properties use their server-pinned company context; ordinary ERP/POS routes use the active ERP company.

PostgreSQL adds a second fail-closed boundary for high-risk tenant tables. Migration `0016_company_scope_rls_readiness.sql` enables and **FORCES ROW LEVEL SECURITY** on vouchers, customers, ledger accounts, bank accounts, fixed assets, stock groups, stock items, and inventory; voucher entries are scoped through their parent voucher. Request transactions bind `app.current_company_id` and any explicitly authorized secondary companies. Missing or malformed database tenant context is denied rather than falling back to all-company access.

---

## Build

```bash
npm run dev          # tsx server/index.ts (dev, hot reload via Vite)
npm run build        # vite build (frontend) + esbuild bundle (server)
npm run start        # node dist/index.js (production)
```

The `prebuild` script asserts that `vite` and `esbuild` are resolvable before the build starts.
