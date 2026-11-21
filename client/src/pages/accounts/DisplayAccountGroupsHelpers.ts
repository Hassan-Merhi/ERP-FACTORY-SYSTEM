// Extracted from ./DisplayAccountGroups.tsx

export type AccountDisplayNode = {
  key: string;
  type: "group" | "ledger";
  name: string | null;
  parentKey: string | null;
  order: number;
};

export type AccountDisplayLayout = { nodes: AccountDisplayNode[] };

export type LedgerOption = { id: number; name: string; code: string; subType: string | null };

export const byOrder = (a: AccountDisplayNode, b: AccountDisplayNode) =>
  a.order - b.order || a.key.localeCompare(b.key);

/** Move a single layout entry without changing any ledger account or voucher. */
export function moveNode(nodes: AccountDisplayNode[], key: string, parentKey: string | null, beforeKey?: string) {
  const moving = nodes.find((n) => n.key === key);
  if (!moving || (moving.type === "group" && parentKey !== null) || parentKey === key) return nodes;
  if (parentKey && !nodes.some((n) => n.type === "group" && n.key === parentKey)) return nodes;
  const result = nodes.map((n) => (n.key === key ? { ...n, parentKey } : { ...n }));
  const siblings = result.filter((n) => n.key !== key && n.parentKey === parentKey).sort(byOrder);
  const index = beforeKey ? siblings.findIndex((n) => n.key === beforeKey) : -1;
  siblings.splice(
    index < 0 ? siblings.length : index,
    0,
    result.find((n) => n.key === key)!
  );
  const positions = new Map(siblings.map((n, i) => [n.key, i]));
  return result.map((n) => (positions.has(n.key) ? { ...n, order: positions.get(n.key)! } : n));
}
