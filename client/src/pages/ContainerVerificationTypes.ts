// Extracted from ./ContainerVerification.tsx to keep that module under the source-size cap.
import type { LoadedItem } from "./containerverification/types";

type SupplierIdentity = {
  id?: number;
  legalName?: string | null;
  name?: string | null;
  code?: string | null;
};

export type SupplierDetailResponse = SupplierIdentity & {
  supplier?: SupplierIdentity;
};

export type LoadedItemSyncResult = {
  imported: number;
  skipped: number;
  replaced: number;
  items: LoadedItem[];
};
