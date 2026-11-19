/**
 * Full offline mode: which mode the ERP server runs in on a PC's local copy.
 * Only the desktop app sets OFFLINE_PC_LOCAL_MODE; the cloud never does.
 * Kept free of imports so any module can ask without import cycles.
 */
export type PcLocalMode = "read-only" | "entry" | null;

export function pcLocalMode(env: NodeJS.ProcessEnv = process.env): PcLocalMode {
  const mode = env.OFFLINE_PC_LOCAL_MODE;
  return mode === "read-only" || mode === "entry" ? mode : null;
}
