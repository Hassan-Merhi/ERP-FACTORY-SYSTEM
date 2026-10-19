/**
 * Shared, company-scoped DISPLAY layout for ledger accounts.
 * This table is deliberately separate from ledger_accounts: grouping and sorting
 * must never affect vouchers, account balances, accountType or Net Position math.
 */
import type { Express, Request } from "express";
import { pool } from "../db";
import { requireAuth, requireRole } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";

type LayoutNode = {
  key: string;
  type: "group" | "ledger";
  name: string | null;
  parentKey: string | null;
  order: number;
};

function parseNodes(raw: unknown): LayoutNode[] {
  if (!Array.isArray(raw) || raw.length > 3000) throw new Error("Invalid layout size");
  const keys = new Set<string>();
  const nodes: LayoutNode[] = raw.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid layout node");
    const n = entry as Record<string, unknown>;
    if (typeof n.key !== "string" || keys.has(n.key)) throw new Error("Duplicate or invalid layout key");
    keys.add(n.key);
    if (n.type !== "group" && n.type !== "ledger") throw new Error("Invalid layout node type");
    if (!Number.isInteger(n.order) || (n.order as number) < 0 || (n.order as number) > 1000000) {
      throw new Error("Invalid account order");
    }
    if (n.type === "group") {
      if (
        !/^group:[A-Za-z0-9-]{8,60}$/.test(n.key) ||
        typeof n.name !== "string" ||
        !n.name.trim() ||
        n.name.trim().length > 120 ||
        n.parentKey != null
      )
        throw new Error("Invalid group");
      return { key: n.key, type: "group", name: n.name.trim(), parentKey: null, order: n.order as number };
    }
    if (
      !/^ledger:[1-9]\d*$/.test(n.key) ||
      n.name != null ||
      (n.parentKey != null && typeof n.parentKey !== "string")
    ) {
      throw new Error("Invalid ledger layout entry");
    }
    return {
      key: n.key,
      type: "ledger",
      name: null,
      parentKey: (n.parentKey as string | null) ?? null,
      order: n.order as number,
    };
  });
  const groups = new Set(nodes.filter((n) => n.type === "group").map((n) => n.key));
  for (const node of nodes) {
    if (node.parentKey && !groups.has(node.parentKey)) throw new Error("Group does not exist in layout");
  }
  return nodes;
}

function resolveLayoutCompany(req: Request): number | undefined {
  return req.path.startsWith("/api/factory/") ? req.session.factoryCompanyId : req.session.currentCompanyId;
}

export function registerAccountDisplayLayoutRoutes(app: Express) {
  for (const path of ["/api/accounts/display-layout", "/api/factory/account-display-layout"]) {
    app.get(path, requireAuth, async (req, res) => {
      const companyId = resolveLayoutCompany(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      try {
        const result = await pool.query(
          `SELECT node_key AS key, node_type AS type, name,
                parent_key AS "parentKey", sort_order AS "order"
           FROM account_display_layout WHERE company_id = $1
           ORDER BY sort_order, node_key`,
          [companyId]
        );
        // Existing Account Groups are real ledger parent records. Preserve their
        // accounting meaning, but reuse their parent/child relationship as a
        // presentation-only group when no explicit display layout exists yet.
        const ledger = await pool.query(
          `SELECT id, name, parent_id AS "parentId", sub_type AS "subType"
           FROM ledger_accounts
           WHERE company_id = $1 AND deleted_at IS NULL AND active = TRUE
           ORDER BY name, id`,
          [companyId]
        );
        const effective: LayoutNode[] = (result.rows as LayoutNode[]).map((n) => ({ ...n }));
        const storedKeys = new Set(effective.map((n) => n.key));
        const parentIds = new Set<number>(ledger.rows.filter((a) => a.parentId != null).map((a) => Number(a.parentId)));
        const legacyGroups = ledger.rows.filter((a) => a.subType === "Group" || parentIds.has(Number(a.id)));
        legacyGroups.forEach((a, i) => {
          const key = `group:legacy-${a.id}`;
          if (!storedKeys.has(key)) {
            effective.push({ key, type: "group", name: a.name, parentKey: null, order: 500000 + i });
            storedKeys.add(key);
          }
        });
        const legacyIds = new Set(legacyGroups.map((a) => Number(a.id)));
        ledger.rows.forEach((a, i) => {
          const key = `ledger:${a.id}`;
          if (storedKeys.has(key)) return;
          const parentKey =
            a.parentId != null && legacyIds.has(Number(a.parentId)) ? `group:legacy-${a.parentId}` : null;
          effective.push({ key, type: "ledger", name: null, parentKey, order: 10000 + i });
        });
        return res.json({ nodes: effective });
      } catch (error) {
        return res
          .status(503)
          .json({
            message: "Account layout is not available. Apply the account_display_layout migration.",
            detail: getErrorMessage(error),
          });
      }
    });

    app.put(path, requireAuth, requireRole("Admin"), async (req, res) => {
      const companyId = resolveLayoutCompany(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      let nodes: LayoutNode[];
      try {
        nodes = parseNodes(req.body?.nodes);
      } catch (error) {
        return res.status(400).json({ message: getErrorMessage(error) });
      }

      const ledgerIds = nodes.filter((n) => n.type === "ledger").map((n) => Number(n.key.slice(7)));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize layout writers per company to prevent overlapping DELETE+INSERT saves.
        await client.query("SELECT pg_advisory_xact_lock(42812, $1)", [companyId]);
        if (ledgerIds.length) {
          const valid = await client.query(
            "SELECT id FROM ledger_accounts WHERE company_id = $1 AND deleted_at IS NULL AND id = ANY($2::int[])",
            [companyId, ledgerIds]
          );
          if (valid.rows.length !== ledgerIds.length) {
            await client.query("ROLLBACK");
            return res
              .status(400)
              .json({ message: "Layout contains an account outside this company or an account that was deleted" });
          }
        }
        await client.query("DELETE FROM account_display_layout WHERE company_id = $1", [companyId]);
        if (nodes.length) {
          const params: (number | string | null)[] = [];
          const placeholders = nodes.map((n, i) => {
            const k = i * 6;
            params.push(companyId, n.key, n.type, n.name, n.parentKey, n.order);
            return `($${k + 1}, $${k + 2}, $${k + 3}, $${k + 4}, $${k + 5}, $${k + 6})`;
          });
          await client.query(
            `INSERT INTO account_display_layout (company_id, node_key, node_type, name, parent_key, sort_order)
           VALUES ${placeholders.join(", ")}`,
            params
          );
        }
        await client.query("COMMIT");
        return res.json({ nodes });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return res.status(500).json({ message: getErrorMessage(error) });
      } finally {
        client.release();
      }
    });
  }
}
