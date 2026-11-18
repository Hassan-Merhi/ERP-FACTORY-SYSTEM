// Extracted from ./goldenCoastPhase5PosSale.ts to keep that module under the source-size cap.
import {
  GoldenCoastPhase5SaleError,
  MONEY_SCALE,
  QUANTITY_SCALE,
  clientRequestId,
  decimalOf,
  optionalText,
  positiveId,
  requiredText,
  saleDate,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5SaleInput,
  type GoldenCoastPhase5SaleLineInput,
} from "./goldenCoastPhase5PosSaleDecimalOf";

/**
 * Normalizes an untrusted request body into a Phase 5 sale input. Every failure
 * is a hard error: Phase 5 never silently drops or repairs a sale line.
 */
export function parseGoldenCoastPhase5SaleInput(input: {
  companyId: number;
  body: unknown;
  maxLines?: number;
}): GoldenCoastPhase5SaleInput {
  const companyId = positiveId(input.companyId, "companyId");
  const body = input.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GoldenCoastPhase5SaleError("A Golden Coast sale request body is required");
  }
  const raw = body as Record<string, unknown>;
  const maxLines = input.maxLines ?? 100;

  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new GoldenCoastPhase5SaleError("lines must contain at least one sale line");
  }
  if (raw.lines.length > maxLines) {
    throw new GoldenCoastPhase5SaleError(`lines must contain at most ${maxLines} sale lines`);
  }

  const seenStockItems = new Set<number>();
  const lines: GoldenCoastPhase5SaleLineInput[] = raw.lines.map((rawLine, index) => {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}] must be an object`);
    }
    const line = rawLine as Record<string, unknown>;
    const stockItemId = positiveId(line.stockItemId, `lines[${index}].stockItemId`);
    if (seenStockItems.has(stockItemId)) {
      throw new GoldenCoastPhase5SaleError(
        `lines[${index}] repeats stock item #${stockItemId}; combine repeated items into a single line`
      );
    }
    seenStockItems.add(stockItemId);

    const qty = decimalOf(line.qty, `lines[${index}].qty`, "GC_PHASE5_INPUT_INVALID");
    if (!qty.greaterThan(0)) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}].qty must be greater than zero`);
    }
    if (qty.decimalPlaces() > QUANTITY_SCALE) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}].qty supports at most ${QUANTITY_SCALE} decimal places`);
    }

    const unitPrice = decimalOf(line.unitPriceUsd, `lines[${index}].unitPriceUsd`, "GC_PHASE5_INPUT_INVALID");
    if (unitPrice.lessThan(0)) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}].unitPriceUsd cannot be negative`);
    }
    if (unitPrice.decimalPlaces() > MONEY_SCALE) {
      throw new GoldenCoastPhase5SaleError(
        `lines[${index}].unitPriceUsd supports at most ${MONEY_SCALE} decimal places`
      );
    }

    return {
      stockItemId,
      qty: qty.toFixed(),
      unitPriceUsd: unitPrice.toFixed(),
      description: optionalText(line.description, `lines[${index}].description`, 200),
    };
  });

  return {
    companyId,
    locationId: positiveId(raw.locationId, "locationId"),
    saleDate: saleDate(raw.saleDate),
    customerName: requiredText(raw.customerName, "customerName", 200),
    clientRequestId: clientRequestId(raw.clientRequestId),
    lines,
    notes: optionalText(raw.notes, "notes", 500),
  };
}

// ── FIFO planner ─────────────────────────────────────────────────────────────

function lotSortKey(lot: GoldenCoastFifoLot): [number, number] {
  const raw = lot.createdAt;
  const timestamp = raw == null ? 0 : new Date(raw).getTime();
  return [Number.isFinite(timestamp) ? timestamp : 0, Number(lot.id)];
}

export function orderLots(lots: readonly GoldenCoastFifoLot[]): GoldenCoastFifoLot[] {
  return [...lots].sort((a, b) => {
    const [aTime, aId] = lotSortKey(a);
    const [bTime, bId] = lotSortKey(b);
    return aTime === bTime ? aId - bId : aTime - bTime;
  });
}
