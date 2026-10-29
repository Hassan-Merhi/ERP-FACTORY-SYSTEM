/** Declaration for the guarded factory LAN policy module (.mjs is also consumed by Node scripts). */
export interface FactoryEdgeConfiguration {
  readonly mode: "cloud" | "lan";
  readonly siteId: string | null;
  readonly hostname: string | null;
  readonly writeMode: "cloud" | "read-only" | "lan-primary";
  readonly primary: boolean;
}
export function readFactoryEdgeConfiguration(env?: Record<string, string | undefined>): FactoryEdgeConfiguration;
export function edgeBlocksWrite(config: FactoryEdgeConfiguration, method: string, path: string): boolean;
export function edgeStatusPayload(config: FactoryEdgeConfiguration, databaseProvisioned?: boolean): {
  mode: FactoryEdgeConfiguration["mode"];
  siteId: string | null;
  writeMode: FactoryEdgeConfiguration["writeMode"];
  databaseProvisioned: boolean;
  cloudReplication: "not-configured";
};
export const EDGE_PRIMARY_ACK: string;
export function shouldStartEdgeBackgroundJobs(config: FactoryEdgeConfiguration): boolean;
