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

The check is read-only and refreshes only while a saved plan is open. It does not reserve physical bales or alter customer loading.

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
