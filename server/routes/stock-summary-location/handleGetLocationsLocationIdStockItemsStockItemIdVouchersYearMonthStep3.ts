// Extracted from ./monthly-vouchers.ts to keep that module under the source-size cap.
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { calculateHistoricalLocationInventory } from "../helpers/inventoryHistoryHelpers";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { containerOffloads, containers, poLineItems, purchaseOrders } from "@shared/schema";
import { handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1 } from "./handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1";
import { handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2 } from "./handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2";

export async function handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep3({
  companyId,
  expectedClosingQty,
  expectedClosingRate,
  expectedClosingValue,
  locationId,
  month,
  monthEndStr,
  monthStartStr,
  noteData,
  openingHistoryRow,
  stockItemId,
  transactions,
  year,
}: Pick<
  Extract<
    Awaited<ReturnType<typeof handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1>>,
    { done: false }
  > &
    Awaited<ReturnType<typeof handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2>>,
  | "companyId"
  | "expectedClosingQty"
  | "expectedClosingRate"
  | "expectedClosingValue"
  | "locationId"
  | "month"
  | "monthEndStr"
  | "monthStartStr"
  | "noteData"
  | "openingHistoryRow"
  | "stockItemId"
  | "transactions"
  | "year"
>) {
  for (const item of noteData) {
    const exactQty = toMoney(item.quantity).abs();
    const exactRate = MoneyDecimal.max(toMoney(item.inventoryCost), 0);
    const qty = exactQty.toNumber();
    const rate = exactRate.toNumber();
    const value = exactQty.times(exactRate).toNumber();
    const isCredit = item.noteType === "Credit Note";

    transactions.push({
      date: item.voucherDate,
      particulars: item.voucherNumber || item.noteType || "Credit/Debit Note",
      vchType: isCredit ? "Credit Note" : "Debit Note",
      voucherId: item.voucherId,
      inwardQty: isCredit ? qty : 0,
      inwardRate: isCredit ? rate : 0,
      inwardValue: isCredit ? value : 0,
      outwardQty: isCredit ? 0 : qty,
      outwardRate: isCredit ? 0 : rate,
      outwardValue: isCredit ? 0 : value,
    });
  }

  // 5. Container Offloads at this location (Inwards from PO imports)
  const offloadData = await db
    .select({
      offloadedAt: containerOffloads.offloadedAt,
      containerId: containerOffloads.containerId,
      containerCode: containers.containerNumber,
      poId: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      quantity: poLineItems.quantity,
      rate: poLineItems.rate,
      lineTotal: poLineItems.lineTotal,
      additionalCostPerBale: containerOffloads.additionalCostPerBale,
    })
    .from(containerOffloads)
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .innerJoin(purchaseOrders, eq(purchaseOrders.containerId, containers.id))
    .innerJoin(poLineItems, eq(poLineItems.poId, purchaseOrders.id))
    .where(
      and(
        eq(poLineItems.stockItemId, stockItemId),
        eq(containers.companyId, companyId),
        eq(containerOffloads.locationId, locationId),
        sql`EXTRACT(YEAR FROM ${containerOffloads.offloadedAt}) = ${year}`,
        sql`EXTRACT(MONTH FROM ${containerOffloads.offloadedAt}) = ${month}`
      )
    )
    .orderBy(containerOffloads.offloadedAt);

  for (const item of offloadData) {
    const qty = toMoney(item.quantity);
    const landedValue = toMoney(item.lineTotal).plus(toMoney(item.additionalCostPerBale).times(qty));
    // A zero quantity has no rate; NaN serialises as null, as the float division did.
    const landedRate = qty.isZero() ? Number.NaN : landedValue.div(qty).toNumber();

    const offloadDateStr =
      item.offloadedAt instanceof Date
        ? item.offloadedAt.toISOString().split("T")[0]
        : String(item.offloadedAt).split("T")[0];

    transactions.push({
      date: offloadDateStr,
      particulars: `Container: ${item.containerCode} / PO: ${item.poNumber}`,
      vchType: "PO Offload",
      voucherId: 0,
      poId: item.poId,
      inwardQty: qty.toNumber(),
      inwardRate: landedRate,
      inwardValue: landedValue.toNumber(),
      outwardQty: 0,
      outwardRate: 0,
      outwardValue: 0,
    });
  }

  // Sort transactions by date, with inward transactions before outward on same date
  transactions.sort((a, b) => {
    const dateCompare = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (dateCompare !== 0) return dateCompare;
    // On same date, inward before outward (so opening stock shows first)
    if (a.inwardQty > 0 && b.outwardQty > 0) return -1;
    if (a.outwardQty > 0 && b.inwardQty > 0) return 1;
    return 0;
  });

  // Calculate in-month net movements from transactions
  const inMonthInwardQty = sumMoney(transactions.map((t) => t.inwardQty));
  const inMonthOutwardQty = sumMoney(transactions.map((t) => t.outwardQty));

  // Calculate what the opening balance SHOULD be based on:
  // expectedClosing = expectedOpening + inMonthInward - inMonthOutward
  // Therefore: expectedOpening = expectedClosing - inMonthInward + inMonthOutward
  const expectedOpeningQty = expectedClosingQty.minus(inMonthInwardQty).plus(inMonthOutwardQty);
  const expectedOpeningRate = expectedClosingRate; // Use the expected rate
  const expectedOpeningValue = expectedOpeningQty.times(expectedOpeningRate);

  // Use the historical snapshot when there is one, else the expected opening,
  // which reconciles with inventory.
  const historicalOpeningQty = openingHistoryRow ? toMoney(openingHistoryRow.quantity) : expectedOpeningQty;
  const historicalOpeningValue = openingHistoryRow ? toMoney(openingHistoryRow.totalValue) : expectedOpeningValue;
  const historicalOpeningStoredRate = openingHistoryRow ? toMoney(openingHistoryRow.averageRate) : expectedOpeningRate;

  let openingQty = historicalOpeningQty.toDecimalPlaces(3, MoneyDecimal.ROUND_HALF_CEIL);
  let openingValue = historicalOpeningValue;
  let openingRate =
    openingQty.gt(0) && openingValue.gt(0)
      ? openingValue.div(openingQty)
      : MoneyDecimal.max(historicalOpeningStoredRate, 0);

  // Handle edge cases: if opening is negative, something is wrong
  if (openingQty.lt(0)) {
    // Negative opening means more was sold than could have existed
    // This indicates data issues - clamp to zero for display
    openingQty = new MoneyDecimal(0);
    openingValue = new MoneyDecimal(0);
    openingRate = new MoneyDecimal(0);
  }

  // Calculate running balance - start with the full expected opening (includes imports)
  let runningQty = openingQty;
  let runningValue = openingValue;
  const opening = { qty: openingQty.toNumber(), rate: openingRate.toNumber(), value: openingValue.toNumber() };

  const transactionsWithBalance: Array<{
    date: string;
    particulars: string;
    vchType: string;
    voucherId: number;
    poId?: number;
    inwardQty: number;
    inwardRate: number;
    inwardValue: number;
    outwardQty: number;
    outwardRate: number;
    outwardValue: number;
    closingQty: number;
    closingRate: number;
    closingValue: number;
    isOpeningBalance?: boolean;
    isPOS?: boolean;
    posSellingRate?: number;
    posSellingValue?: number;
  }> = [];

  // Add Opening Balance row if there's opening stock
  if (openingQty.gt(0) || openingValue.gt(0)) {
    transactionsWithBalance.push({
      date: monthStartStr,
      particulars: "Opening Balance",
      vchType: "",
      voucherId: 0,
      inwardQty: opening.qty,
      inwardRate: opening.rate,
      inwardValue: opening.value,
      outwardQty: 0,
      outwardRate: 0,
      outwardValue: 0,
      closingQty: opening.qty,
      closingRate: opening.rate,
      closingValue: opening.value,
      isOpeningBalance: true,
    });
  }

  // Calculate running balance for each transaction using weighted average cost
  for (const t of transactions) {
    const outwardQty = toMoney(t.outwardQty);
    const currentAvgRate = runningQty.gt(0) ? runningValue.div(runningQty) : new MoneyDecimal(0);
    runningQty = runningQty.plus(toMoney(t.inwardQty)).minus(outwardQty);
    const storedOutwardCost = outwardQty.gt(0) ? MoneyDecimal.max(toMoney(t.outwardValue), 0) : new MoneyDecimal(0);
    const actualOutwardCost = outwardQty.gt(0)
      ? storedOutwardCost.gt(0)
        ? storedOutwardCost
        : outwardQty.times(currentAvgRate)
      : new MoneyDecimal(0);
    runningValue = runningValue.plus(toMoney(t.inwardValue)).minus(actualOutwardCost);
    const avgClosingRate = runningQty.gt(0) ? runningValue.div(runningQty) : new MoneyDecimal(0);

    const displayOutwardRate = outwardQty.isZero() ? 0 : actualOutwardCost.div(outwardQty).toNumber();
    const displayOutwardValue = outwardQty.isZero() ? 0 : actualOutwardCost.toNumber();

    transactionsWithBalance.push({
      ...t,
      outwardRate: displayOutwardRate,
      outwardValue: displayOutwardValue,
      closingQty: runningQty.toNumber(),
      closingRate: avgClosingRate.toNumber(),
      closingValue: runningValue.toNumber(),
    });
  }

  // Re-anchor the month close to the same historical inventory snapshot used
  // by the monthly summary so both views show identical quantity/value.
  const closingHistory = await calculateHistoricalLocationInventory(locationId, companyId, monthEndStr);
  const closingHistoryRow = closingHistory.find((row) => row.stockItemId === stockItemId);
  const finalClosingQty = (closingHistoryRow ? toMoney(closingHistoryRow.quantity) : expectedClosingQty)
    .toDecimalPlaces(3, MoneyDecimal.ROUND_HALF_CEIL)
    .toNumber();
  const exactClosingValue = closingHistoryRow ? toMoney(closingHistoryRow.totalValue) : expectedClosingValue;
  const closingStoredRate = closingHistoryRow ? toMoney(closingHistoryRow.averageRate) : expectedClosingRate;
  const finalClosingValue = exactClosingValue.toNumber();
  const finalClosingRate =
    finalClosingQty > 0 && exactClosingValue.gt(0)
      ? exactClosingValue.div(finalClosingQty).toNumber()
      : MoneyDecimal.max(closingStoredRate, 0).toNumber();
  return { finalClosingQty, finalClosingRate, finalClosingValue, opening, transactionsWithBalance };
}
