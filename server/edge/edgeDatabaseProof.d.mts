import type { Pool } from "pg";
export function hasFactoryEdgeData(queryable: Pick<Pool, "query">): Promise<boolean>;
