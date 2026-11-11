/**
 * Some Factory dispatch finance routes deliberately answer 503 with a specific
 * code until the manual database safeguards are installed. On a database
 * without them (every fresh test database) that answer is the designed,
 * fail-closed behaviour, not an unhandled server error.
 */
const READINESS_GATE_CODES = new Set(["FACTORY_DISPATCH_TABLEPLUS_GUARDS_PENDING", "COMBINED_INVOICE_SQL_PENDING"]);

export function isDeclaredReadinessGate(response: { status: number; body?: unknown }): boolean {
  if (response.status !== 503) return false;
  const code = (response.body as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && READINESS_GATE_CODES.has(code);
}
