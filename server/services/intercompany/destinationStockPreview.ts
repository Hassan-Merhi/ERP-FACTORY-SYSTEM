/** Read-only Phase 4 stock verification before committing a linked PO. */
import { inArray } from "drizzle-orm";
import { stockItemCodeAliases, stockItems } from "@shared/schema";
import { db } from "../../db";
import { eligibleDestinations, withinTrustedPair } from "./containerTradingImport";
import { type WorkbookPreview, TradingImportError } from "./containerTradingWorkbook";
import { planDestinationStockMapping, type IncomingStockLine } from "./destinationStockMapping";

export interface StockPreviewSelection {
  containerNumber: string;
  destinationCompanyId: number;
}

export async function previewDestinationStock(args: {
  sourceCompanyId: number;
  userId: string;
  role: string;
  preview: WorkbookPreview;
  selections: StockPreviewSelection[];
}) {
  const { sourceCompanyId, userId, role, preview, selections } = args;
  const allowed = await eligibleDestinations(sourceCompanyId, userId, role);
  const allowedIds = new Set(allowed.map((destination) => destination.id));
  if (selections.length !== preview.containers.length) {
    throw new TradingImportError(400, "Verify one destination for every container");
  }
  const selectedByContainer = new Map<string, number>();
  for (const selection of selections) {
    const name = selection.containerNumber.trim().toUpperCase();
    if (
      !name ||
      selectedByContainer.has(name) ||
      !Number.isSafeInteger(selection.destinationCompanyId) ||
      !allowedIds.has(selection.destinationCompanyId)
    ) {
      throw new TradingImportError(400, "Duplicate or unauthorized destination selection");
    }
    selectedByContainer.set(name, selection.destinationCompanyId);
  }
  const destinations = [...new Set(selections.map((selection) => selection.destinationCompanyId))];
  const lines: IncomingStockLine[] = [];
  for (const container of preview.containers) {
    const companyId = selectedByContainer.get(container.containerNumber.trim().toUpperCase());
    if (!companyId)
      throw new TradingImportError(400, "Missing destination company for container " + container.containerNumber);
    for (const line of container.items) {
      lines.push({
        containerNumber: container.containerNumber,
        destinationCompanyId: companyId,
        rowNum: line.rowNum,
        barcode: line.barcode || "",
        itemName: line.itemName,
      });
    }
  }

  return withinTrustedPair(sourceCompanyId, destinations, async () => {
    const companyIds = [sourceCompanyId, ...destinations];
    const [items, aliases] = await Promise.all([
      db.select().from(stockItems).where(inArray(stockItems.companyId, companyIds)),
      db.select().from(stockItemCodeAliases).where(inArray(stockItemCodeAliases.companyId, companyIds)),
    ]);
    const plan = planDestinationStockMapping({
      sourceCompanyId,
      items,
      aliases,
      allowedDestinationIds: destinations,
      lines,
    });
    return {
      fileSha256: preview.sha256,
      sourceCompanyId,
      verifiedRows: plan.assignments.length,
      createdItemCount: plan.creations.length,
      reusedLineCount: plan.reusedCount,
      rows: plan.assignments.map((assignment) => ({
        containerNumber: assignment.containerNumber,
        destinationCompanyId: assignment.destinationCompanyId,
        excelRow: assignment.rowNum,
        code: assignment.code,
        name: assignment.name,
        uom: assignment.uom,
        sourceStockItemId: assignment.sourceItemId,
        destinationStockItemId: assignment.destinationItemId,
        action: assignment.creationKey ? ("create" as const) : ("reuse" as const),
      })),
    };
  });
}
