import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GoldenCoastPhase5SaleError,
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5SaleDigest,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
} from "../../services/accounting/goldenCoastPhase5PosSale";
import {
  GoldenCoastPhase6DeductionError,
  buildGoldenCoastPhase6SpecialLocationDeductionPosting,
  planGoldenCoastPhase6SpecialLocationDeduction,
} from "../../services/accounting/goldenCoastPhase6SpecialLocationDeduction";
import { GoldenCoastPhase7TransferError } from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { GOLDEN_COAST_CUTOVER_DATE } from "../../services/accounting/goldenCoastPhase4CutoverFifo";
import { GoldenCoastPhase6AutoHadiError, postGoldenCoastAutomaticHadiCollectionTx } from "./goldenCoastPhase6AutoHadi";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastPhase6RouteError,
  PHASE6_MAX_SALE_LINES,
  ensureCurrentInventoryLots,
  lockFifoLots,
  postingDependencies,
  resolvePhase6Accounts,
  resolveSpecialLocationConfig,
  type PersistedPostingResult,
} from "./ensureCurrentInventoryLots";
import {
  consumeFifoLot,
  findReplayedSale,
  preDeductionPlan,
  saleRevenueUsd,
} from "./spGoldenCoastPhase6PosSaleRoutesHandleReadiness";
export { PHASE6_READINESS_PATH, PHASE6_SALE_PATH, phase6RequestBudget } from "./ensureCurrentInventoryLots";
export { handleReadiness } from "./spGoldenCoastPhase6PosSaleRoutesHandleReadiness";

export async function handlePostSale(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  const userId = req.session.userId;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    if (!(await isGoldenCoastCompany(db, selectedCompany))) {
      res.status(409).json({
        code: "GC_PHASE6_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const sale = parseGoldenCoastPhase5SaleInput({
      companyId: selectedCompany,
      body: req.body,
      maxLines: PHASE6_MAX_SALE_LINES,
    });
    const exchangeRate = await getCurrentExchangeRate(selectedCompany);
    const revenueUsd = saleRevenueUsd(sale);
    const actor = {
      userId: userId ?? null,
      username: req.session.username || "unknown",
      reason: "Golden Coast Phase 6 POS sale with automatic HADI collection",
    };

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase6-sale:${selectedCompany}:${sale.clientRequestId}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, selectedCompany))) {
        throw new GoldenCoastPhase6RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE6_NOT_CONFIGURED",
          409
        );
      }
      const specialConfig = await resolveSpecialLocationConfig(tx, selectedCompany, sale.locationId);
      const accounts = await resolvePhase6Accounts(tx, selectedCompany);
      if ((req.body as Record<string, unknown> | undefined)?.saleSideAccount != null) {
        throw new GoldenCoastPhase6RouteError(
          "saleSideAccount overrides are retired for Golden Coast",
          "GC_PHASE6_SALE_SIDE_OVERRIDE_RETIRED"
        );
      }
      const saleSideAccount = { kind: "ledger" as const, id: accounts.gcSalesCashAccountId };
      const saleDigest = goldenCoastPhase5SaleDigest({ sale, saleSideAccount });
      const expectedDeduction = preDeductionPlan(sale, specialConfig.deductionPerQtyUsd);
      const replayed = await findReplayedSale({
        tx,
        companyId: selectedCompany,
        sale,
        saleDigest,
        deductionPlan: expectedDeduction,
      });
      if (replayed) {
        const automaticHadiCollection =
          sale.saleDate >= GOLDEN_COAST_CUTOVER_DATE
            ? await postGoldenCoastAutomaticHadiCollectionTx({
                tx,
                companyId: selectedCompany,
                gcSalesCashAccountId: accounts.gcSalesCashAccountId,
                saleDate: sale.saleDate,
                amountUsd: revenueUsd,
                clientRequestId: sale.clientRequestId,
                actor,
              })
            : null;
        const postings = [
          ...replayed,
          ...(automaticHadiCollection
            ? automaticHadiCollection.postings.map((item) => ({
                role: `hadi_collection_${item.role}`,
                voucher: item.voucher,
                entries: item.entries,
              }))
            : []),
        ];
        return {
          replayed: true as const,
          postings,
          plan: null,
          deductionPlan: expectedDeduction,
          automaticHadiCollection,
        };
      }

      const stockItemIds = [...new Set(sale.lines.map((line) => line.stockItemId))];
      let lots = await lockFifoLots(tx, selectedCompany, sale.locationId, stockItemIds);
      await ensureCurrentInventoryLots(tx, selectedCompany, sale.locationId, stockItemIds, lots);
      lots = await lockFifoLots(tx, selectedCompany, sale.locationId, stockItemIds);
      const plan = planGoldenCoastPhase5Sale({ sale, lots });
      const deductionPlan = planGoldenCoastPhase6SpecialLocationDeduction({
        salePlan: plan,
        deductionPerQtyUsd: specialConfig.deductionPerQtyUsd,
      });

      for (const allocation of plan.allocations) {
        await consumeFifoLot(tx, selectedCompany, allocation);
        await adjustSpInventoryAtomic(tx, {
          companyId: selectedCompany,
          locationId: allocation.locationId,
          stockItemId: allocation.stockItemId,
          deltaQty: -Number(allocation.qty),
          context: `Golden Coast Phase 6 sale ${sale.clientRequestId} from FIFO lot #${allocation.lotId}`,
          sourceVoucherType: "GC_PHASE6_SALE",
        });
      }

      const batch = buildGoldenCoastPhase5SalePostings({
        plan,
        accounts,
        saleSideAccount,
        saleDigest,
        exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
        actor,
      });

      const postings: Array<{
        role: string;
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch.postings) {
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          throw new GoldenCoastPhase6RouteError(
            `Golden Coast sale ${sale.clientRequestId} ${item.role} voucher was already posted`,
            "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
      }

      if (deductionPlan) {
        const deductionRequest = buildGoldenCoastPhase6SpecialLocationDeductionPosting({
          plan: deductionPlan,
          gcSalesCashAccountId: accounts.gcSalesCashAccountId,
          hassanSavingsAccountId: accounts.hassanSavingsAccountId,
          saleDigest,
          exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
          actor: {
            userId: userId ?? null,
            username: req.session.username || "unknown",
            reason: "Golden Coast special-location deduction",
          },
        });
        const posted = (await postBalancedVoucherTx(
          tx,
          deductionRequest,
          postingDependencies
        )) as PersistedPostingResult;
        if (posted.replayed) {
          throw new GoldenCoastPhase6RouteError(
            `Golden Coast sale ${sale.clientRequestId} special deduction was already posted`,
            "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: "special_deduction", voucher: posted.voucher, entries: posted.entries });
      }

      const automaticHadiCollection =
        sale.saleDate >= GOLDEN_COAST_CUTOVER_DATE
          ? await postGoldenCoastAutomaticHadiCollectionTx({
              tx,
              companyId: selectedCompany,
              gcSalesCashAccountId: accounts.gcSalesCashAccountId,
              saleDate: sale.saleDate,
              amountUsd: plan.revenueUsd,
              clientRequestId: sale.clientRequestId,
              actor,
            })
          : null;
      if (automaticHadiCollection) {
        postings.push(
          ...automaticHadiCollection.postings.map((item) => ({
            role: `hadi_collection_${item.role}`,
            voucher: item.voucher,
            entries: item.entries,
          }))
        );
      }

      return { replayed: false as const, postings, plan, deductionPlan, automaticHadiCollection };
    });

    logger.info("Golden Coast Phase 6 POS sale posted", {
      module: "golden-coast-phase6",
      companyId: selectedCompany,
      userId,
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      voucherIds: result.postings.map((item) => item.voucher.id),
      deductionUsd: result.deductionPlan?.deductionUsd ?? "0.00",
      automaticHadiCompanyId: result.automaticHadiCollection?.pair.hadiCompanyId ?? null,
      automaticHadiCashAccount: result.automaticHadiCollection?.hadiCashAccount ?? null,
      automaticHadiReplayed: result.automaticHadiCollection?.replayed ?? false,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      revenueUsd: result.plan?.revenueUsd ?? revenueUsd,
      cogsUsd: result.plan?.cogsUsd ?? null,
      grossProfitUsd: result.plan?.grossProfitUsd ?? null,
      specialLocationDeductionUsd: result.deductionPlan?.deductionUsd ?? "0.00",
      deductionPerQtyUsd: result.deductionPlan?.deductionPerQtyUsd ?? "0.0000",
      automaticHadiCollection: result.automaticHadiCollection
        ? {
            replayed: result.automaticHadiCollection.replayed,
            hadiCompanyId: result.automaticHadiCollection.pair.hadiCompanyId,
            amountUsd: result.automaticHadiCollection.transfer.amountUsd,
            hadiCashAccount: result.automaticHadiCollection.hadiCashAccount,
          }
        : null,
      lines: result.plan?.lines ?? null,
      allocations: result.plan?.allocations ?? null,
      postings: result.postings.map((item) => ({ role: item.role, voucher: item.voucher, entries: item.entries })),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 6 POS sale failed", {
      module: "golden-coast-phase6",
      companyId,
      userId,
      durationMs: Date.now() - startedAt,
      error,
    });
    if (error instanceof GoldenCoastPhase6RouteError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase6AutoHadiError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase7TransferError) {
      const conflictCodes = new Set(["GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS", "GC_PHASE7_SCOPE_INVALID"]);
      res.status(conflictCodes.has(error.code) ? 409 : 400).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase6DeductionError) {
      res
        .status(error.code === "GC_PHASE6_DEDUCTION_INVALID" ? 400 : 409)
        .json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase5SaleError) {
      const status = error.code === "GC_PHASE5_INPUT_INVALID" ? 400 : 409;
      res.status(status).json({ code: error.code, message: error.message });
      return;
    }
    if (respondToSpInventoryIntegrityError(res, error)) return;
    if (error instanceof PostingValidationError) {
      res
        .status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400)
        .json({ code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
