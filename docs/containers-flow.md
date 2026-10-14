# Containers Flow

## Overview

The containers module tracks imported goods shipments from purchase order to warehouse receipt. A container moves through statuses: `OTW` (on the way) → `OFFLOADED`. Route modules live in `server/routes/containers/`.

---

## Container Lifecycle

```
Container created (OTW)
    │
    ├─ Tracking updates (arrival ETAs, port events)
    │
    ├─ Freight costs entered
    │
    ▼
Container offloaded
    │
    ├─ Inventory increased (adjustInventory × items)
    ├─ Supplier payable posted (Voucher A)
    ├─ Agent charge journals posted (if applicable)
    └─ SP intercompany voucher posted (if SP container)
```

---

## Container CRUD

**Route**: `containerCrudRoutes.ts`

A container record holds:
- Supplier link (`supplierId`) — connects to the supplier's ledger
- Status: `OTW` or `OFFLOADED`
- Currency, freight, duty values
- Associated purchase order lines (`poLineItems`)
- Company scoping

Creating a container auto-creates the associated purchase order structure if not already present.

---

## Tracking

**Route**: `containerTrackingRoutes.ts` + `server/services/containerTrackingService.ts`

Tracking is automatic for supported shipping lines:
- **Maersk** — direct API (`maerskProvider.ts`) and public scraper (`maerskPublicProvider.ts`)
- **CMA CGM** — API provider (`cmaCgmApiProvider.ts`) and public provider (`cmaPublicProvider.ts`)
- **17TRACK** — `seventeenTrackProvider.ts`
- **HTTP tracking** — generic HTTP scraper (`httpTrackingScraper.ts`)
- **Parcels App** — `parcelsAppClient.ts` / `parcelsAppScraper.ts`

The tracking scheduler (`schedulerService.ts`) runs every 6 hours (00:00, 06:00, 12:00, 18:00 EST) and calls the appropriate provider based on the container's carrier. Provider resolution is in `server/lib/trackingProviders/providerResolver.ts`.


---

## Offload

**Route**: `POST /api/containers/:id/offload` → `containerOffloadRoutes.ts`

Steps:

1. **Parse request**: `offloadRequestSchema` validates the body (offload date, items, agent charge lines).
2. **Detect edit vs new**: if `container.status === "OFFLOADED"`, this is a re-offload (edit). Existing inventory is fully reversed first.
3. **Reverse existing** (edit only):
   - `reverseInventoryByExactValue()` called for each previously-offloaded item
   - Old `containerOffloadItems` rows deleted
   - Old accounting vouchers reversed/deleted
4. **Reset status** to `OTW`, then proceed with fresh offload.
5. **`storage.offloadContainer()`**: inserts `containerOffloads` + `containerOffloadItems`, changes status to `OFFLOADED`.
6. **`adjustInventory()`**: called for each item — positive delta at the destination location.
7. **Accounting journals** (inside a single transaction):
   - **Voucher A**: debits the stock asset account, credits the supplier payable. Includes freight and duty line items if configured.
   - **Agent charge journals**: if `agentChargeLines` provided with `amountUsd > 0`, separate journal entries are posted per agent.

---

## Post-Offload Charges

After offload, additional charges can be added via `containerCostingRoutes.ts` and `containerAccountingRoutes.ts`. These create supplementary journal vouchers linked to the container.

---

## Prepaid Logic

If a container's supplier account has the subType `"sp_prepaid_expenses"`, prepaid balances are drawn down during offload accounting. The posting debits the prepaid asset account and credits the clearing/expense account. (Needs verification — confirm exact debit/credit direction and accounts used.)

---

## Agent / Duty Charges

Agent charges are passed in the offload request body as `agentChargeLines`:

```json
[
  { "agentAccountId": 42, "amountUsd": 150 }
]
```

Each line with `amountUsd > 0` generates a separate journal entry crediting the agent's payable account and debiting the relevant expense or cost account. (Needs verification — confirm debit account used for agent charges.)

Duty charges are embedded in the main Voucher A line items alongside freight.

---

## Freight

Freight is managed via `containerFreightRoutes.ts` (combined read/write), `containerFreightReadRoutes.ts`, and `containerFreightWriteRoutes.ts`.

Freight can be:
- Paid by the parent company (`freightPaidBy = 'parent'`) — freight is embedded as a debit line in the local voucher
- Paid by the importing company — posted as a separate freight payable

**Known behavior**: when `freightPaidBy = 'parent'` and the PO is on the parent company, the freight cost must still be embedded in the local offload voucher (not skipped). See memory note `same-company-freight.md`.

---

## SP (Supplier Partner) Containers

Containers linked to a Supplier Partner company trigger additional intercompany accounting:
- **Voucher C** is posted in the SP company: Dr Agent Account / Cr SP Intercompany account.
- The SP intercompany account type (`"Intercompany"`) is excluded from net position calculations to avoid double-counting.

When a SP container's existing offload is reversed and re-done, the SP-side Voucher C entries are also deleted before re-posting.

---

## Container Documents

Documents (PDFs, images) attached to a container are stored via `containerDocumentsRoutes.ts` using the `storedFiles` table.

---

## Container Sales

Offloaded container stock can be sold directly via `containerSales` (`insertContainerSaleSchema`). Container sales are tracked separately from POS sales.

---

## Factory Containers vs ERP Containers

| Dimension | ERP Containers | Factory Containers |
|---|---|---|
| Purpose | Import tracking (goods arriving) | Export tracking (bales leaving) |
| Route | `server/routes/containers/` | `server/routes/factory/factoryShippingContainerRoutes.ts` |
| Tracking service | `containerTrackingService.ts` | `factoryContainerTrackingService.ts` |
| Schema | `shared/schema/containers.ts` | `shared/schema/factory.ts` |
