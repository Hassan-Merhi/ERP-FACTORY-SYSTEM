export type AuditRule = {
  resource_key?: string;
  resource?: string;
  action_key?: string;
  action?: string;
  decision?: string;
};

export function permissionAuditDiff(
  before: AuditRule[] | null | undefined,
  after: AuditRule[] | null | undefined
): Array<{ key: string; before: string; after: string }> {
  const rows = (value: AuditRule[] | null | undefined) => (Array.isArray(value) ? value : []);
  const key = (item: AuditRule) =>
    `${item.resource_key ?? item.resource ?? ""}:${item.action_key ?? item.action ?? ""}`;
  const left = new Map(rows(before).map((item) => [key(item), item.decision ?? "inherit"]));
  const right = new Map(rows(after).map((item) => [key(item), item.decision ?? "inherit"]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .filter((item) => (left.get(item) ?? "inherit") !== (right.get(item) ?? "inherit"))
    .map((item) => ({ key: item, before: left.get(item) ?? "inherit", after: right.get(item) ?? "inherit" }));
}
