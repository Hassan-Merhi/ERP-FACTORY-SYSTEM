export type EdgeConfiguration = Readonly<
  | { mode: "cloud"; siteId: null; hostname: null; writeMode: "cloud" | "fenced"; primary: false }
  | {
      mode: "lan";
      siteId: string;
      hostname: string;
      writeMode: "read-only" | "lan-primary";
      primary: boolean;
      writerEpoch: string | null;
      baselineSha256: string | null;
    }
>;
export function readFactoryEdgeConfiguration(env?: Record<string, string | undefined>): EdgeConfiguration;
export const PHASE10_SYNC_CONTROL_ROUTE: "POST /api/edge/operator/sync-control";
export const PHASE10_CONFLICT_DECISION_ROUTE: "POST /api/edge/operator/conflicts/decide";
export function edgeBlocksWrite(config: EdgeConfiguration, method: string, path: string): boolean;
export function edgeStatusPayload(
  config: EdgeConfiguration,
  databaseProvisioned?: boolean
): {
  mode: "cloud" | "lan";
  siteId: string | null;
  writeMode: string;
  databaseProvisioned: boolean;
  cloudReplication: "not-configured";
};
export const EDGE_PRIMARY_ACK: string;
export const CLOUD_WRITER_FENCE_ACK: string;
export function shouldStartEdgeBackgroundJobs(config: EdgeConfiguration): boolean;
export const PHASE9_PRESSING_CONFIRM_ROUTE: "POST /api/factory/pressing-machines/confirm";
export const PHASE9_STOCK_ADJUST_ROUTE: "POST /api/inventory/quick-adjust";
export const PHASE9_POS_SALE_ROUTE: "POST /api/pos/sales";
export const PHASE9_ATTACHMENT_UPLOAD_ROUTE: "POST /api/files/upload";
export const PHASE9_PAYMENT_RECEIPT_ROUTE: "POST /api/vouchers/payment-receipt";
export const PHASE9_STOCK_TRANSFER_ROUTE: "POST /api/stock-transfers";
export const PHASE9_STOCK_ITEM_EDIT_STATIC_ROUTES: readonly string[];
export const PHASE9_STOCK_ITEM_PATH: RegExp;
export const PHASE9_STOCK_ITEM_LOCATION_PRICES_PATH: RegExp;
export const PHASE9_RECEIVING_OFFLOAD_PATH: RegExp;
export const PHASE9_POS_SALE_EDIT_PATH: RegExp;
export const PHASE9_VOUCHER_DELETE_PATH: RegExp;
export function phase9ApprovedCaptureRoute(method: string, path: string): string | null;
