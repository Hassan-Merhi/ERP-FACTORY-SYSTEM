// Extracted from ./intercompanyNotificationRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { dispatchNotification } from "../lib/notificationService";
import { intercompanyAccountLinks, intercompanyPaymentRequests } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
export { registerIntercompanyNotificationRoutesPart1 } from "./triggerIntercompanyNotificationsHelpers";

// ── Helper: fire-and-forget intercompany notification trigger ────────────────
// Call after a voucher is successfully saved. Checks if any ledger entry in
// the new voucher matches a source account in intercompany_account_links.
// Never throws — errors are logged and swallowed so the voucher save succeeds.
export async function triggerIntercompanyNotifications(
  companyId: number,
  voucherId: number,
  voucherNumber: string,
  voucherDate: string,
  amount: string,
  description: string | null,
  entryLedgerAccountIds: (number | null)[],
  voucherType?: string
) {
  try {
    // Only trigger for Payment and Receipt vouchers — other types (Journal, Sales, etc.)
    // touch intercompany ledgers in ways that don't represent a cross-company payment
    if (voucherType && voucherType !== "Payment" && voucherType !== "Receipt") return;

    const ledgerIds = entryLedgerAccountIds.filter((id): id is number => id !== null && id !== undefined);
    if (ledgerIds.length === 0) return;

    // Find any intercompany links where source matches this company + one of the ledger accounts
    const links = await db
      .select()
      .from(intercompanyAccountLinks)
      .where(
        and(
          eq(intercompanyAccountLinks.sourceCompanyId, companyId),
          eq(intercompanyAccountLinks.active, true),
          inArray(intercompanyAccountLinks.sourceLedgerAccountId, ledgerIds)
        )
      );

    if (links.length === 0) return;

    for (const link of links) {
      // Insert one pending request per matching link
      const [inserted] = await db
        .insert(intercompanyPaymentRequests)
        .values({
          linkId: link.id,
          fromCompanyId: companyId,
          fromVoucherId: voucherId,
          fromVoucherNumber: voucherNumber,
          fromVoucherDate: voucherDate,
          amount,
          description: description || null,
          status: "pending",
        })
        .returning({ id: intercompanyPaymentRequests.id });

      // Dispatch INTERCOMPANY_REQUEST notification via the unified notification system
      dispatchNotification({
        eventType: "INTERCOMPANY_REQUEST",
        title: "Intercompany Payment Request",
        message: `Payment request from voucher ${voucherNumber} — ${description || ""}`.trim().replace(/—\s*$/, ""),
        entityType: "intercompany_payment_request",
        entityId: inserted?.id,
        companyId,
      }).catch(() => {});
    }
  } catch (err: unknown) {
    logger.error("[IntercompanyNotif] trigger failed (non-fatal):", { error: getErrorMessage(err) });
  }
}
