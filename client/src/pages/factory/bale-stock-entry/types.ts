/**
 * Shared row/option types for the Bale Stock Entry tab components.
 *
 * These describe the API payloads the tab renders (workers, worker groups and
 * customer logo options) without pulling in the full table schema types.
 */

export interface WorkerOption {
  id: number;
  fullName?: string;
  name?: string;
  active?: boolean;
}

export interface WorkerCategoryRow {
  id: number;
  name: string;
  workerIds?: number[];
}

export interface CustomerOption {
  id: number;
  active?: boolean | null;
  legalName?: string | null;
}

export interface CustomerLogoRow {
  id: number;
  name: string;
}
