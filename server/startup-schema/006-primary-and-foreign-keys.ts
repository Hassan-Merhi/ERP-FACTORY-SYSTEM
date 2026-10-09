/**
 * Startup schema migrations - F-Phase 0 through F-Phase 5 data-integrity work: missing primary keys and the foreign key batches, including the deferred and NOT VALID candidates.
 *
 * Part of the ordered `startupMigrations` array assembled in ./index.ts.
 * Statement order is load-bearing: these run sequentially at boot, so entries
 * must never be reordered or moved between parts.
 */

export const primaryAndForeignKeys: string[] = [
  // ── F-Phase 0 (May 2026) — Add missing PRIMARY KEY (id) constraints ──
  // Historical drift: ~143 tables in dev (and presumably prod) were created
  // with `id integer NOT NULL DEFAULT nextval(...)` but no PRIMARY KEY
  // constraint. PostgreSQL refuses ADD FOREIGN KEY against an unconstrained
  // column, blocking F-Phase 2/3 (FK constraints).
  //
  // Idempotent: loops over every public table with an `id` column but no
  // PRIMARY KEY and adds one. No-op on a clean DB.
  //
  // Failure-handling design (per code-review feedback):
  //   - Inner per-table EXCEPTION collects failures into an array instead of
  //     silently swallowing them, so the outer migration-runner's
  //     "Migration skipped: …" log line carries the actual cause.
  //   - Mandatory post-check at end: if ANY table still lacks a PK after
  //     the loop, RAISE EXCEPTION with the failed-table list. This bubbles
  //     up to the outer try/catch in runMigrations() (loud, visible signal
  //     in Render logs), instead of pretending success.
  //   - On a healthy boot the post-check sees 0 missing PKs and the block
  //     exits silently.
  `DO $f_phase0$
     DECLARE
       r record;
       failed text[] := ARRAY[]::text[];
       still_missing int;
     BEGIN
       FOR r IN
         SELECT t.table_name
         FROM information_schema.tables t
         WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
           AND EXISTS (
             SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = t.table_schema
               AND c.table_name = t.table_name
               AND c.column_name = 'id'
           )
           AND NOT EXISTS (
             SELECT 1 FROM information_schema.table_constraints tc
             WHERE tc.table_schema = t.table_schema
               AND tc.table_name = t.table_name
               AND tc.constraint_type = 'PRIMARY KEY'
           )
       LOOP
         BEGIN
           EXECUTE format('ALTER TABLE public.%I ADD PRIMARY KEY (id)', r.table_name);
         EXCEPTION WHEN others THEN
           failed := failed || (r.table_name || ': ' || SQLERRM);
         END;
       END LOOP;

       -- Mandatory post-check: re-count tables still missing a PK.
       SELECT count(*) INTO still_missing
       FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND EXISTS (
           SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = t.table_schema
             AND c.table_name = t.table_name
             AND c.column_name = 'id'
         )
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc
           WHERE tc.table_schema = t.table_schema
             AND tc.table_name = t.table_name
             AND tc.constraint_type = 'PRIMARY KEY'
         );

       IF still_missing > 0 THEN
         RAISE EXCEPTION 'F-Phase 0 INCOMPLETE: % tables still missing PRIMARY KEY. Failures: %',
           still_missing, COALESCE(array_to_string(failed, ' | '), '(none captured)');
       END IF;
     END
     $f_phase0$;`,

  // ── F-Phase 2 (May 2026) — 12 FOREIGN KEY constraints (data integrity) ──
  // All 12 verified orphan-clean in dev before applying. Each ALTER is
  // wrapped in its own DO block that swallows ONLY duplicate_object
  // (constraint already exists from a prior boot) — every other error
  // surfaces through the migration-runner's outer "Migration skipped: …"
  // log line. Order matters only insofar as parents must already have a
  // PRIMARY KEY, which F-Phase 0 above guarantees on this same boot.
  `DO $$ BEGIN ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_lines ADD CONSTRAINT customer_order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_charges ADD CONSTRAINT customer_order_charges_order_id_fkey FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_bales ADD CONSTRAINT customer_order_bales_order_id_fkey FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_proforma_lines ADD CONSTRAINT customer_proforma_lines_proforma_id_fkey FOREIGN KEY (proforma_id) REFERENCES customer_proformas(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE po_line_items ADD CONSTRAINT po_line_items_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_offload_items ADD CONSTRAINT container_offload_items_offload_id_fkey FOREIGN KEY (offload_id) REFERENCES container_offloads(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_photos ADD CONSTRAINT factory_bale_photos_bale_id_fkey FOREIGN KEY (bale_id) REFERENCES factory_bales(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_cost_snapshots ADD CONSTRAINT factory_bale_cost_snapshots_bale_id_fkey FOREIGN KEY (bale_id) REFERENCES factory_bales(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_recode_items ADD CONSTRAINT bale_recode_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES bale_recode_sessions(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE salary_advance_deductions ADD CONSTRAINT salary_advance_deductions_salary_advance_id_fkey FOREIGN KEY (salary_advance_id) REFERENCES salary_advances(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 3 (May 2026) — 12 more FOREIGN KEY constraints (data integrity) ──
  // Same pattern/safety as F-Phase 2: orphan-clean in dev, idempotent on re-run.
  // Note: employee_advance_repayments.advance_id ALSO appears in the inline
  // REFERENCES of its CREATE TABLE above (line ~632) — that inline clause
  // already includes ON DELETE CASCADE so a fresh DB and an existing DB
  // converge to the same FK. Existing DBs (where the inline REFERENCES never
  // ran or ran without ON DELETE) get the correct constraint via the ALTER below.
  `DO $$ BEGIN ALTER TABLE credit_note_items ADD CONSTRAINT credit_note_items_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE sales_items ADD CONSTRAINT sales_items_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_adjustment_vouchers ADD CONSTRAINT stock_adjustment_vouchers_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_bale_removals ADD CONSTRAINT customer_order_bale_removals_order_id_fkey FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_expected_lines ADD CONSTRAINT customer_order_expected_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES customer_orders(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_balances ADD CONSTRAINT customer_balances_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_logos ADD CONSTRAINT customer_logos_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_proformas ADD CONSTRAINT customer_proformas_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_v3_load_bales ADD CONSTRAINT factory_v3_load_bales_bale_id_fkey FOREIGN KEY (bale_id) REFERENCES factory_bales(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_advance_repayments ADD CONSTRAINT employee_advance_repayments_advance_id_fkey FOREIGN KEY (advance_id) REFERENCES employee_advances(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_advance_repayments ADD CONSTRAINT factory_advance_repayments_advance_id_fkey FOREIGN KEY (advance_id) REFERENCES factory_worker_advances(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_adjustment_items ADD CONSTRAINT stock_adjustment_items_adjustment_id_fkey FOREIGN KEY (adjustment_id) REFERENCES stock_adjustment_vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4a (May 2026) — stock_items children (12 of 14 — po_line_items + container_offload_items deferred due to orphans) ──
  // CASCADE for records intrinsic to the stock item (aliases, prices, drafts).
  // RESTRICT for line items / inventory / archive — these carry audit value and must outlive any accidental hard-delete of a stock item.
  `DO $$ BEGIN ALTER TABLE stock_item_code_aliases ADD CONSTRAINT stock_item_code_aliases_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_item_location_prices ADD CONSTRAINT stock_item_location_prices_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE draft_pos_sale_items ADD CONSTRAINT draft_pos_sale_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE credit_note_items ADD CONSTRAINT credit_note_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory ADD CONSTRAINT inventory_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory_negative_layers ADD CONSTRAINT inventory_negative_layers_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE sales_items ADD CONSTRAINT sales_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_adjustment_items ADD CONSTRAINT stock_adjustment_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_group_location_archive_items ADD CONSTRAINT stock_group_location_archive_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_items ADD CONSTRAINT stock_transfer_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_revision_items ADD CONSTRAINT stock_transfer_revision_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE waste_dispatch_items ADD CONSTRAINT waste_dispatch_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4a CLOSURE — orphan-cleanup + 2 final FKs (po_line_items + container_offload_items) ──
  // Pre-cleanup: hard-delete orphan rows (point to deleted stock_items 1989/2003/2004/2261, etc).
  // Idempotent: after first run, FK below prevents new orphans, so DELETE is a no-op forever.
  // Acceptable to delete because the rows already reference dead parents — data was already broken.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'orphan-po-container-items-cleanup-v1') THEN
        DELETE FROM po_line_items WHERE stock_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_items p WHERE p.id = po_line_items.stock_item_id);
        DELETE FROM container_offload_items WHERE stock_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_items p WHERE p.id = container_offload_items.stock_item_id);
        INSERT INTO migrations_log(key) VALUES ('orphan-po-container-items-cleanup-v1');
      END IF;
    END $$`,
  `DO $$ BEGIN ALTER TABLE po_line_items ADD CONSTRAINT po_line_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_offload_items ADD CONSTRAINT container_offload_items_stock_item_id_fkey FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4b (May 2026) — locations children, 21 of 27 applied (6 deferred due to large historical orphan set) ──
  // Defensive: bales.location_id column may be missing on some older deploys (DB-only schema drift). Add idempotently before FK.
  `ALTER TABLE bales ADD COLUMN IF NOT EXISTS location_id integer`,
  // CASCADE for ephemeral / per-location config that has no meaning without the parent location.
  // RESTRICT for everything historical / financial / inventory — admin must explicitly clean up before deleting a location.
  `DO $$ BEGIN ALTER TABLE bale_transfers ADD CONSTRAINT bale_transfers_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_transfers ADD CONSTRAINT bale_transfers_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE bales ADD CONSTRAINT bales_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE credit_note_items ADD CONSTRAINT credit_note_items_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_bales ADD CONSTRAINT customer_order_bales_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE draft_pos_sales ADD CONSTRAINT draft_pos_sales_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bale_pct_rates ADD CONSTRAINT employee_bale_pct_rates_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bale_rates ADD CONSTRAINT employee_bale_rates_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_invoice_loading_sessions ADD CONSTRAINT factory_invoice_loading_sessions_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pos_sales ADD CONSTRAINT factory_pos_sales_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory_negative_layers ADD CONSTRAINT inventory_negative_layers_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE pos_offline_queue ADD CONSTRAINT pos_offline_queue_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE pos_shifts ADD CONSTRAINT pos_shifts_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE production_bales ADD CONSTRAINT production_bales_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_group_location_archives ADD CONSTRAINT stock_group_location_archives_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_item_location_prices ADD CONSTRAINT stock_item_location_prices_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_revision_items ADD CONSTRAINT stock_transfer_revision_items_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE user_locations ADD CONSTRAINT user_locations_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE vouchers ADD CONSTRAINT vouchers_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE waste_dispatches ADD CONSTRAINT waste_dispatches_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  // ── F-Phase 4b DEFERRED (6 candidates with large historical orphan sets — needs prod-DB orphan check + cleanup decision before applying) ──
  // inventory.location_id (14460 dev orphans), stock_transfer_items.source_location_id (1250),
  // stock_transfer_vouchers.destination_location_id (145), stock_transfer_vouchers.source_location_id (145),
  // container_offloads.location_id (55), stock_adjustment_vouchers.location_id (53).
  // All point to deleted location IDs 1-103 in dev (current locations table has IDs 113-143).
  // Treatment requires investigating prod-DB state first — do NOT auto-delete production rows.

  // ── F-Phase 4c (May 2026) — containers children, 17 of 21 applied (4 deferred due to historical orphans) ──
  // CASCADE for per-container detail (charges/docs/freight/snapshots — meaningless without parent container).
  // RESTRICT for everything historical / financial / inventory / audit.
  `DO $$ BEGIN ALTER TABLE bales ADD CONSTRAINT bales_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_charges ADD CONSTRAINT container_charges_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_documents ADD CONSTRAINT container_documents_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_freight ADD CONSTRAINT container_freight_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  // container_freight_payments.container_id was missing from schema.ts (drift) — add defensively before FK so prod gets the column too
  `ALTER TABLE container_freight_payments ADD COLUMN IF NOT EXISTS container_id integer`,
  `DO $$ BEGIN ALTER TABLE container_freight_payments ADD CONSTRAINT container_freight_payments_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_offloads ADD CONSTRAINT container_offloads_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_sales ADD CONSTRAINT container_sales_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_container_other_charges ADD CONSTRAINT factory_container_other_charges_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_container_profit_snapshots ADD CONSTRAINT factory_container_profit_snapshots_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_duty_audit_log ADD CONSTRAINT factory_duty_audit_log_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_mix_batch_sources ADD CONSTRAINT factory_mix_batch_sources_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_offload_additional_charges ADD CONSTRAINT factory_offload_additional_charges_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_waste_entries ADD CONSTRAINT factory_waste_entries_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE mix_batch_sources ADD CONSTRAINT mix_batch_sources_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE production_raw_stock ADD CONSTRAINT production_raw_stock_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE supplier_container_loaded_items ADD CONSTRAINT supplier_container_loaded_items_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  // ── F-Phase 4c DEFERRED (4 with historical orphans — financial/audit, need user decision) ──
  // import_logs (54 orphans, IDs 1-208, NULLABLE — could NULL out safely),
  // factory_fx_allocations (8 orphans, IDs 51-64, NOT NULL — financial, need cleanup decision),
  // factory_container_commissions (7 orphans, IDs 51-64, NOT NULL — financial, need cleanup decision),
  // factory_raw_stock (7 orphans, IDs 51-64, NULLABLE — could NULL out).

  // ── F-Phase 4d (May 2026) — suppliers children, 6 of 15 candidates applied ──
  // All 6 RESTRICT — suppliers should never be deleted casually (financial/historical impact).
  // The remaining 9 candidates are factory_* columns that point to factory_suppliers (separate parent table), NOT suppliers — handled in a separate batch.
  `DO $$ BEGIN ALTER TABLE containers ADD CONSTRAINT containers_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_freight ADD CONSTRAINT container_freight_vendor_supplier_id_fkey FOREIGN KEY (vendor_supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  // supplier_containers is no longer part of the schema — it is created neither
  // here nor in shared/schema, so on a database built from the current schema this
  // failed every startup with 'relation "supplier_containers" does not exist'. The
  // statement is kept and guarded rather than deleted: a long-lived database may
  // still carry the table, and it should still gain the key.
  `DO $$ BEGIN IF to_regclass('public.supplier_containers') IS NOT NULL THEN ALTER TABLE supplier_containers ADD CONSTRAINT supplier_containers_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE supplier_proformas ADD CONSTRAINT supplier_proformas_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4e (May 2026) — factory_suppliers children, 9 of 10 candidates applied ──
  // factory_suppliers is a SEPARATE parent table from suppliers (factory subsystem). 7 rows in dev (IDs 26-32).
  // All 9 RESTRICT — financial / commission / production audit trail; supplier rows must not be casually deleted.
  // DEFERRED: voucher_entries.factory_supplier_id has 2 orphan rows (voucher_id 4468/4469, factory_supplier_id=10, NASSRA payments) — needs user decision: NULL them out (preserves accounting balance) or delete entire entries (would unbalance vouchers).
  `DO $$ BEGIN ALTER TABLE factory_containers ADD CONSTRAINT factory_containers_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_containers ADD CONSTRAINT factory_containers_commission_supplier_id_fkey FOREIGN KEY (commission_supplier_id) REFERENCES factory_suppliers(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_mix_batch_sources ADD CONSTRAINT factory_mix_batch_sources_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_offload_additional_charges ADD CONSTRAINT factory_offload_additional_charges_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_raw_material_adjustments ADD CONSTRAINT factory_raw_material_adjustments_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_raw_stock ADD CONSTRAINT factory_raw_stock_commission_supplier_id_fkey FOREIGN KEY (commission_supplier_id) REFERENCES factory_suppliers(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_payments ADD CONSTRAINT factory_supplier_payments_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_score_snapshots ADD CONSTRAINT factory_supplier_score_snapshots_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_waste_entries ADD CONSTRAINT factory_waste_entries_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4f (May 2026) — voucher_entries.factory_supplier_id ──
  // Defensive SWEEP cleanup: NULL any factory_supplier_id that doesn't exist in factory_suppliers.
  // In dev this matched 2 NASSRA payment rows (ids 15999, 16001, voucher_ids 4468/4469, factory_supplier_id=10, dated 2026-03-10).
  // In prod this guarantees the FK ALTER below succeeds even if prod has different/additional orphan refs.
  // NULL preserves voucher accounting balance (debit/credit untouched); only the dangling pointer is severed.
  // The sweep is idempotent — once enforced by the FK, no rows will ever match the WHERE again.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'orphan-factory-supplier-id-sweep-v1') THEN
        -- Wave 16 (A): no longer clears factory_supplier_id on posted lines; the key below is NOT VALID.
        INSERT INTO migrations_log(key) VALUES ('orphan-factory-supplier-id-sweep-v1');
      END IF;
    END $$`,
  `DO $$ BEGIN ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_factory_supplier_id_fkey FOREIGN KEY (factory_supplier_id) REFERENCES factory_suppliers(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4g (May 2026) — cash_account_id columns → ledger_accounts ──
  // No `cash_accounts` table exists; these 12 dangling cash_account_id (and 1 paid_from_account_id) columns all really point to ledger_accounts (444 rows).
  // Confirmed in dev: schema.ts comment on property_payments.cash_account_id says "FK to ledgerAccounts (the cash box used)" and 100% of non-null values (49 rows: 35 in factory_worker_advances + 14 in user_company_roles) match ledger_accounts ids; 0 orphans across all 12 columns.
  // RESTRICT on all — these are accounting/audit trail (advances, payrolls, POS sales, supplier payments, transporter txs, property payments, role assignments). Deleting a referenced cash-box ledger account would orphan financial history.
  // Excluded: rental_auto_transfer_configs.source_cash_account_ids (integer[] array column — Postgres can't FK an array directly; will be handled separately if needed).
  `DO $$ BEGIN ALTER TABLE employee_advance_repayments ADD CONSTRAINT employee_advance_repayments_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_advances ADD CONSTRAINT employee_advances_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_advance_repayments ADD CONSTRAINT factory_advance_repayments_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_payrolls ADD CONSTRAINT factory_payrolls_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pos_sales ADD CONSTRAINT factory_pos_sales_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_payments ADD CONSTRAINT factory_supplier_payments_paid_from_account_id_fkey FOREIGN KEY (paid_from_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_transporter_transactions ADD CONSTRAINT factory_transporter_transactions_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_worker_advances ADD CONSTRAINT factory_worker_advances_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE pos_shifts ADD CONSTRAINT pos_shifts_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE property_payments ADD CONSTRAINT property_payments_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE user_company_roles ADD CONSTRAINT user_company_roles_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE worker_bonuses ADD CONSTRAINT worker_bonuses_cash_account_id_fkey FOREIGN KEY (cash_account_id) REFERENCES ledger_accounts(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4h (May 2026) — employees parent FKs (10 clean + 1 sweep) ──
  // employees has 66 rows (ids 51–119); 10 of 11 children had 0 orphans.
  // voucher_entries.employee_id (nullable) had 32 orphan rows pointing at deleted employee ids 43–50 (all below current min). Defensive sweep NULLs them — preserves voucher accounting balance, only severs the dangling pointer.
  // RESTRICT on all — HR/payroll/audit history; deleting an employee with payroll/advances/bonuses/attendance must be blocked.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'orphan-employee-id-sweep-v1') THEN
        -- Wave 16 (A): no longer clears employee_id on posted lines; the key below is NOT VALID.
        INSERT INTO migrations_log(key) VALUES ('orphan-employee-id-sweep-v1');
      END IF;
    END $$`,
  `DO $$ BEGIN ALTER TABLE employee_advance_repayments ADD CONSTRAINT employee_advance_repayments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_advances ADD CONSTRAINT employee_advances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_attendance ADD CONSTRAINT employee_attendance_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bale_pct_rates ADD CONSTRAINT employee_bale_pct_rates_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bale_rates ADD CONSTRAINT employee_bale_rates_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bonuses ADD CONSTRAINT employee_bonuses_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_group_members ADD CONSTRAINT employee_group_members_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE erp_payroll_run_items ADD CONSTRAINT erp_payroll_run_items_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE erp_worker_docs ADD CONSTRAINT erp_worker_docs_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4i (May 2026) — vouchers long-tail FKs (11 clean + 1 sweep) ──
  // vouchers has 3,787 rows (ids 28–5416); 12 of 13 candidate child columns clean. purchase_orders.voucher_id had 3 orphans (ids 56/57/104 → missing voucher_ids 67/68/120, all PO-36 from Nov 2025) — defensive sweep NULLs them.
  // DEFERRED: stock_transfer_vouchers.voucher_id has 17 orphan rows but the column is NOT NULL — can't sweep, would need user decision to DELETE the orphan stock_transfer_vouchers rows. Skipped this batch.
  // RESTRICT on all — vouchers are accounting source-of-truth (Receipt/Payment/Journal postings); a referenced voucher must not be deleted while child records still point at it.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'orphan-po-voucher-id-sweep-v1') THEN
        UPDATE purchase_orders SET voucher_id = NULL WHERE voucher_id IS NOT NULL AND voucher_id NOT IN (SELECT id FROM vouchers);
        INSERT INTO migrations_log(key) VALUES ('orphan-po-voucher-id-sweep-v1');
      END IF;
    END $$`,
  `DO $$ BEGIN ALTER TABLE container_sales ADD CONSTRAINT container_sales_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_charges ADD CONSTRAINT customer_order_charges_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bonuses ADD CONSTRAINT employee_bonuses_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_transporter_transactions ADD CONSTRAINT factory_transporter_transactions_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_worker_advances ADD CONSTRAINT factory_worker_advances_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inter_company_transfers ADD CONSTRAINT inter_company_transfers_from_voucher_id_fkey FOREIGN KEY (from_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inter_company_transfers ADD CONSTRAINT inter_company_transfers_to_voucher_id_fkey FOREIGN KEY (to_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory_negative_layers ADD CONSTRAINT inventory_negative_layers_source_voucher_id_fkey FOREIGN KEY (source_voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE property_payments ADD CONSTRAINT property_payments_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE waste_dispatches ADD CONSTRAINT waste_dispatches_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4k (May 2026) — stock_transfer_vouchers.voucher_id (1 FK, user-approved cascade-style cleanup) ──
  // 17 orphan stock_transfer_vouchers rows (Nov 1 – Dec 3 2025) had voucher_id pointing at deleted vouchers (3, 83-88, 134-137, 165, 240, 941, 942, 1046, 1047, 1088).
  // Column is NOT NULL so couldn't sweep-NULL — user explicitly approved DELETE.
  // All 17 had inventory_applied=false (never posted to stock), so deleting them and their child line items is non-destructive (no real inventory ever moved).
  // ORDER MATTERS: delete child line items FIRST (stock_transfer_items.transfer_id is a logical reference but no FK enforced yet — F-Phase 4l queued), THEN delete parents.
  // Idempotent: both DELETE filters return 0 rows after first run; ALTER guarded by EXCEPTION.
  // Note: this only cleans items whose parent is in the orphan-parent set. The broader stock_transfer_items orphan backlog (~953 pre-existing) is queued for F-Phase 4l alongside the FK on stock_transfer_items.transfer_id.
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'orphan-stock-transfer-cleanup-v1') THEN
        DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfer_vouchers WHERE voucher_id NOT IN (SELECT id FROM vouchers));
        DELETE FROM stock_transfer_vouchers WHERE voucher_id NOT IN (SELECT id FROM vouchers);
        INSERT INTO migrations_log(key) VALUES ('orphan-stock-transfer-cleanup-v1');
      END IF;
    END $$`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_vouchers ADD CONSTRAINT stock_transfer_vouchers_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4j (May 2026) — customers long-tail FKs (5 clean, 0 orphans) ──
  // customers parent has 22 rows (ids 2–26); 4 children already had FKs (customer_balances, customer_logos, customer_orders, customer_proformas).
  // Remaining 5 unenforced columns surveyed — all ZERO orphans, no cleanup needed.
  // RESTRICT on all — customer-linked sales/POS/voucher entries are accounting/audit history; deleting a customer with bales/sales/POS history must be blocked.
  `DO $$ BEGIN ALTER TABLE bales ADD CONSTRAINT bales_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_sales ADD CONSTRAINT container_sales_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_invoice_loading_sessions ADD CONSTRAINT factory_invoice_loading_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pos_sales ADD CONSTRAINT factory_pos_sales_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE voucher_entries ADD CONSTRAINT voucher_entries_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4l (May 2026) — stock_transfer_items.transfer_id (1 FK, NOT VALID — non-destructive future-only enforcement) ──
  // 953 pre-existing orphan rows ($659K total value, Nov 26 – Dec 31 2025, across 35 deleted parent transfers, ids 72–218).
  // We CANNOT determine retroactively whether each deleted parent had inventory_applied=true (real stock moved → these items are audit history) or false (pure metadata).
  // Per user safety mandate ("100% safe, no data loss"), we use NOT VALID: existing orphans preserved untouched, audit trail intact.
  // NOT VALID means: future inserts/updates ARE checked against the FK (no new orphans can be created), but existing rows are tolerated.
  // Could be promoted to fully-validated later via `ALTER TABLE ... VALIDATE CONSTRAINT ...` once a remediation plan exists, but that's a separate manual decision.
  // Idempotent: ALTER guarded by EXCEPTION duplicate_object.
  `DO $$ BEGIN ALTER TABLE stock_transfer_items ADD CONSTRAINT stock_transfer_items_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES stock_transfer_vouchers(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4c (May 2026) — containers long-tail FKs (4 children, ALL with orphans → NOT VALID, non-destructive) ──
  // Surveyed: factory_container_commissions (7/18 orphans), factory_fx_allocations (8/23), factory_raw_stock (7/19), import_logs (54/313).
  // All children have pre-existing orphans pointing to deleted container ids. Per user safety mandate ("100% safe, no data loss"),
  // we use NOT VALID for all 4 — existing orphans preserved, future inserts/updates blocked from creating new orphans.
  // RESTRICT on all — containers tie to physical shipments with downstream cost/profit records that must be retained.
  // Idempotent: ALTER guarded by EXCEPTION duplicate_object.
  `DO $$ BEGIN ALTER TABLE factory_container_commissions ADD CONSTRAINT factory_container_commissions_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_fx_allocations ADD CONSTRAINT factory_fx_allocations_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_raw_stock ADD CONSTRAINT factory_raw_stock_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE import_logs ADD CONSTRAINT import_logs_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,

  // ── F-Phase 4b (May 2026) — locations long-tail FKs (14 children: 8 clean + 6 NOT VALID, non-destructive) ──
  // Survey results — orphans/non_null:
  //   CLEAN (0 orphans, fully validated FK): bales.erp_location_id (0/0), employees.sales_bonus_pct_location_id (0/1),
  //     factory_bales.erp_location_id (0/3642), factory_pressing_batches.finalized_location_id (0/0),
  //     location_price_groups.master_location_id (0/0), location_price_groups.follower_location_id (0/0),
  //     pressing_batches.finalized_location_id (0/0), user_company_roles.assigned_location_id (0/14).
  //   ORPHANS (NOT VALID, future-only enforcement):
  //     container_offloads.location_id (55/165), inventory.location_id (14460/17961),
  //     stock_adjustment_vouchers.location_id (53/109), stock_transfer_items.source_location_id (1239/3610),
  //     stock_transfer_vouchers.destination_location_id (128/316), stock_transfer_vouchers.source_location_id (128/314).
  // RESTRICT on all — locations tie to inventory positions, sales records, transfers; deletion must be blocked.
  // Idempotent: ALTER guarded by EXCEPTION duplicate_object. NOT VALID preserves existing orphans.
  // bales.erp_location_id no longer exists in the current schema — only
  // factory_bales carries that column now — so this failed every startup with
  // 'column "erp_location_id" referenced in foreign key constraint does not
  // exist'. Guarded on the column for the same reason as supplier_containers above.
  `DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bales' AND column_name = 'erp_location_id') THEN ALTER TABLE bales ADD CONSTRAINT bales_erp_location_id_fkey FOREIGN KEY (erp_location_id) REFERENCES locations(id) ON DELETE RESTRICT; END IF; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE employees ADD CONSTRAINT employees_sales_bonus_pct_location_id_fkey FOREIGN KEY (sales_bonus_pct_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bales ADD CONSTRAINT factory_bales_erp_location_id_fkey FOREIGN KEY (erp_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pressing_batches ADD CONSTRAINT factory_pressing_batches_finalized_location_id_fkey FOREIGN KEY (finalized_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE location_price_groups ADD CONSTRAINT location_price_groups_master_location_id_fkey FOREIGN KEY (master_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE location_price_groups ADD CONSTRAINT location_price_groups_follower_location_id_fkey FOREIGN KEY (follower_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE pressing_batches ADD CONSTRAINT pressing_batches_finalized_location_id_fkey FOREIGN KEY (finalized_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE user_company_roles ADD CONSTRAINT user_company_roles_assigned_location_id_fkey FOREIGN KEY (assigned_location_id) REFERENCES locations(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE container_offloads ADD CONSTRAINT container_offloads_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory ADD CONSTRAINT inventory_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_adjustment_vouchers ADD CONSTRAINT stock_adjustment_vouchers_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_items ADD CONSTRAINT stock_transfer_items_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES locations(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_vouchers ADD CONSTRAINT stock_transfer_vouchers_destination_location_id_fkey FOREIGN KEY (destination_location_id) REFERENCES locations(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_transfer_vouchers ADD CONSTRAINT stock_transfer_vouchers_source_location_id_fkey FOREIGN KEY (source_location_id) REFERENCES locations(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,

  // ── F-Phase 5 (May 2026) — companies long-tail FKs (137 children: 136 clean + 1 NOT VALID, the "final boss" batch) ──
  // Survey: ALL 137 unenforced company_id children scanned. Surprisingly clean — only ONE child has orphans:
  //   chat_messages (16/141 orphans → NOT VALID).
  // Other 136 children all have ZERO orphans → fully validated FK.
  // RESTRICT on all — companies are tenant roots; deletion must be blocked while ANY child exists.
  // Schema.ts: NOT updated for any of these 137 tables — would create massive churn. Per project convention (replit.md),
  //   schema.ts is "authoritative for clean rebuilds" but the migrations array in server/index.ts is the runtime authority.
  //   Drizzle-kit push is blocked anyway, so schema.ts/DB drift on company_id is intentional and documented.
  //   This is the same pattern used for bales.erp_location_id in F-Phase 4b.
  // Idempotent: ALTER guarded by EXCEPTION duplicate_object. NOT VALID preserves chat_messages orphans.
  `DO $$ BEGIN ALTER TABLE agent_accounts ADD CONSTRAINT agent_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  // Wave 12: audit_log outlives the company it describes (append-only, and an
  // empty company's deletion keeps its audit rows), so it carries no foreign key
  // to companies; any earlier constraint is dropped.
  `ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_company_id_fkey`,
  `DO $$ BEGIN ALTER TABLE bale_label_prints ADD CONSTRAINT bale_label_prints_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_product_categories ADD CONSTRAINT bale_product_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_products ADD CONSTRAINT bale_products_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_recode_sessions ADD CONSTRAINT bale_recode_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_sequences ADD CONSTRAINT bale_sequences_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bale_transfers ADD CONSTRAINT bale_transfers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bales ADD CONSTRAINT bales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE company_settings ADD CONSTRAINT company_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE container_document_types ADD CONSTRAINT container_document_types_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE container_documents ADD CONSTRAINT container_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE container_freight ADD CONSTRAINT container_freight_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE container_freight_payments ADD CONSTRAINT container_freight_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE container_sales ADD CONSTRAINT container_sales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE containers ADD CONSTRAINT containers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_balances ADD CONSTRAINT customer_balances_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_invoice_sequences ADD CONSTRAINT customer_invoice_sequences_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_logos ADD CONSTRAINT customer_logos_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_order_expected_lines ADD CONSTRAINT customer_order_expected_lines_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customer_proformas ADD CONSTRAINT customer_proformas_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE customers ADD CONSTRAINT customers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE dashboard_account_selections ADD CONSTRAINT dashboard_account_selections_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE dashboard_cash_accounts ADD CONSTRAINT dashboard_cash_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE dashboard_payable_accounts ADD CONSTRAINT dashboard_payable_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_advance_repayments ADD CONSTRAINT employee_advance_repayments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_advances ADD CONSTRAINT employee_advances_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_attendance ADD CONSTRAINT employee_attendance_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bale_pct_rates ADD CONSTRAINT employee_bale_pct_rates_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bale_rates ADD CONSTRAINT employee_bale_rates_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_bonuses ADD CONSTRAINT employee_bonuses_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employee_groups ADD CONSTRAINT employee_groups_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE employees ADD CONSTRAINT employees_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE erp_payroll_runs ADD CONSTRAINT erp_payroll_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE erp_user_page_access ADD CONSTRAINT erp_user_page_access_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE erp_worker_docs ADD CONSTRAINT erp_worker_docs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE exchange_rates ADD CONSTRAINT exchange_rates_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_account_whatsapp_rules ADD CONSTRAINT factory_account_whatsapp_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_advance_repayments ADD CONSTRAINT factory_advance_repayments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_alerts ADD CONSTRAINT factory_alerts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_attendance ADD CONSTRAINT factory_attendance_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_cost_snapshots ADD CONSTRAINT factory_bale_cost_snapshots_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_import_batches ADD CONSTRAINT factory_bale_import_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_photos ADD CONSTRAINT factory_bale_photos_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_product_images ADD CONSTRAINT factory_bale_product_images_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_products ADD CONSTRAINT factory_bale_products_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_sequences ADD CONSTRAINT factory_bale_sequences_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bale_waste_dispatches ADD CONSTRAINT factory_bale_waste_dispatches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_bales ADD CONSTRAINT factory_bales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_categories ADD CONSTRAINT factory_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_container_commissions ADD CONSTRAINT factory_container_commissions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_container_other_charges ADD CONSTRAINT factory_container_other_charges_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_container_profit_snapshots ADD CONSTRAINT factory_container_profit_snapshots_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_containers ADD CONSTRAINT factory_containers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_daily_kpi_snapshots ADD CONSTRAINT factory_daily_kpi_snapshots_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_daily_usages ADD CONSTRAINT factory_daily_usages_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_daybook_entries ADD CONSTRAINT factory_daybook_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_duty_audit_log ADD CONSTRAINT factory_duty_audit_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_fx_allocations ADD CONSTRAINT factory_fx_allocations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_fx_rates ADD CONSTRAINT factory_fx_rates_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `ALTER TABLE factory_fx_rates ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'auto'`,
  `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM migrations_log WHERE key = 'accrued-rent-soft-delete-v1') THEN
        -- Wave 16 (A): no longer soft-deletes accounts by name at boot (one with history would leave every report).
        INSERT INTO migrations_log(key) VALUES ('accrued-rent-soft-delete-v1');
      END IF;
    END $$`,
  `DO $$ BEGIN ALTER TABLE factory_invoice_loading_bales ADD CONSTRAINT factory_invoice_loading_bales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_invoice_loading_sessions ADD CONSTRAINT factory_invoice_loading_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_mix_batches ADD CONSTRAINT factory_mix_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_offload_additional_charges ADD CONSTRAINT factory_offload_additional_charges_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_payrolls ADD CONSTRAINT factory_payrolls_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pos_sale_items ADD CONSTRAINT factory_pos_sale_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pos_sales ADD CONSTRAINT factory_pos_sales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_pressing_batches ADD CONSTRAINT factory_pressing_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_production_plans ADD CONSTRAINT factory_production_plans_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_production_sessions ADD CONSTRAINT factory_production_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_raw_material_adjustments ADD CONSTRAINT factory_raw_material_adjustments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_raw_stock ADD CONSTRAINT factory_raw_stock_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_settings ADD CONSTRAINT factory_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_sheets ADD CONSTRAINT factory_sheets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_categories ADD CONSTRAINT factory_supplier_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_fx_transfers ADD CONSTRAINT factory_supplier_fx_transfers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_payments ADD CONSTRAINT factory_supplier_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_supplier_score_snapshots ADD CONSTRAINT factory_supplier_score_snapshots_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_suppliers ADD CONSTRAINT factory_suppliers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_transporter_transactions ADD CONSTRAINT factory_transporter_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_transporters ADD CONSTRAINT factory_transporters_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_user_page_access ADD CONSTRAINT factory_user_page_access_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_user_profiles ADD CONSTRAINT factory_user_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_v3_loads ADD CONSTRAINT factory_v3_loads_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_waste_entries ADD CONSTRAINT factory_waste_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_worker_advances ADD CONSTRAINT factory_worker_advances_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_worker_categories ADD CONSTRAINT factory_worker_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_worker_documents ADD CONSTRAINT factory_worker_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE factory_workers ADD CONSTRAINT factory_workers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE file_folders ADD CONSTRAINT file_folders_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE fiscal_period_closures ADD CONSTRAINT fiscal_period_closures_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE freight_accounts ADD CONSTRAINT freight_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory ADD CONSTRAINT inventory_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE inventory_negative_layers ADD CONSTRAINT inventory_negative_layers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE live_spreadsheets ADD CONSTRAINT live_spreadsheets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE location_price_groups ADD CONSTRAINT location_price_groups_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE locations ADD CONSTRAINT locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE login_history ADD CONSTRAINT login_history_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE mix_batches ADD CONSTRAINT mix_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE pending_barcodes ADD CONSTRAINT pending_barcodes_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE pos_offline_queue ADD CONSTRAINT pos_offline_queue_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE pos_shifts ADD CONSTRAINT pos_shifts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE pressing_batches ADD CONSTRAINT pressing_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE production_bales ADD CONSTRAINT production_bales_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE production_raw_stock ADD CONSTRAINT production_raw_stock_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE proforma_stock_reservations ADD CONSTRAINT proforma_stock_reservations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE property_contracts ADD CONSTRAINT property_contracts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE property_monthly_ledger ADD CONSTRAINT property_monthly_ledger_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE property_payments ADD CONSTRAINT property_payments_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE property_units ADD CONSTRAINT property_units_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE reference_sequences ADD CONSTRAINT reference_sequences_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE rental_auto_transfer_configs ADD CONSTRAINT rental_auto_transfer_configs_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE role_feature_permissions ADD CONSTRAINT role_feature_permissions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE salary_advances ADD CONSTRAINT salary_advances_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE snapshot_pinned_accounts ADD CONSTRAINT snapshot_pinned_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE spreadsheets ADD CONSTRAINT spreadsheets_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_group_location_archives ADD CONSTRAINT stock_group_location_archives_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_groups ADD CONSTRAINT stock_groups_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_item_code_aliases ADD CONSTRAINT stock_item_code_aliases_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE stock_items ADD CONSTRAINT stock_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE stored_files ADD CONSTRAINT stored_files_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE supplier_proformas ADD CONSTRAINT supplier_proformas_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE user_activity_log ADD CONSTRAINT user_activity_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE user_company_roles ADD CONSTRAINT user_company_roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE user_locations ADD CONSTRAINT user_locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE user_presence ADD CONSTRAINT user_presence_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE vouchers ADD CONSTRAINT vouchers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE waste_dispatches ADD CONSTRAINT waste_dispatches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE whatsapp_recipients ADD CONSTRAINT whatsapp_recipients_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE whatsapp_stock_settings ADD CONSTRAINT whatsapp_stock_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE worker_bonuses ADD CONSTRAINT worker_bonuses_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
  `DO $$ BEGIN ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT NOT VALID; EXCEPTION WHEN duplicate_object THEN NULL;  END $$;`,
];
