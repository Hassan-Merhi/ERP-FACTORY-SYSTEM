import { MoreHorizontal, Package, Ship, ShoppingCart, Wallet, type LucideIcon } from "lucide-react";
import { useLocation } from "wouter";
import { useErpVisibleSections } from "@/components/AppSidebar";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import type { ApplicationTranslationKey } from "@/i18n/applicationTranslations";

interface ErpMobileBottomNavProps {
  user?: {
    username?: string | null;
    currentRole?: string | null;
    role?: string | null;
  };
  onMore: () => void;
}

interface MobileSection {
  id: "tracking" | "inventory" | "sales" | "accounts";
  labelKey: ApplicationTranslationKey;
  icon: LucideIcon;
  destinations: Array<{ title: string; href: string }>;
  isActive: (path: string) => boolean;
}

const mobileNavButtonClassName =
  "flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium transition-colors touch-manipulation";

const mobileSections: MobileSection[] = [
  {
    id: "tracking",
    labelKey: "mobileNav.tracking",
    icon: Ship,
    destinations: [{ title: "Tracking", href: "/tracking" }],
    isActive: (path) => path === "/tracking" || path.startsWith("/tracking/"),
  },
  {
    id: "inventory",
    labelKey: "mobileNav.inventory",
    icon: Package,
    destinations: [
      { title: "Inventory", href: "/inventory" },
      { title: "Stock", href: "/stock" },
      { title: "Optional Vouchers", href: "/optional-vouchers" },
      { title: "Profit Check", href: "/supplier-profit-check" },
    ],
    isActive: (path) =>
      path === "/inventory" ||
      path.startsWith("/inventory/") ||
      path === "/stock" ||
      path.startsWith("/stock/") ||
      path === "/optional-vouchers" ||
      path.startsWith("/optional-vouchers/") ||
      path === "/supplier-profit-check",
  },
  {
    id: "sales",
    labelKey: "mobileNav.sales",
    icon: ShoppingCart,
    destinations: [
      { title: "POS", href: "/pos" },
      { title: "Sales Tools", href: "/sales-tools" },
      { title: "Sales Report", href: "/sales-report" },
      { title: "Stock In & Sales", href: "/stock-in-sales-report" },
      { title: "POS Item Replacement", href: "/pos-item-replacement" },
    ],
    isActive: (path) =>
      path === "/pos" ||
      path.startsWith("/pos/") ||
      path === "/sales-tools" ||
      path.startsWith("/sales-tools/") ||
      path === "/sales-report" ||
      path.startsWith("/sales-report/") ||
      path === "/stock-in-sales-report" ||
      path.startsWith("/stock-in-sales-report/") ||
      path === "/pos-item-replacement" ||
      path.startsWith("/pos-item-replacement/"),
  },
  {
    id: "accounts",
    labelKey: "mobileNav.accounts",
    icon: Wallet,
    destinations: [
      { title: "Accounts", href: "/accounts" },
      { title: "Parties", href: "/parties" },
      { title: "Daybook", href: "/daybook" },
      { title: "All Daybook", href: "/transaction-journal" },
      { title: "Vouchers", href: "/vouchers" },
      { title: "Agent Ledger", href: "/agents" },
      { title: "Dashboard", href: "/financial-overview" },
      { title: "Payroll", href: "/payroll" },
    ],
    isActive: (path) =>
      path === "/accounts" ||
      path.startsWith("/accounts/") ||
      path === "/parties" ||
      path.startsWith("/parties/") ||
      path === "/payroll" ||
      path.startsWith("/payroll/") ||
      path === "/daybook" ||
      path.startsWith("/daybook/") ||
      path === "/transaction-journal" ||
      path.startsWith("/transaction-journal/") ||
      path === "/vouchers" ||
      path.startsWith("/vouchers/") ||
      path === "/agents" ||
      path.startsWith("/agents/") ||
      path === "/financial-overview",
  },
];

export function ErpMobileBottomNav({ user, onMore }: ErpMobileBottomNavProps) {
  const [currentLocation, navigate] = useLocation();
  const { isItemVisible } = useErpVisibleSections(user);
  const { t } = useApplicationLanguage();
  const currentPath = currentLocation.split("?")[0] || "/";

  const visibleSections = mobileSections.flatMap((section) => {
    const destination = section.destinations.find((candidate) =>
      isItemVisible({ title: candidate.title, url: candidate.href, icon: section.icon })
    );
    return destination ? [{ ...section, href: destination.href }] : [];
  });
  const hasPrimaryMatch = visibleSections.some((section) => section.isActive(currentPath));

  return (
    <nav
      aria-label={t("mobileNav.ariaLabel")}
      data-testid="erp-mobile-bottom-nav"
      className="no-print shrink-0 border-t bg-background/95 pb-[max(0.25rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-background/90 sm:hidden"
    >
      <div
        className="grid min-h-14 items-stretch px-1"
        style={{ gridTemplateColumns: `repeat(${visibleSections.length + 1}, minmax(0, 1fr))` }}
      >
        {visibleSections.map((section) => {
          const active = section.isActive(currentPath);
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => navigate(section.href)}
              aria-current={active ? "page" : undefined}
              aria-label={t(section.labelKey)}
              data-testid={`mobile-nav-${section.id}`}
              className={`${mobileNavButtonClassName} ${
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="max-w-full truncate">{t(section.labelKey)}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={onMore}
          aria-label={t("mobileNav.more")}
          data-testid="mobile-nav-more"
          className={`${mobileNavButtonClassName} ${
            hasPrimaryMatch
              ? "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              : "bg-primary/10 text-primary"
          }`}
        >
          <MoreHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("mobileNav.more")}</span>
        </button>
      </div>
    </nav>
  );
}
