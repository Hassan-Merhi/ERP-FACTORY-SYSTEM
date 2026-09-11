import type { Express } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { getAccessibleCompanyIds } from "../security/companyAccessBoundary";
import { poLineItems, purchaseOrders, voucherEntries, vouchers } from "@shared/schema";

/**
 * Cross-company dashboard container tracking report.
 *
 * Extracted from reportsRoutesLegacy.ts without changing the route, access
 * checks, grouping rules, balance calculations, or response contract.
 */
export function registerReportsContainerTrackingRoutes(app: Express) {
  app.get("/api/dashboard/container-tracking", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      const companyIds = Array.from(await getAccessibleCompanyIds(userId));

      if (companyIds.length === 0) {
        return res.json({
          containers: [],
          byRoute: {},
          byAgent: {},
          byLocation: {},
          byTransporter: {},
          totals: { count: 0, amount: 0 },
        });
      }

      const [allCompanies, allSuppliers] = await Promise.all([storage.getAllCompanies(), storage.getAllSuppliers()]);
      const companyMap = new Map(allCompanies.map((company) => [company.id, company]));
      const supplierMap = new Map(allSuppliers.map((supplier) => [supplier.id, supplier]));

      type TrackedContainer = Awaited<ReturnType<typeof storage.getAllContainers>>[number] & {
        companyName: string;
        companyCode: string;
        supplierName: string;
        itemCount: number;
      };

      const otwContainers: TrackedContainer[] = [];
      const offloadedContainers: TrackedContainer[] = [];
      const containerItemCounts: Record<number, number> = {};

      for (const companyId of companyIds) {
        const companyContainers = await storage.getAllContainers(companyId);
        const containerIds = companyContainers.map((container) => container.id);

        if (containerIds.length > 0) {
          const posByContainer = await db
            .select({ containerId: purchaseOrders.containerId, poId: purchaseOrders.id })
            .from(purchaseOrders)
            .where(inArray(purchaseOrders.containerId, containerIds));

          const poIds = posByContainer.map((purchaseOrder) => purchaseOrder.poId);
          if (poIds.length > 0) {
            const lineItemCounts = await db
              .select({
                purchaseOrderId: poLineItems.poId,
                count: sql`count(*)`,
              })
              .from(poLineItems)
              .where(inArray(poLineItems.poId, poIds))
              .groupBy(poLineItems.poId);

            const poCountMap = new Map(
              lineItemCounts
                .filter((lineItem) => lineItem.purchaseOrderId != null)
                .map((lineItem) => [lineItem.purchaseOrderId, Number(lineItem.count)])
            );

            for (const purchaseOrder of posByContainer) {
              const containerId = purchaseOrder.containerId as number;
              containerItemCounts[containerId] =
                (containerItemCounts[containerId] || 0) + (poCountMap.get(purchaseOrder.poId) || 0);
            }
          }
        }

        companyContainers.forEach((container) => {
          const enrichedContainer = {
            ...container,
            companyName: companyMap.get(container.companyId)?.name || "Unknown",
            companyCode: companyMap.get(container.companyId)?.code || "",
            supplierName: supplierMap.get(container.supplierId)?.legalName || "Unknown",
            itemCount: containerItemCounts[container.id] || 0,
          };

          if (container.status === "OFFLOADED") {
            offloadedContainers.push(enrichedContainer);
          } else if (container.status === "OTW") {
            otwContainers.push(enrichedContainer);
          }
        });
      }

      const agentBalances: Record<string, number> = {};
      const uniqueAgents = new Set<string>();
      otwContainers.forEach((container) => {
        if (container.agent) uniqueAgents.add(container.agent);
      });

      for (const companyId of companyIds) {
        const companyLedgerAccounts = await storage.getAllLedgerAccounts(companyId);
        for (const agent of uniqueAgents) {
          const agentAccount = companyLedgerAccounts.find(
            (account) =>
              (account.name || "").toLowerCase().includes((agent || "").toLowerCase()) ||
              (agent || "").toLowerCase().includes((account.name || "").toLowerCase())
          );

          if (!agentAccount) continue;

          const entries = await db
            .select({
              debitAmount: voucherEntries.debitAmount,
              creditAmount: voucherEntries.creditAmount,
            })
            .from(voucherEntries)
            .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
            .where(
              and(
                eq(voucherEntries.ledgerAccountId, agentAccount.id),
                eq(vouchers.companyId, companyId),
                eq(vouchers.optional, false)
              )
            );

          let balance = parseFloat(agentAccount.openingBalance || "0");
          if (agentAccount.openingBalanceSide === "Cr") balance = -balance;

          for (const entry of entries) {
            balance += parseFloat(entry.debitAmount || "0") - parseFloat(entry.creditAmount || "0");
          }

          agentBalances[agent] = (agentBalances[agent] || 0) + balance;
        }
      }

      const byRoute: Record<string, TrackedContainer[]> = {};
      const byAgent: Record<
        string,
        {
          containers: TrackedContainer[];
          offloadedContainers: TrackedContainer[];
          total: number;
          offloadedTotal: number;
          balance: number;
        }
      > = {};
      const byLocation: Record<string, { count: number; total: number }> = {};
      let totalAmount = 0;

      for (const container of offloadedContainers) {
        const agent = container.agent || "Unassigned";
        if (!byAgent[agent]) {
          byAgent[agent] = {
            containers: [],
            offloadedContainers: [],
            total: 0,
            offloadedTotal: 0,
            balance: agentBalances[agent] || 0,
          };
        }
        byAgent[agent].offloadedContainers.push(container);
        byAgent[agent].offloadedTotal += parseFloat(container.dutyFee || "0");
      }

      for (const container of otwContainers) {
        const hasPlate = container.numberPlate && container.numberPlate.trim() !== "";
        const route = container.shopName || "Unassigned";
        const agent = container.agent || "Unassigned";
        const location = container.trackingLocation || "Unknown";
        const amount = parseFloat(container.grandTotal || "0");

        if (!byRoute[route]) byRoute[route] = [];
        byRoute[route].push(container);

        if (hasPlate) {
          if (!byAgent[agent]) {
            byAgent[agent] = {
              containers: [],
              offloadedContainers: [],
              total: 0,
              offloadedTotal: 0,
              balance: agentBalances[agent] || 0,
            };
          }
          byAgent[agent].containers.push(container);
          byAgent[agent].total += amount;
        }

        if (!byLocation[location]) byLocation[location] = { count: 0, total: 0 };
        byLocation[location].count++;
        byLocation[location].total += amount;
        totalAmount += amount;
      }

      const byTransporter: Record<
        string,
        { otw: unknown[]; offloaded: unknown[]; otwTotal: number; offloadedTotal: number }
      > = {};

      for (const container of otwContainers) {
        const transporter = container.transporter || "Unassigned";
        if (!byTransporter[transporter]) {
          byTransporter[transporter] = { otw: [], offloaded: [], otwTotal: 0, offloadedTotal: 0 };
        }
        byTransporter[transporter].otw.push(container);
        byTransporter[transporter].otwTotal += parseFloat(container.transportFee || "0");
      }

      for (const container of offloadedContainers) {
        const transporter = container.transporter || "Unassigned";
        if (!byTransporter[transporter]) {
          byTransporter[transporter] = { otw: [], offloaded: [], otwTotal: 0, offloadedTotal: 0 };
        }
        byTransporter[transporter].offloaded.push(container);
        byTransporter[transporter].offloadedTotal += parseFloat(container.transportFee || "0");
      }

      const totalItems = otwContainers.reduce((sum, container) => sum + (container.itemCount || 0), 0);

      res.json({
        containers: otwContainers,
        byRoute,
        byAgent,
        byLocation,
        byTransporter,
        totals: { count: otwContainers.length, amount: totalAmount, totalItems },
      });
    } catch (error: unknown) {
      logger.error("Dashboard container tracking error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
