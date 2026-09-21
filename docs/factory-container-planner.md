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
