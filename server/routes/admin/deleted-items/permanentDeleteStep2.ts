// Extracted from ./permanent-delete.ts: a stage of permanent-delete.
import {
  factoryCategories,
  factoryBaleProducts,
  factoryRawStock,
  factoryMixBatches,
  factoryBales,
  stockGroups,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type { permanentDeleteStep } from "./permanentDeleteStep";
import type { Request, Response } from "express";
import {
  permanentDeleteCustomerOrder,
  permanentDeleteCustomerProforma,
  permanentDeleteFactoryRawMaterialAdjustment,
  permanentDeleteFactoryContainer,
  permanentDeleteOrphanedPosSale,
} from "./permanentDeleteCases2";
import {
  permanentDeleteVoucher,
  permanentDeleteBankAccount,
  permanentDeleteSupplier,
  permanentDeleteCustomer,
  permanentDeleteEmployee,
  permanentDeleteLedgerAccount,
  permanentDeleteStockItem,
  permanentDeleteLocation,
} from "./permanentDeleteCases";

type PermanentDeleteStepResult = Awaited<ReturnType<typeof permanentDeleteStep>>;

export async function permanentDeleteStep2({
  pd1,
  req,
  res,
}: {
  pd1: Extract<PermanentDeleteStepResult, { done: false }>;
  req: Request;
  res: Response;
}) {
  const { type, removeOne, itemId, companyId } = pd1;

  switch (type) {
    case "location":
      await permanentDeleteLocation({ pd1, req });
      break;
    case "stockItem":
      await permanentDeleteStockItem({ pd1, req });
      break;
    case "stockGroup":
      await removeOne(stockGroups, "stock_groups", (tx) =>
        tx.delete(stockGroups).where(and(eq(stockGroups.id, itemId), eq(stockGroups.companyId, companyId)))
      );
      break;
    case "ledgerAccount":
      await permanentDeleteLedgerAccount({ pd1 });
      break;
    case "employee":
      await permanentDeleteEmployee({ pd1, req });
      break;
    case "customer": {
      await permanentDeleteCustomer({ pd1, req });
      break;
    }
    case "supplier":
      await permanentDeleteSupplier({ pd1 });
      break;
    case "bankAccount":
      await permanentDeleteBankAccount({ pd1 });
      break;
    case "voucher": {
      const pcvoucher = await permanentDeleteVoucher({ pd1, res, req });
      if (pcvoucher.done) return pcvoucher.value;
      break;
    }
    case "orphanedPosSale": {
      await permanentDeleteOrphanedPosSale({ pd1, req });
      break;
    }
    // === Wave 1 permanent deletes ===
    // Note: these only remove the row + immediate dependent rows. They do NOT
    // attempt to reverse historical financial vouchers/daybook entries — that
    // would require running the original cascade logic and is left for a future
    // wave. For full financial unwind, perform a manual reversal voucher.
    // Wave 18 (B): each one is a single transaction with its audit row.
    case "factoryCategory":
      await removeOne(factoryCategories, "factory_categories", (tx) =>
        tx
          .delete(factoryCategories)
          .where(and(eq(factoryCategories.id, itemId), eq(factoryCategories.companyId, companyId)))
      );
      break;
    case "factoryBaleProduct":
      await removeOne(factoryBaleProducts, "factory_bale_products", (tx) =>
        tx
          .delete(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.id, itemId), eq(factoryBaleProducts.companyId, companyId)))
      );
      break;
    case "factoryContainer": {
      await permanentDeleteFactoryContainer({ pd1 });
      break;
    }
    case "factoryRawStock":
      await removeOne(factoryRawStock, "factory_raw_stock", (tx) =>
        tx.delete(factoryRawStock).where(and(eq(factoryRawStock.id, itemId), eq(factoryRawStock.companyId, companyId)))
      );
      break;
    case "factoryRawMaterialAdjustment":
      await permanentDeleteFactoryRawMaterialAdjustment({ pd1 });
      break;
    case "factoryMixBatch":
      await removeOne(factoryMixBatches, "factory_mix_batches", (tx) =>
        tx
          .delete(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, itemId), eq(factoryMixBatches.companyId, companyId)))
      );
      break;
    case "factoryBale":
      await removeOne(factoryBales, "factory_bales", (tx) =>
        tx.delete(factoryBales).where(and(eq(factoryBales.id, itemId), eq(factoryBales.companyId, companyId)))
      );
      break;
    case "customerProforma":
      await permanentDeleteCustomerProforma({ pd1 });
      break;
    case "customerOrder":
      await permanentDeleteCustomerOrder({ pd1 });
      break;
    default:
      return { done: true as const, value: res.status(400).json({ message: "Invalid item type" }) };
  }

  return { done: false as const };
}
