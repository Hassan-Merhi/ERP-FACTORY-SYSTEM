// Extracted from ./balesReimportRoutes.ts to keep that module under the source-size cap.
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();
