# Factory Container Planner

## Phase 1 — read-only preview

The Container Planner lives inside Factory Stock Allocation V5 and uses the same stock picture already exposed by V5.

### Source quantity

For each product, Phase 1 plans only positive `freeToPromise`:

```
freeToPromise = stockAvailable - expectedToLoad - totalLoaded
plannableQty  = max(freeToPromise, 0)
```

This means customer commitments and bales already being loaded remain protected. Negative balances are shown as shortages and are never inserted into a planned container.

Garbage/Wipers are excluded by default, matching the normal V5 visibility convention. The user can include them in the preview explicitly.

### Container count

The default target capacity is 600 bales and can be changed in the UI.

```
containerCount = ceil(totalPlannable / targetCapacity)
```

The planner then distributes every product as evenly as integer quantities allow. Remainder bales go to the currently lightest containers, so final container totals differ by at most one bale and no container exceeds the target capacity.

### Safety boundary

Phase 1 is intentionally read-only:

- no bale IDs are reserved;
- no stock status is changed;
- no customer order is created;
- no `customer_order_expected_lines` row is created or edited;
- no loading status is changed.

Later phases can persist, lock, rebalance, and convert approved plans into the existing V5 loading flow without changing this Phase 1 calculation contract.


## Phase 2 — saved, editable drafts

Phase 2 persists an approved preview as a planning draft without reserving physical bales.

### Persistence

The registered migration `20260921_001_factory_container_planner_phase2.sql` adds:

- `factory_container_plans` — company-scoped plan header and source-stock snapshot totals;
- `factory_container_plan_containers` — ordered planned containers with capacity and lock state;
- `factory_container_plan_lines` — quantity allocations by article inside each planned container.

Plan creation is retry-safe through a company-scoped `client_request_id`. The server recalculates the complete V5 stock picture at save time and never trusts client-supplied product quantities. For older active loading rows that predate `customer_order_expected_lines`, the save snapshot falls back to the linked proforma quantity without modifying the customer order.

### Editing

Saved plans support:

- renaming a plan;
- moving an integer quantity of one product between two unlocked containers;
- locking or unlocking individual containers;
- rebalancing unlocked containers only;
- deleting a draft plan.

A move is rejected when the source quantity is insufficient, either container is locked, or the destination would exceed its bale capacity.

### Lock contract

Locking is a planning control. A locked container's quantities remain unchanged by **Rebalance Unlocked**. The rebalance engine subtracts locked allocations from the plan totals and redistributes only the remainder across unlocked containers.

If the remainder cannot fit in the unlocked capacity, the operation fails without changing the plan.

### Concurrency, tenancy, and audit

All mutations:

- resolve the active company from the session;
- scope plan/container/line writes by `company_id`;
- run in a database transaction;
- lock the plan row, plus affected child rows where needed;
- increment the plan revision;
- write an `audit_log` entry.

Plan creation additionally takes a company-scoped transaction advisory lock so two simultaneous saves cannot race the authoritative stock snapshot.

### Phase 2 safety boundary

Phase 2 still does **not**:

- reserve or assign a physical `factory_bales.id`;
- alter `factory_bales.status`;
- create or edit `customer_orders`;
- create or edit `customer_order_expected_lines`;
- change a customer loading/container lifecycle.

Those actions belong to the later conversion phase.


## Phase 3 — live stock reconciliation

Phase 3 keeps a saved planning draft honest when factory stock or customer commitments change after the plan was saved.

### Live comparison

For the selected saved plan, the ERP compares every planned article against the current authoritative V5 stock picture:

```
currentPlannable = max(current freeToPromise, 0)
delta            = currentPlannable - plannedQty
unplanned        = max(delta, 0)
overPlanned      = max(-delta, 0)
lockedConflict   = max(lockedPlannedQty - currentPlannable, 0)
```

The UI reports three states:

- **IN_SYNC** — every planned article matches current available stock;
- **DRIFT** — new/unplanned stock or over-planned stock exists;
- **LOCKED_CONFLICT** — a locked container alone contains more of an article than is currently available.

The check is read-only and refreshes only while a saved plan is open. It does not reserve physical bales or alter customer loading. Background refreshes only report drift; they never auto-reconcile or rewrite a saved plan.

### Reconcile to Current Stock

Reconciliation is explicit. Nothing changes merely because drift is detected.

When **Reconcile to Current Stock** is pressed, the server recalculates current stock inside the transaction and:

1. preserves every locked container exactly;
2. computes the quantity still required in unlocked containers per article;
3. adds unlocked planning containers if more capacity is needed;
4. removes excess unlocked planning containers if current stock now needs fewer containers;
5. evenly redistributes only the unlocked quantities;
6. updates the plan's source snapshot totals and revision;
7. records the reconciliation in `audit_log`.

If any locked container conflicts with current availability, the operation returns `409 CONTAINER_PLAN_LOCKED_STOCK_CONFLICT` and changes nothing. The affected container must be unlocked before reconciliation can proceed.

### Shared source-of-truth

Phase 2 save and Phase 3 reconciliation now use the same server-side stock-source helper. This prevents the two workflows from drifting apart on customer commitments, loaded bales, or legacy proforma orders that predate expected-line snapshots.

### Phase 3 safety boundary

Phase 3 still remains a planning layer:

- no `factory_bales.id` is assigned to a planned container;
- no `factory_bales.status` is changed;
- no customer order or expected-line quantity is written;
- no loading container is created;
- no shipment is dispatched.

Converting a reconciled planning container into the operational loading flow remains a later phase.


## Phase 4 — physical bale assignment

Phases 1–3 plan quantities only: *Container 1 holds 600 CWR bales*. Phase 4 says **which** 600, by binding real `factory_bales` rows to a planned container.

### Persistence

The registered migration `20260922_001_factory_container_planner_phase4.sql` adds `factory_container_plan_bales`, one row per assigned bale, carrying a denormalized snapshot of the bale's code, reference, product and weight so a loading list stays readable even if the catalogue is renamed later.

### Reservation model

**The assignment row is the reservation.** `factory_bales.status` deliberately stays `IN_STOCK`, because the Phase 2 snapshot and Phase 3 reconciliation both read their plannable totals from that status — flipping it would make a plan appear to lose the very stock it just reserved. Exclusivity is enforced by the database instead: a unique index on `(company_id, bale_id)` makes it impossible for one bale to sit in two containers.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/factory/v5/container-plans/:planId/bales` | Loading screen: planned vs assigned per container and product, plus remaining unassigned stock |
| `GET` | `…/:planId/bale-candidates` | Searchable list of unreserved `IN_STOCK` bales, filterable by product and code |
| `GET` | `…/:planId/bale-scan?code=` | Resolves one barcode and returns a verdict, without writing |
| `POST` | `…/:planId/containers/:containerId/bales` | Assigns by id, by scanned code, or `auto: true` to fill the container |
| `DELETE` | `…/:planId/containers/:containerId/bales` | Releases bales back into unassigned stock |

### Per-bale verdicts

A 600-bale scan session must not fail because of one stray barcode, so each bale is judged independently and rejects come back with a reason: `NOT_FOUND`, `NOT_IN_STOCK`, `ALREADY_ASSIGNED_HERE`, `ASSIGNED_TO_OTHER_CONTAINER`, `ARTICLE_NOT_PLANNED`, `PRODUCT_QUOTA_EXCEEDED`, `CONTAINER_CAPACITY_EXCEEDED` or `DUPLICATE_IN_REQUEST`.

Locked containers refuse both assignment and release.

### Keeping earlier phases honest

Moving, rebalancing or reconciling a plan changes how many bales of a product a container may hold. Those paths now release assignments above the new quota — newest scan first, so the earliest-loaded bales keep their place — and report the released count in their response (`releasedBales`).


## Phase 5 — customer allocation

Phase 4 made a container physical; Phase 5 says who it is for:

```
customer order → container(s) → exact bales
```

### Persistence

`20260922_002_factory_container_planner_phase5.sql` adds `factory_container_plan_allocations` at `(container, customer, product)` grain, so one order may be split across containers and one container may serve several customers.

### Rules

An allocation can never exceed the container's planned quantity for that product, and — when it is linked to an order — never exceed what that order still needs across the whole plan. Outstanding demand reuses the Phase 2 commitment definition: proforma-expected quantities minus what the order has already loaded.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `…/:planId/allocations` | Container coverage and customer order coverage together |
| `PUT` | `…/:planId/containers/:containerId/allocations` | Replaces one customer's reservation on that container |
| `DELETE` | `…/:planId/containers/:containerId/allocations/:customerId` | Releases that reservation |
| `GET` | `…/:planId/customers/:customerId/packing-list` | Loading and packing list, with exact bale codes once Phase 4 has run |
| `GET` | `…/:planId/allocation-history` | Allocation audit trail |

When several customers share a container, the packing list hands each of them a distinct slice of that container's bales in code order, so one bale never appears on two packing lists.

Quantity edits from earlier phases trim allocations they can no longer honour (reported as `adjustedAllocations`) rather than leaving a customer holding a promise the plan cannot keep.


## Phase 6 — container shipment tracking

```
PLANNED → LOADING → LOADED → SHIPPED → ARRIVED → DELIVERED
```

`20260922_003_factory_container_planner_phase6.sql` adds shipment columns to planned containers (container number, carrier, booking number, vessel, destination, ETD/ETA), a `factory_container_plan_container_events` table holding the full status history, and `factory_container_plan_documents` recording which shipping papers exist and where they live.

### Gates

- `LOADING` requires the container to have planned bales.
- `LOADED` requires Phase 4 to be complete for that container — every planned bale has a physical bale.
- `SHIPPED` requires a container number and a carrier.
- Movement is one step at a time in either direction, so a mis-click can be corrected. `DELIVERED` is terminal: reversing a delivery is a commercial event, not a typo.

### Committed containers

Leaving `PLANNED` locks the container. That reuses the lock every Phase 1–5 quantity edit path already respects, so no separate guard was needed — and unlocking a committed container is refused (`409 CONTAINER_SHIPMENT_COMMITTED`) until its status is walked back.

### Endpoints

`GET …/:planId/shipments`, `PATCH …/containers/:id/shipment`, `POST …/containers/:id/shipment/status`, `GET …/containers/:id/shipment/timeline`, and `GET`/`POST`/`DELETE …/containers/:id/documents`.


## Phase 7 — smart optimization

Phases 1–3 spread every product evenly across every container. That is fair, but commercially awkward: each container holds a little of everything, so nothing can be shipped to one customer without repacking.

Phase 7 recommends a layout instead:

1. customers with open orders get whole containers of their own goods, highest priority first (explicit priority, then the larger order);
2. stock nobody has ordered is packed into single-product containers while a product still fills one;
3. the leftovers of both are merged into as few mixed containers as the arithmetic allows.

A customer is only ever promised stock that exists; the rest is reported as `unservedDemand` rather than silently planned.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/factory/v5/container-plans/optimize` | Read-only suggestion from live stock and open orders |
| `POST` | `…/:planId/optimize/apply` | Rewrites a draft plan's containers with the suggested layout |

Applying rebuilds every container, so it is refused (`409 CONTAINER_PLAN_NOT_OPTIMIZABLE`) while anything downstream is committed to the current layout: a locked container, a container past `PLANNED`, an assigned bale or a customer allocation. The response names which of those blocked it.

### Safety boundary, phases 4–7

The planner remains a planning layer throughout. Across all four phases:

- no `factory_bales.status` is changed;
- no customer order, order line or expected-line quantity is written;
- no loading container is created and no shipment is dispatched through the operational flow.

Converting a fully assigned, allocated and loaded planning container into the operational V5 loading flow remains the next piece of work.
