import {
  ArrowDownCircle,
  ArrowUpCircle,
  BookOpen,
  ArrowLeftRight,
  SlidersHorizontal,
  FileText,
  ClipboardList,
  Landmark,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { INTERCOMPANY_VOUCHER_EN } from "@/i18n/intercompanyVoucherTranslations";

export type VoucherSidebarGroup = {
  label: string;
  color: string;
  items: { key: string; label: string; icon: LucideIcon }[];
};

/** Voucher type navigation groups. Returns a fresh array on every call (the page rebuilds it each render). */
export function buildVoucherSidebarGroups(includeIntercompany = false, transferLabel = INTERCOMPANY_VOUCHER_EN.tab): VoucherSidebarGroup[] {
  return [
    {
      label: "Financial",
      color: "#3b82f6",
      items: [
        { key: "payment", label: "Payment", icon: ArrowDownCircle },
        ...(includeIntercompany ? [{ key: "intercompany", label: transferLabel, icon: Landmark }] : []),
        { key: "receipt", label: "Receipt", icon: ArrowUpCircle },
        { key: "journal", label: "Journal", icon: BookOpen },
      ],
    },
    {
      label: "Adjustments",
      color: "#f59e0b",
      items: [
        { key: "transfer", label: "Stock Transfer", icon: ArrowLeftRight },
        { key: "transferorder", label: "Transfer Order", icon: ClipboardList },
        { key: "adjustment", label: "Adjustment", icon: SlidersHorizontal },
        { key: "creditnote", label: "Credit Note", icon: FileText },
      ],
    },
  ];
}
