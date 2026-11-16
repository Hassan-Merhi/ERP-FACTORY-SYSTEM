import type { Pool, PoolClient } from "pg";
type Queryable = Pick<Pool | PoolClient, "query">;
export class Phase9StockItemNotYetSynced extends Error {
  constructor(lanItemIds: number[]);
  readonly lanItemIds: number[];
}
export function ensurePhase9StockItemMapSchema(queryable: Queryable): Promise<void>;
export function isPhase9LanItemId(value: unknown): boolean;
export function translatePhase9LanStockItems<T extends { payload: unknown }>(
  queryable: Queryable,
  siteId: string,
  event: T
): Promise<T>;
export function readPhase9StockItemMapping(
  queryable: Queryable,
  siteId: string,
  lanItemId: number
): Promise<number | null>;
export function recordPhase9StockItemMapping(
  queryable: Queryable,
  input: { siteId: string; lanItemId: number; cloudItemId: number; operationId: string }
): Promise<void>;
