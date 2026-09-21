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
