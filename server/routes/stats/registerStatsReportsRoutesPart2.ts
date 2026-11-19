// Extracted from ./registerStatsReportsRoutesPart1.ts
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { addInventoryValues } from "../../lib/inventoryMath";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { companies, containerOffloads, containers, suppliers, vouchers } from "@shared/schema";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { sumMoney, toMoney } from "../../lib/money";

export function registerStatsReportsRoutesPart2(app: Express) {
  app.get("/api/reports/containers", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { status, supplierId, startDate, endDate, allCompanies, specificCompanyId } = req.query;
      let companyCondition;
      if (allCompanies === "true") {
        const isDeveloper = req.user?.role === "Developer";
        const companyIds = isDeveloper
          ? (await storage.getAllCompanies()).map((company) => company.id)
          : (await storage.getUserCompaniesWithRoles(req.user!.id)).map((membership) => membership.companyId);
        companyCondition =
          companyIds.length > 0 ? inArray(containers.companyId, companyIds) : eq(containers.companyId, companyId);
      } else if (specificCompanyId) {
        const requestedCompanyId = Number(specificCompanyId);
        if (!Number.isInteger(requestedCompanyId) || requestedCompanyId <= 0) {
          return res.status(400).json({ message: "Invalid company selected" });
        }
        if (req.user?.role !== "Developer" && requestedCompanyId !== companyId) {
          const memberships = await storage.getUserCompaniesWithRoles(req.user!.id);
          if (!memberships.some((membership) => membership.companyId === requestedCompanyId)) {
            return res.status(403).json({ message: "No access to the requested company" });
          }
        }
        companyCondition = eq(containers.companyId, requestedCompanyId);
      } else {
        companyCondition = eq(containers.companyId, companyId);
      }
      const conditions = [companyCondition];
      const isOffloaded = (status as string | undefined)?.toLowerCase() === "offloaded";
      if (status) conditions.push(eq(containers.status, isOffloaded ? "OFFLOADED" : (status as string)));
      if (supplierId) conditions.push(eq(containers.supplierId, parseInt(supplierId as string)));
      if (isOffloaded) {
        if (startDate) conditions.push(sql`${containers.offloadDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${containers.offloadDate} <= ${endDate}`);
      } else {
        if (startDate) conditions.push(sql`${containers.importDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${containers.importDate} <= ${endDate}`);
      }
      const containerData = await db
        .select({
          id: containers.id,
          containerNumber: containers.containerNumber,
          supplierId: containers.supplierId,
          supplierName: suppliers.legalName,
          status: containers.status,
          importDate: containers.importDate,
          offloadDate: containers.offloadDate,
          itemsTotal: containers.itemsTotal,
          chargesTotal: containers.chargesTotal,
          grandTotal: containers.grandTotal,
          companyId: containers.companyId,
          companyName: companies.name,
        })
        .from(containers)
        .innerJoin(suppliers, eq(containers.supplierId, suppliers.id))
        .innerJoin(companies, eq(containers.companyId, companies.id))
        .where(and(...conditions))
        .orderBy(
          isOffloaded ? sql`${containers.offloadDate} DESC NULLS LAST` : sql`${containers.importDate} DESC NULLS LAST`
        );
      // Load the most recent offload for each visible container in one batch.
      // Offload total_charges already includes purchase-order charges; the
      // report must add ONLY the offloading portion on top of grandTotal.
      const offloadedIds = containerData
        .filter((container) => container.status === "OFFLOADED")
        .map((container) => container.id);
      const offloadRows = offloadedIds.length
        ? await db
            .select({
              containerId: containerOffloads.containerId,
              duties: containerOffloads.duties,
              officeCharges: containerOffloads.officeCharges,
              transportFees: containerOffloads.transportFees,
              transferCharges: containerOffloads.transferCharges,
              totalCharges: containerOffloads.totalCharges,
            })
            .from(containerOffloads)
            .where(inArray(containerOffloads.containerId, offloadedIds))
            .orderBy(desc(containerOffloads.id))
        : [];
      const offloadsByContainer = new Map<number, (typeof offloadRows)[number]>();
      for (const row of offloadRows) {
        if (!offloadsByContainer.has(row.containerId)) offloadsByContainer.set(row.containerId, row);
      }

      // Active charge vouchers are the same live source used on Offload Detail.
      // A later voucher edit, or a soft-deleted voucher, must be reflected in
      // this read-only report without changing inventory or accounting records.
      // If a particular category has no active voucher, use its persisted
      // offload amount (legacy/offloads with no voucher).
      type ChargePrefix = "DUTY" | "OFFICE" | "TRANS" | "XFER" | "CHG";
      const voucherPrefixes: ChargePrefix[] = ["DUTY", "OFFICE", "TRANS", "XFER", "CHG"];
      const containerLookup = new Map(
        containerData.map((container) => [`${container.companyId}:${container.containerNumber}`, container.id])
      );
      const companyIds = [...new Set(containerData.filter((c) => c.status === "OFFLOADED").map((c) => c.companyId))];
      const activeChargeVouchers = companyIds.length
        ? await db
            .select({
              companyId: vouchers.companyId,
              voucherNumber: vouchers.voucherNumber,
              totalAmount: vouchers.totalAmount,
            })
            .from(vouchers)
            .where(
              and(
                inArray(vouchers.companyId, companyIds),
                isNull(vouchers.deletedAt),
                or(...voucherPrefixes.map((prefix) => like(vouchers.voucherNumber, `${prefix}-%`)))
              )
            )
        : [];
      const voucherAmountsByContainer = new Map<number, Partial<Record<ChargePrefix, string>>>();
      for (const voucher of activeChargeVouchers) {
        const prefix = voucherPrefixes.find((item) => voucher.voucherNumber.startsWith(`${item}-`));
        if (!prefix) continue;
        const suffix = voucher.voucherNumber.slice(prefix.length + 1);
        // CHG-<container>-<id>-<index>, other types -<id>;
        // older rows may have a timestamp suffix instead. Match full container
        // identities, never an ambiguous substring of a container number.
        const candidates =
          prefix === "CHG"
            ? [suffix.replace(/-\\d+-\\d+$/, ""), suffix.replace(/-\\d+$/, "")]
            : [suffix.replace(/-\\d+$/, "")];
        const containerId = candidates
          .filter((candidate) => candidate !== suffix)
          .map((candidate) => containerLookup.get(`${voucher.companyId}:${candidate}`))
          .find((id): id is number => id !== undefined);
        if (containerId === undefined || !offloadsByContainer.has(containerId)) continue;
        const byType = voucherAmountsByContainer.get(containerId) ?? {};
        byType[prefix] = sumMoney([byType[prefix], voucher.totalAmount]).toFixed(2);
        voucherAmountsByContainer.set(containerId, byType);
      }

      const reportContainers = containerData.map((container) => {
        const offload = offloadsByContainer.get(container.id);
        const active = voucherAmountsByContainer.get(container.id);
        const zero = "0.00";
        const persistedExtras = offload
          ? toMoney(offload.totalCharges)
              .minus(toMoney(container.chargesTotal))
              .minus(sumMoney([offload.duties, offload.officeCharges, offload.transportFees, offload.transferCharges]))
              .toFixed(2)
          : zero;
        const chargeBreakdown = {
          duties: active?.DUTY ?? offload?.duties ?? zero,
          officeCharges: active?.OFFICE ?? offload?.officeCharges ?? zero,
          transportFees: active?.TRANS ?? offload?.transportFees ?? zero,
          transferCharges: active?.XFER ?? offload?.transferCharges ?? zero,
          additionalCharges: active?.CHG ?? persistedExtras,
        };
        const offloadingCharges = sumMoney(Object.values(chargeBreakdown)).toFixed(2);
        return {
          ...container,
          offloadingCharges,
          chargeBreakdown,
          totalContainerCost: sumMoney([container.grandTotal, offloadingCharges]).toFixed(2),
        };
      });
      res.json({
        containers: reportContainers,
        summary: {
          totalContainers: reportContainers.length,
          totalItemsTotal: addInventoryValues(...reportContainers.map((container) => container.itemsTotal)).toNumber(),
          totalChargesTotal: addInventoryValues(
            ...reportContainers.map((container) => container.chargesTotal)
          ).toNumber(),
          totalGrandTotal: addInventoryValues(...reportContainers.map((container) => container.grandTotal)).toNumber(),
          totalOffloadingCharges: addInventoryValues(
            ...reportContainers.map((container) => container.offloadingCharges)
          ).toNumber(),
          totalContainerCost: addInventoryValues(
            ...reportContainers.map((container) => container.totalContainerCost)
          ).toNumber(),
        },
        filters: {
          status: status || null,
          supplierId: supplierId || null,
          startDate: startDate || null,
          endDate: endDate || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
