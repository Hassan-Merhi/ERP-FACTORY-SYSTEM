/**
 * Phase 4: deterministic, read-only stock mapping plan for Properties to ERP.
 *
 * No stock item is created until EVERY physical container/row is verified.
 * Source identity comes only from a registered Properties stock item. Missing
 * destination records may be auto-created only from that verified source.
 * The caller inserts all creations in its existing import transaction.
 */
import { stockMatchingMessages as messages } from "./stockMatchingMessages";

export type StockIdentity = {
  id: number;
  companyId: number;
  code: string;
  name: string;
  uom: string;
  active: boolean;
  deletedAt: Date | null;
};

export type StockAliasIdentity = {
  companyId: number;
  stockItemId: number;
  aliasCode: string;
};

export type IncomingStockLine = {
  containerNumber: string;
  destinationCompanyId: number;
  rowNum: number;
  barcode: string;
  itemName: string;
};

export type DestinationStockCreation = {
  key: string;
  companyId: number;
  sourceItemId: number;
  code: string;
  name: string;
  uom: string;
};

export type VerifiedStockAssignment = {
  key: string;
  containerNumber: string;
  rowNum: number;
  destinationCompanyId: number;
  sourceItemId: number;
  destinationItemId: number | null;
  creationKey: string | null;
  code: string;
  name: string;
  uom: string;
};

export type DestinationStockMappingPlan = {
  assignments: VerifiedStockAssignment[];
  creations: DestinationStockCreation[];
  reusedCount: number;
};

export class StockMappingError extends Error {
  readonly status = 409;
  readonly code = "INTERCOMPANY_STOCK_MAPPING_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "StockMappingError";
  }
}

const normCode = (value: string) => value.trim().toLocaleLowerCase("en");
const normName = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]/gu, "");
const normUnit = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en");

function requireUsable(item: StockIdentity, label: string): StockIdentity {
  if (!item.active || item.deletedAt) throw new StockMappingError(label + ": " + messages.inactive);
  if (!item.code.trim() || item.code.length > 50 || !normName(item.name) || !normUnit(item.uom)) {
    throw new StockMappingError(label + ": " + messages.missingIdentity);
  }
  return item;
}

export function verifiedStockRowKey(containerNumber: string, rowNum: number): string {
  if (!containerNumber.trim() || !Number.isSafeInteger(rowNum) || rowNum <= 0) {
    throw new StockMappingError(messages.rowDuplicate);
  }
  return containerNumber.trim().toLocaleUpperCase("en") + ":" + rowNum;
}

export function planDestinationStockMapping(input: {
  sourceCompanyId: number;
  lines: readonly IncomingStockLine[];
  items: readonly StockIdentity[];
  aliases: readonly StockAliasIdentity[];
  allowedDestinationIds: readonly number[];
}): DestinationStockMappingPlan {
  const { sourceCompanyId, lines, items, aliases, allowedDestinationIds } = input;
  const allowed = new Set(allowedDestinationIds);
  if (!sourceCompanyId || !lines.length || !allowed.size) throw new StockMappingError(messages.destinationInvalid);

  const itemsById = new Map(items.map((item) => [item.id, item]));
  const byCode = new Map<string, Map<number, StockIdentity>>();
  const byName = new Map<string, Map<number, StockIdentity>>();
  const add = (map: Map<string, Map<number, StockIdentity>>, key: string, item: StockIdentity) => {
    if (!key) return;
    const values = map.get(key) ?? new Map<number, StockIdentity>();
    values.set(item.id, item);
    map.set(key, values);
  };
  for (const item of items) {
    add(byCode, item.companyId + ":" + normCode(item.code), item);
    add(byName, item.companyId + ":" + normName(item.name), item);
  }
  for (const alias of aliases) {
    const target = itemsById.get(alias.stockItemId);
    // Ignore unrelated aliases; any alias claiming an item in another company
    // is invalid and must not silently grant an intercompany match.
    if (!target || target.companyId !== alias.companyId) {
      throw new StockMappingError(messages.destinationMismatch + ": " + alias.aliasCode);
    }
    add(byCode, alias.companyId + ":" + normCode(alias.aliasCode), target);
  }

  const single = (map: Map<string, Map<number, StockIdentity>>, key: string, label: string, ambiguity: string) => {
    const entries = [...(map.get(key)?.values() ?? [])];
    if (entries.length > 1) throw new StockMappingError(label + ": " + ambiguity);
    return entries[0] ?? null;
  };
  const byItemCode = (companyId: number, code: string, label: string) =>
    code.trim() ? single(byCode, companyId + ":" + normCode(code), label, messages.codeAmbiguous) : null;
  const byItemName = (companyId: number, name: string, label: string) =>
    normName(name) ? single(byName, companyId + ":" + normName(name), label, messages.nameAmbiguous) : null;

  const assignments: VerifiedStockAssignment[] = [];
  const creations = new Map<string, DestinationStockCreation>();
  const pendingCodes = new Map<string, number>();
  const pendingNames = new Map<string, number>();
  const seenRows = new Set<string>();
  for (const line of lines) {
    const label = line.containerNumber + " row " + line.rowNum;
    const key = verifiedStockRowKey(line.containerNumber, line.rowNum);
    if (seenRows.has(key)) throw new StockMappingError(label + ": " + messages.rowDuplicate);
    seenRows.add(key);
    if (!allowed.has(line.destinationCompanyId) || line.destinationCompanyId === sourceCompanyId) {
      throw new StockMappingError(label + ": " + messages.destinationInvalid);
    }

    const sourceByCode = byItemCode(sourceCompanyId, line.barcode, label);
    const source = sourceByCode ?? byItemName(sourceCompanyId, line.itemName, label);
    if (!source) throw new StockMappingError(label + ": " + messages.sourceNotFound);
    requireUsable(source, label);
    if (normName(line.itemName) && normName(line.itemName) !== normName(source.name)) {
      throw new StockMappingError(label + ": " + messages.sourceMismatch);
    }

    const destinationBySourceCode = byItemCode(line.destinationCompanyId, source.code, label);
    const destinationByBarcode = byItemCode(line.destinationCompanyId, line.barcode, label);
    const destinationByName = byItemName(line.destinationCompanyId, source.name, label);
    const candidates = [destinationBySourceCode, destinationByBarcode, destinationByName].filter(
      (item): item is StockIdentity => item !== null
    );
    if (new Set(candidates.map((candidate) => candidate.id)).size > 1) {
      throw new StockMappingError(label + ": " + messages.destinationMismatch);
    }
    const destination = candidates[0] ?? null;
    if (destination) {
      requireUsable(destination, label);
      if (normName(destination.name) !== normName(source.name)) {
        throw new StockMappingError(label + ": " + messages.destinationMismatch);
      }
      if (normUnit(destination.uom) !== normUnit(source.uom)) {
        throw new StockMappingError(label + ": " + messages.unitMismatch);
      }
    }

    const creationKey = destination ? null : line.destinationCompanyId + ":" + source.id;
    if (creationKey && !creations.has(creationKey)) {
      // Unique source identity does not imply unique destination naming:
      // two source codes can differ only by case, and source items can share
      // names. Refuse a batch that would create either ambiguity.
      const codeKey = line.destinationCompanyId + ":" + normCode(source.code);
      const nameKey = line.destinationCompanyId + ":" + normName(source.name);
      const codeOwner = pendingCodes.get(codeKey);
      const nameOwner = pendingNames.get(nameKey);
      if ((codeOwner !== undefined && codeOwner !== source.id) ||
          (nameOwner !== undefined && nameOwner !== source.id)) {
        throw new StockMappingError(label + ": " + messages.destinationMismatch);
      }
      pendingCodes.set(codeKey, source.id);
      pendingNames.set(nameKey, source.id);
      creations.set(creationKey, {
        key: creationKey,
        companyId: line.destinationCompanyId,
        sourceItemId: source.id,
        code: source.code,
        name: source.name,
        uom: source.uom,
      });
    }
    assignments.push({
      key,
      containerNumber: line.containerNumber,
      rowNum: line.rowNum,
      destinationCompanyId: line.destinationCompanyId,
      sourceItemId: source.id,
      destinationItemId: destination?.id ?? null,
      creationKey,
      code: source.code,
      name: source.name,
      uom: source.uom,
    });
  }

  return {
    assignments,
    creations: [...creations.values()],
    reusedCount: assignments.filter((row) => row.destinationItemId !== null).length,
  };
}

/** Reconcile a preflight plan with IDs returned by transactional inserts. */
export function finalizedStockItemId(
  assignment: VerifiedStockAssignment,
  newIds: ReadonlyMap<string, number>
): number {
  const id = assignment.destinationItemId ?? (assignment.creationKey ? newIds.get(assignment.creationKey) : null);
  if (!Number.isSafeInteger(id) || !id || id <= 0) {
    throw new StockMappingError(messages.missingMapping);
  }
  return id;
}
