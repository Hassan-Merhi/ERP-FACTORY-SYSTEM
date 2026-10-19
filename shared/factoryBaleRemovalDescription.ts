/**
 * One display format for newly recorded and historical factory bale removals.
 * Generic system-generated audit reasons are not user-entered explanations.
 */
const AUTOMATIC_REASONS = new Set([
  "factory bale stock removal",
  "bale deleted everywhere from barcode lookup",
]);

export function formatFactoryBaleRemovalDescription({
  references,
  username,
  reason,
}: {
  references: readonly (string | null | undefined)[];
  username: string;
  reason?: string | null;
}): string {
  const numbers = references
    .map((ref) => (ref || "").trim())
    .filter(Boolean)
    .map((ref) => `#${ref.replace(/^#/, "")}`);
  const baleList =
    numbers.length <= 2
      ? numbers.join(" and ")
      : `${numbers.slice(0, -1).join(", ")}, and ${numbers[numbers.length - 1]}`;
  const user = username.trim() || "unknown user";
  const action = numbers.length === 1 ? "bale" : "bales";
  const description = `Removed ${action}${baleList ? ` ${baleList}` : ""} by ${user}.`;

  const explanation = (reason || "").trim();
  if (!explanation || AUTOMATIC_REASONS.has(explanation.toLowerCase())) {
    return description;
  }
  return `${description} Reason: ${explanation}${/[.!?]$/.test(explanation) ? "" : "."}`;
}
