// Extracted from ./exactScopeV6.ts
import { type ReplayScopeInternal, type ReplaySummary } from "./types";

export function sortNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function emptySummary(): ReplaySummary {
  return {
    totalReceivedContainers: 0,
    containersScanned: 0,
    omittedContainers: 0,
    canonicalContainerMismatches: 0,
    suppliersScanned: 0,
    safeSuppliers: 0,
    manualReviewSuppliers: 0,
    supplierPricedSourcesScanned: 0,
    sourceMismatches: 0,
    batchesToUpdate: 0,
    completedBatchesToUpdate: 0,
    balesToUpdate: 0,
    finalizedBalesToUpdate: 0,
    unresolvedFx: 0,
    missingDates: 0,
    quantityTimelineMismatches: 0,
    ambiguousEventOrdering: 0,
    scanCoverageError: false,
  };
}

export function emptyScope(): ReplayScopeInternal {
  return {
    supplierIds: [],
    containerIdsToUpdate: [],
    rawStockIdsToUpdate: [],
    sourceIdsToUpdate: [],
    batchIdsToUpdate: [],
    availableBaleIdsToUpdate: [],
    finalizedBaleIdsToUpdate: [],
    blockedBatches: [],
    _safeSupplierRows: [],
    _sourceInfos: [],
    _sourceCorrections: new Map(),
    _batchCorrections: [],
    _canonicalRateByContainer: new Map(),
    _canonicalTotalUsdByContainer: new Map(),
    _rawStockIdToContainer: new Map(),
    _fullPreview: {
      summary: emptySummary(),
      supplierRows: [],
      containerRows: [],
      sourceRows: [],
      batchRows: [],
    },
  };
}
