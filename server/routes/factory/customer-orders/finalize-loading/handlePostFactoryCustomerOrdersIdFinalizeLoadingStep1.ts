// Extracted from ./registerOrderLoadingRoutesPart2.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getClientDate } from "../../../../lib/dateUtils";

export function handlePostFactoryCustomerOrdersIdFinalizeLoadingStep1(req: Request, res: Response) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const orderId = parseId(req.params.id);
  if (orderId === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };
  // Keep accepting the legacy flag so an older browser bundle still gets
  // the new carried-over-proforma behavior after the server is deployed.
  const createCarryoverProforma = req.body?.createCarryoverProforma === true || req.body?.createContinuation === true;
  // This is a separate workflow: keep the reusable proforma active and open
  // an empty loading, rather than splitting/deactivating the source proforma.
  const createNextLoading = req.body?.createNextLoading === true;
  if (createNextLoading && createCarryoverProforma) {
    return {
      done: true as const,
      value: res.status(400).json({ message: "Choose either a new loading or legacy proforma carryover" }),
    };
  }

  // The date selected in Validate & Finalize is the business-effective date.
  // Keep a separate actual timestamp for audit/update bookkeeping.
  const overrideLoadingDate = req.body?.overrideLoadingDate === true;
  // Older clients may send today's date on resubmission. Never silently
  // change the original completion date without a deliberate user edit.
  if (overrideLoadingDate && (typeof req.body?.txDate !== "string" || !req.body.txDate)) {
    return {
      done: true as const,
      value: res.status(400).json({ message: "Select a loading date to change the original date" }),
    };
  }
  const txDate = req.body?.txDate || getClientDate(req);
  if (
    typeof txDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(txDate) ||
    Number.isNaN(Date.parse(txDate)) ||
    new Date(`${txDate}T12:00:00.000Z`).toISOString().slice(0, 10) !== txDate
  ) {
    return {
      done: true as const,
      value: res.status(400).json({ message: "Invalid finalization date (expected YYYY-MM-DD)" }),
    };
  }
  const effectiveFinalizedAt = new Date(`${txDate}T12:00:00.000Z`);
  return {
    done: false as const,
    companyId,
    createCarryoverProforma,
    createNextLoading,
    effectiveFinalizedAt,
    orderId,
    overrideLoadingDate,
    txDate,
  };
}
