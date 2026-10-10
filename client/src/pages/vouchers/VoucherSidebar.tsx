import {
  ArrowDownCircle,
  ArrowUpCircle,
  BookOpen,
  ArrowLeftRight,
  ClipboardList,
  SlidersHorizontal,
  FileText,
  LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarItem {
  key: string;
  label: string;
  icon: LucideIcon;
}

interface SidebarGroup {
  label: string;
  color: string;
  items: SidebarItem[];
}

interface VoucherSidebarProps {
  activeTab: string;
  onTabChange: (tab: unknown) => void;
  isFactoryMode: boolean;
}

export const sidebarGroups: SidebarGroup[] = [
  {
    label: "Financial",
    color: "#3b82f6",
    items: [
      { key: "payment", label: "Payment", icon: ArrowDownCircle },
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

export function VoucherSidebar({ activeTab, onTabChange, isFactoryMode }: VoucherSidebarProps) {
  const visibleSidebarGroups = isFactoryMode ? sidebarGroups.filter((g) => g.label !== "Adjustments") : sidebarGroups;

  return (
    <nav className="w-full lg:w-64 shrink-0 space-y-6">
      {visibleSidebarGroups.map((group) => (
        <div key={group.label} className="space-y-2">
          <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group.label}</h3>
          <div className="space-y-1">
            {group.items.map((item) => (
              <button
                key={item.key}
                onClick={() => onTabChange(item.key)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-all duration-200 hover-elevate active-elevate-2",
                  activeTab === item.key
                    ? "bg-primary text-primary-foreground shadow-xs scale-[1.02]"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                data-testid={`button-tab-${item.key}`}
              >
                <item.icon
                  className={cn("h-4 w-4", activeTab === item.key ? "text-primary-foreground" : "")}
                  style={{ color: activeTab === item.key ? undefined : group.color }}
                />
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
