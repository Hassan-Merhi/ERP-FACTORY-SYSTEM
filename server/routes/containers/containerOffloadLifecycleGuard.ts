import type { Express, NextFunction, Request, Response } from "express";
import { pool } from "../../db";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  collectContainerOffloadAdditionalChargeLedgerIds,
  collectContainerOffloadLedgerIds,
  collectContainerOffloadParentAgentIds,
} from "../../services/containers/containerOffloadLifecyclePolicy";

interface LedgerSnapshot {
  id: number;
  account_type: string | null;
  name: string | null;
}

const OFFICE_INVALID_ACCOUNT_TYPES = new Set([
  "Expense",
  "Direct Expense",
  "Indirect Expense",
  "Income",
  "Liability",
  "Current Liability",
  "Profit",
  "Government Taxes",
  "COGS",
]);

function uniquePositiveIds(values: unknown[]): number[] {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort(
    (left, right) => left - right
  );
}

async function guardContainerOffload(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = Number(req.session?.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(400).json({ message: "No company selected" });
    return;
  }

  const containerId = Number(req.params.id);
  if (!Number.isInteger(containerId) || containerId <= 0) {
    res.status(400).json({ message: "Invalid id" });
    return;
  }

  const locationId = Number(req.body?.locationId);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    res.status(400).json({ message: "Location is required" });
    return;
  }

  const client = await pool.connect();
  let released = false;
  let transactionOpen = false;

  const release = async (commit: boolean) => {
    if (released) return;
    released = true;

    try {
      if (transactionOpen) {
        await client.query(commit ? "COMMIT" : "ROLLBACK");
        transactionOpen = false;
      }
    } catch (error) {
      logger.warn("Container offload preflight transaction cleanup failed", {
        companyId,
        containerId,
        commit,
        error,
      });
    }

    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [companyId, containerId]);
    } catch (error) {
      logger.warn("Container offload advisory unlock failed", { companyId, containerId, error });
    } finally {
      client.release();
    }
  };

  try {
    const lockResult = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [
      companyId,
      containerId,
    ]);
    if (!lockResult.rows[0]?.locked) {
      client.release();
      released = true;
      res.status(409).json({
        code: "CONTAINER_OFFLOAD_IN_PROGRESS",
        message: "This container is currently being offloaded or edited. Wait for the first request to finish.",
      });
      return;
    }

    await client.query("BEGIN");
    transactionOpen = true;

    res.once("finish", () => void release(true));
    res.once("close", () => void release(false));

    const containerResult = await client.query<{ id: number; status: string; company_id: number }>(
      `SELECT id, status, company_id
       FROM containers
       WHERE id = $1 AND company_id = $2
       LIMIT 1
       FOR KEY SHARE`,
      [containerId, companyId]
    );
    const container = containerResult.rows[0];
    if (!container) {
      res.status(404).json({ message: "Container not found for the selected company" });
      return;
    }
    if (container.status !== "OTW" && container.status !== "OFFLOADED") {
      res.status(409).json({
        code: "CONTAINER_NOT_OFFLOADABLE",
        message: `Container status ${container.status} cannot be offloaded.`,
      });
      return;
    }

    const locationResult = await client.query<{ id: number }>(
      `SELECT id
       FROM locations
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
       LIMIT 1
       FOR SHARE`,
      [locationId, companyId]
    );
    if (!locationResult.rows[0]) {
      res.status(400).json({ message: "Invalid location for the selected company" });
      return;
    }

    const purchaseOrders = await client.query<{
      id: number;
      freight_paid_by: string | null;
      freight_own_account_id: number | null;
      freight_parent_account_id: number | null;
    }>(
      `SELECT id, freight_paid_by, freight_own_account_id, freight_parent_account_id
       FROM purchase_orders
       WHERE container_id = $1 AND company_id = $2
       ORDER BY id
       FOR SHARE`,
      [containerId, companyId]
    );

    if (purchaseOrders.rows.length === 0) {
      res.status(400).json({ message: "Container has no purchase orders to offload" });
      return;
    }

    const purchaseOrderIds = purchaseOrders.rows.map((row) => Number(row.id));
    const lineItems = await client.query<{ id: number }>(
      `SELECT id
       FROM po_line_items
       WHERE po_id = ANY($1::int[])
       ORDER BY id
       FOR SHARE`,
      [purchaseOrderIds]
    );
    if (lineItems.rows.length === 0) {
      res.status(400).json({ message: "Container purchase orders have no line items" });
      return;
    }

    const requestedLedgerIds = collectContainerOffloadLedgerIds(req.body ?? {});
    let ledgerSnapshots: LedgerSnapshot[] = [];
    if (requestedLedgerIds.length > 0) {
      const ledgerResult = await client.query<LedgerSnapshot>(
        `SELECT id, account_type, name
         FROM ledger_accounts
         WHERE company_id = $1
           AND id = ANY($2::int[])
           AND deleted_at IS NULL
         ORDER BY id
         FOR SHARE`,
        [companyId, requestedLedgerIds]
      );
      ledgerSnapshots = ledgerResult.rows;
      const foundIds = new Set(ledgerSnapshots.map((row) => Number(row.id)));
      const missingId = requestedLedgerIds.find((id) => !foundIds.has(id));
      if (missingId) {
        res.status(400).json({ message: `Ledger account #${missingId} not found for the selected company` });
        return;
      }
    }

    const accountById = new Map(ledgerSnapshots.map((row) => [Number(row.id), row]));
    const officeCharges = Number(req.body?.officeCharges ?? 0);
    const officeChargesAccountId = Number(req.body?.officeChargesAccountId);
    if (Number.isFinite(officeCharges) && officeCharges > 0 && Number.isInteger(officeChargesAccountId)) {
      const account = accountById.get(officeChargesAccountId);
      if (!account || OFFICE_INVALID_ACCOUNT_TYPES.has(account.account_type ?? "")) {
        res.status(400).json({
          message: `Office charges account "${account?.name ?? `ID ${officeChargesAccountId}`}" has an invalid account type. It must be an Asset-type account.`,
        });
        return;
      }
    }

    const additionalLedgerIds = new Set(collectContainerOffloadAdditionalChargeLedgerIds(req.body ?? {}));
    for (const ledgerId of additionalLedgerIds) {
      const account = accountById.get(ledgerId);
      if (!account) continue;
      if (account.account_type === "Direct Expense" || account.account_type === "Indirect Expense") {
        res.status(400).json({
          message: `Additional charges cannot credit the "${account.name ?? `ID ${ledgerId}`}" expense account.`,
        });
        return;
      }
    }

    const ownFreightAccountIds = uniquePositiveIds(
      purchaseOrders.rows.filter((row) => row.freight_paid_by === "own").map((row) => row.freight_own_account_id)
    );
    if (ownFreightAccountIds.length > 0) {
      const ownRows = await client.query<{ id: number }>(
        `SELECT id
         FROM ledger_accounts
         WHERE company_id = $1
           AND id = ANY($2::int[])
           AND deleted_at IS NULL
         ORDER BY id
         FOR SHARE`,
        [companyId, ownFreightAccountIds]
      );
      const foundIds = new Set(ownRows.rows.map((row) => Number(row.id)));
      const missingId = ownFreightAccountIds.find((id) => !foundIds.has(id));
      if (missingId) {
        res.status(400).json({ message: `Own-account freight ledger #${missingId} is unavailable` });
        return;
      }
    }

    const parentResult = await client.query<{ parent_company_id: number | null }>(
      "SELECT parent_company_id FROM companies WHERE id = $1 LIMIT 1",
      [companyId]
    );
    const explicitParentCompanyId = Number(parentResult.rows[0]?.parent_company_id);
    const parentCompanyId =
      Number.isInteger(explicitParentCompanyId) && explicitParentCompanyId > 0 ? explicitParentCompanyId : null;

    const parentAgentIds = collectContainerOffloadParentAgentIds(req.body ?? {});
    if (parentAgentIds.length > 0 && parentCompanyId) {
      const parentAgentRows = await client.query<{ id: number }>(
        `SELECT id
         FROM ledger_accounts
         WHERE company_id = $1
           AND id = ANY($2::int[])
           AND deleted_at IS NULL
         ORDER BY id
         FOR SHARE`,
        [parentCompanyId, parentAgentIds]
      );
      const foundIds = new Set(parentAgentRows.rows.map((row) => Number(row.id)));
      const missingId = parentAgentIds.find((id) => !foundIds.has(id));
      if (missingId) {
        res.status(400).json({ message: `Parent-agent ledger #${missingId} is unavailable` });
        return;
      }
    }

    const parentFreightAccountIds = uniquePositiveIds(
      purchaseOrders.rows.filter((row) => row.freight_paid_by === "parent").map((row) => row.freight_parent_account_id)
    );
    // Parent-paid freight account ownership belongs to the PO accounting workflow,
    // not to the atomic inventory offload lifecycle. Older POs can retain a stale
    // freight_parent_account_id after company/account changes. The central offload
    // service does not post to this account, so keep this lookup as diagnostics but
    // never block a valid inventory offload because of legacy freight metadata.
    if (parentFreightAccountIds.length > 0 && parentCompanyId) {
      const validCompanyIds = uniquePositiveIds([companyId, parentCompanyId]);
      const parentFreightRows = await client.query<{ id: number }>(
        `SELECT id
         FROM ledger_accounts
         WHERE company_id = ANY($1::int[])
           AND id = ANY($2::int[])
           AND deleted_at IS NULL
         ORDER BY id
         FOR SHARE`,
        [validCompanyIds, parentFreightAccountIds]
      );
      const foundIds = new Set(parentFreightRows.rows.map((row) => Number(row.id)));
      const missingId = parentFreightAccountIds.find((id) => !foundIds.has(id));
      if (missingId) {
        logger.warn("Container offload ignored stale parent-paid freight ledger metadata", {
          companyId,
          parentCompanyId,
          containerId,
          missingLedgerId: missingId,
        });
      }
    }

    // Keep the session-level advisory lock through the response, but release all
    // row/table locks taken during preflight before the lifecycle service opens
    // its own atomic transaction. Otherwise this connection's FOR KEY SHARE on
    // the container blocks the lifecycle's FOR UPDATE and the request self-times
    // out. The advisory lock still serializes concurrent offload/edit requests
    // for the same company/container across the handoff.
    await client.query("COMMIT");
    transactionOpen = false;

    next();
  } catch (error: unknown) {
    await release(false);
    logger.error("Container offload lifecycle preflight failed", { companyId, containerId, error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerContainerOffloadLifecycleGuard(app: Express): void {
  app.post("/api/containers/:id/offload", requireAuth, requireNonPOS, (req, res, next) => {
    void guardContainerOffload(req, res, next);
  });

  app.patch("/api/containers/:id/offload", requireAuth, requireRole("Admin"), (req, res, next) => {
    void guardContainerOffload(req, res, next);
  });
}
