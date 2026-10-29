export type EdgeConfiguration = Readonly<
  | { mode: "cloud"; siteId: null; hostname: null; writeMode: "cloud" | "fenced"; primary: false }
  | { mode: "lan"; siteId: string; hostname: string; writeMode: "read-only" | "lan-primary"; primary: boolean }
>;
export function readFactoryEdgeConfiguration(env?: Record<string, string | undefined>): EdgeConfiguration;
export function edgeBlocksWrite(config: EdgeConfiguration, method: string, path: string): boolean;
export function edgeStatusPayload(config: EdgeConfiguration, databaseProvisioned?: boolean): {
  mode: "cloud" | "lan";
  siteId: string | null;
  writeMode: string;
  databaseProvisioned: boolean;
  cloudReplication: "not-configured";
};
export const EDGE_PRIMARY_ACK: string;
export const CLOUD_WRITER_FENCE_ACK: string;
export function shouldStartEdgeBackgroundJobs(config: EdgeConfiguration): boolean;
