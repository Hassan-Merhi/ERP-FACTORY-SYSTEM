// Extracted from ./CompanySelector.tsx
import type { CompanyType } from "@/contracts/sessionContracts";

const TYPE_META: Record<CompanyType, { color: string; label: string }> = {
  erp: { color: "#3b82f6", label: "ERP" },
  retail: { color: "#0ea5e9", label: "Retail" },
  factory: { color: "#f97316", label: "Factory" },
  factory_v2: { color: "#f97316", label: "Factory V2" },
  properties: { color: "#6366f1", label: "Properties" },
  supplier_partner: { color: "#f43f5e", label: "Supplier Partner" },
};

export function getTypeMeta(type: CompanyType) {
  return TYPE_META[type];
}

function getInitials(name: string) {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return name.substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function CompanyAvatar({ name, type, size = "sm" }: { name: string; type: CompanyType; size?: "sm" | "md" }) {
  const { color } = getTypeMeta(type);
  const dim =
    size === "md"
      ? "h-9 w-9 rounded-[11px] text-[11px] shadow-[0_3px_10px_rgba(22,45,96,0.16)] ring-1 ring-white/35"
      : "h-5 w-5 rounded-md text-[11px]";
  return (
    <span
      className={`${dim} relative flex shrink-0 items-center justify-center overflow-hidden font-bold text-white shadow-inner`}
      style={{ background: `linear-gradient(145deg, ${color}, ${color}c9)` }}
    >
      {getInitials(name)}
    </span>
  );
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Please try again.";
}
