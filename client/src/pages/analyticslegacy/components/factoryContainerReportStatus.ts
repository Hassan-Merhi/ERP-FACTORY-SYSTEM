/**
 * Presentation-only status grouping for Factory Analytics > Container Report.
 * Never use these labels for DB writes or warehouse/offload lifecycle logic.
 */
export function factoryReportStatus(rawStatus: string): string {
  const status = rawStatus.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (status === "PARTIALLY_RECEIVED" || status === "OFFLOADED") return "Offloaded";
  if (status === "PENDING") return "OTW";
  return rawStatus.replace(/_/g, " ");
}

export function isFactoryReportContainer(status: string): boolean {
  return status.trim().toUpperCase().replace(/[\s-]+/g, "_") !== "OPENING_BALANCE";
}
