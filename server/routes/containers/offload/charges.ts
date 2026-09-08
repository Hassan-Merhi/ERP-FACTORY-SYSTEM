/**
 * containerOffloadRoutes: ContainerOffloadCharge endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { containers, containerOffloads, vouchers, voucherEntries, locations, ledgerAccounts } from "@shared/schema";
import { eq, and, or, sql, like, ilike } from "drizzle-orm";

export function registerContainerOffloadChargeRoutes(app: Express) {
  // ── Offload charges summary (duties + transport + office) with account names ──
  app.get(
    "/api/containers/:id/offload-charges",
    requireAuth,
    requireNonPOS,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const containerId = parseId(req.params.id);
        if (containerId === null) return res.status(400).json({ message: "Invalid id" });

        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        // Get the offload record along with container + location details
        const [offloadRow] = await db
          .select({
            duties: containerOffloads.duties,
            officeCharges: containerOffloads.officeCharges,
            transferCharges: containerOffloads.transferCharges,
            transportFees: containerOffloads.transportFees,
            totalCharges: containerOffloads.totalCharges,
            offloadedAt: containerOffloads.offloadedAt,
            locationName: locations.name,
            containerNumber: containers.containerNumber,
          })
          .from(containerOffloads)
          .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
          .leftJoin(locations, eq(containerOffloads.locationId, locations.id))
          .where(and(eq(containerOffloads.containerId, containerId), eq(containers.companyId, companyId)))
          .limit(1);

        if (!offloadRow) return res.status(404).json({ message: "No offload record found" });

        // Get credit entries from DUTY-*, TRANS-*, OFFICE-* vouchers for this container.
        // The credit side shows which account was paid into (duty agent, transporter, etc.)
        const containerPattern = `%container ${offloadRow.containerNumber}%`;
        const accountRows = await db
          .select({
            voucherNumber: vouchers.voucherNumber,
            accountName: ledgerAccounts.name,
            creditAmount: voucherEntries.creditAmount,
          })
          .from(vouchers)
          .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              or(
                like(vouchers.voucherNumber, "DUTY-%"),
                like(vouchers.voucherNumber, "TRANS-%"),
                like(vouchers.voucherNumber, "OFFICE-%")
              ),
              ilike(vouchers.description, containerPattern),
              sql`${voucherEntries.creditAmount}::numeric > 0`
            )
          );

        const dutiesAccount = accountRows.find((r) => r.voucherNumber.startsWith("DUTY-"));
        const transAccount = accountRows.find((r) => r.voucherNumber.startsWith("TRANS-"));
        const officeAccount = accountRows.find((r) => r.voucherNumber.startsWith("OFFICE-"));

        const allCharges = [
          {
            label: "Duties",
            amount: parseFloat(offloadRow.duties || "0"),
            accountName: dutiesAccount?.accountName ?? null,
          },
          {
            label: "Transport Fees",
            amount: parseFloat(offloadRow.transportFees || "0"),
            accountName: transAccount?.accountName ?? null,
          },
          {
            label: "Office Charges",
            amount: parseFloat(offloadRow.officeCharges || "0"),
            accountName: officeAccount?.accountName ?? null,
          },
          { label: "Transfer Charges", amount: parseFloat(offloadRow.transferCharges || "0"), accountName: null },
        ].filter((c) => c.amount > 0);

        res.json({
          containerNumber: offloadRow.containerNumber,
          offloadedAt: offloadRow.offloadedAt,
          locationName: offloadRow.locationName,
          charges: allCharges,
          totalCharges: parseFloat(offloadRow.totalCharges || "0"),
        });
      } catch (err: unknown) {
        logger.error("[offload-charges]", { error: getErrorMessage(err) });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
