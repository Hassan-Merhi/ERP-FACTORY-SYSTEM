import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { AlertTriangle, ArrowRight, KeyRound, MessageCircle, Search, Settings } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { translateApprovedInterfaceText } from "@/components/ApplicationInterfaceTranslator";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  ERP_NAV_SECTIONS,
  ERP_PINNED_ITEMS,
  ERP_UTILITY_ITEMS,
  SETTINGS_HIDDEN_ROLES,
  useErpVisibleSections,
} from "@/components/AppSidebar";
import { useErpPrimaryDestinations } from "@/components/ErpMobileBottomNav";
import { NAV_COLOR, type NavItem } from "@/components/sidebar/sidebarPrimitives";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { liveCountQueryPolicy } from "@/lib/queryPolicies";
import { SUPPLIER_PARTNER_SECTIONS } from "@/lib/supplier-partner-navigation";
import { cn } from "@/lib/utils";

interface NavSheetUser {
  username?: string | null;
  currentRole?: string | null;
  role?: string | null;
}

interface ErpMobileNavSheetProps {
  user?: NavSheetUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PhoneNavGroup {
  label: string;
  color: string;
  items: Array<NavItem & { badge?: number }>;
}

/**
 * Phone page groups. The desktop sidebar splits these pages between a draggable pinned list and
 * collapsible sections; on a phone they read as one list grouped by the bottom-nav areas.
 */
const PHONE_GROUP_ORDER: Array<{ label: string; color: string; urls: string[] }> = [
  {
    label: "Accounting",
    color: NAV_COLOR.accounting,
    urls: [
      "/financial-overview",
      "/accounts",
      "/parties",
      "/daybook",
      "/transaction-journal",
      "/vouchers",
      "/agents",
      "/payroll",
    ],
  },
  { label: "Tracking", color: NAV_COLOR.pinned, urls: ["/tracking"] },
];

function normalisePath(href: string) {
  return href.split(/[?#]/)[0] || "/";
}

/**
 * The ERP phone page menu behind the bottom navigation's **More** button: every page the user can
 * open that the bottom navigation does not already show, grouped under clear headings. It closes
 * after navigation. Tablet and desktop keep the sidebar.
 */
export function ErpMobileNavSheet({ user, open, onOpenChange }: ErpMobileNavSheetProps) {
  const [location] = useLocation();
  const [query, setQuery] = useState("");
  const { t, language } = useApplicationLanguage();
  const { selectedCompany } = useCompany();
  const { conflictCount } = useConnectivity();
  const { isItemVisible } = useErpVisibleSections(user);
  const primaryHrefs = useErpPrimaryDestinations(user);
  const currentRole = user?.currentRole ?? user?.role ?? "";
  const isDeveloper = currentRole === "Developer";

  const { data: chatUnread } = useQuery<{ count: number }>({
    queryKey: companyQueryKey("/api/chat/unread-count", selectedCompany?.id),
    ...liveCountQueryPolicy(60_000),
    enabled: open && !!user && !!selectedCompany?.id,
  });

  const groups = useMemo<PhoneNavGroup[]>(() => {
    const primary = new Set(primaryHrefs);
    const seen = new Set<string>();
    const keep = (item: NavItem) => {
      if (seen.has(item.url) || primary.has(item.url) || !isItemVisible(item)) return false;
      seen.add(item.url);
      return true;
    };
    const allItems = [...ERP_PINNED_ITEMS, ...ERP_NAV_SECTIONS.flatMap((section) => section.items)];
    const byUrl = new Map(allItems.map((item) => [item.url, item]));

    const result: PhoneNavGroup[] = [];
    // Groups sharing a label (the phone Accounting group and the sidebar's section) merge.
    const pushGroup = (label: string, color: string, items: PhoneNavGroup["items"]) => {
      const existing = result.find((group) => group.label === label);
      if (existing) existing.items.push(...items);
      else result.push({ label, color, items });
    };
    for (const group of PHONE_GROUP_ORDER) {
      const items = group.urls.flatMap((url) => {
        const item = byUrl.get(url);
        return item && keep(item) ? [item] : [];
      });
      pushGroup(group.label, group.color, items);
    }
    for (const section of ERP_NAV_SECTIONS) {
      if (section.devOnly && !isDeveloper) continue;
      pushGroup(section.label, section.color, section.items.filter(keep));
    }
    // Pinned pages that no phone group claims still appear, so nothing becomes unreachable.
    pushGroup("Workspace", NAV_COLOR.pinned, ERP_PINNED_ITEMS.filter(keep));
    if (selectedCompany?.companyType === "supplier_partner") {
      for (const section of SUPPLIER_PARTNER_SECTIONS) {
        pushGroup(section.label, section.color, section.items.filter(keep));
      }
    }
    pushGroup("Tools", NAV_COLOR.utility, ERP_UTILITY_ITEMS.filter(keep));

    const account: PhoneNavGroup["items"] = [];
    if (isItemVisible({ title: "Chat", url: "/chat", icon: MessageCircle })) {
      account.push({ title: "Chat", url: "/chat", icon: MessageCircle, badge: chatUnread?.count });
    }
    if (conflictCount > 0) {
      account.push({ title: "Conflicts", url: "/conflicts", icon: AlertTriangle, badge: conflictCount });
    }
    if (!SETTINGS_HIDDEN_ROLES.has(currentRole)) {
      account.push({ title: "My Settings", url: "/my-settings", icon: KeyRound });
    }
    account.push({ title: "IC Requests", url: "/intercompany-requests", icon: ArrowRight });
    if (isItemVisible({ title: "Settings", url: "/settings", icon: Settings })) {
      account.push({ title: "Settings", url: "/settings", icon: Settings });
    }
    if (isItemVisible({ title: "IC Links", url: "/intercompany-links", icon: Settings })) {
      account.push({ title: "IC Links", url: "/intercompany-links", icon: ArrowRight });
    }
    pushGroup("Settings", NAV_COLOR.utility, account);

    return result.filter((group) => group.items.length > 0);
  }, [
    chatUnread?.count,
    conflictCount,
    currentRole,
    isDeveloper,
    isItemVisible,
    primaryHrefs,
    selectedCompany?.companyType,
  ]);

  const needle = query.trim().toLowerCase();
  // Users search in the language they read, so match the localised name as well as the English one.
  const matches = (text: string) =>
    text.toLowerCase().includes(needle) ||
    (translateApprovedInterfaceText(text, language) ?? "").toLowerCase().includes(needle);
  const filtered = needle
    ? groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => matches(item.title) || matches(group.label)),
        }))
        .filter((group) => group.items.length > 0)
    : groups;
  const currentPath = normalisePath(location);

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery("");
    onOpenChange(next);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="erp-mobile-nav-sheet"
        // Page names are English literals; the interface translator localises portalled content
        // only when it is marked.
        data-i18n-portal=""
        // Focusing the search field would raise the phone keyboard over the list on every open.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // flex-nowrap: the global phone rule that wraps `.flex.gap-*` would split this height-capped
        // column into side-by-side columns (the old phone sidebar's two-column mess).
        className="mx-auto max-h-[calc(var(--erp-visual-viewport-height,var(--app-viewport-height))-2.5rem)] !flex-nowrap gap-0 rounded-t-2xl p-0 sm:p-0"
      >
        <div className="flex shrink-0 flex-col !flex-nowrap gap-3 border-b px-4 pb-3 pt-4 text-start">
          <SheetTitle className="pe-10">{t("mobileNav.allPages")}</SheetTitle>
          <SheetDescription className="sr-only">{t("mobileNav.allPagesDescription")}</SheetDescription>
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("mobileNav.findPage")}
              aria-label={t("mobileNav.findPage")}
              data-testid="erp-mobile-nav-search"
              className="min-h-11 ps-9 text-base"
            />
          </div>
        </div>
        <nav
          aria-label={t("mobileNav.allPages")}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[max(1rem,var(--safe-area-bottom))] pt-2"
        >
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="erp-mobile-nav-empty">
              {t("mobileNav.noPages")}
            </p>
          )}
          {filtered.map((group) => (
            <section
              key={group.label}
              className="mb-2"
              data-testid={`erp-mobile-nav-group-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            >
              <h2
                className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide"
                style={{ color: group.color }}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
                {group.label}
              </h2>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = currentPath === normalisePath(item.url);
                  return (
                    <li key={item.url}>
                      <Link
                        href={item.url}
                        onClick={() => handleOpenChange(false)}
                        aria-current={active ? "page" : undefined}
                        data-testid={`erp-mobile-nav-link-${item.url}`}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors touch-manipulation",
                          active ? "bg-primary/10 font-semibold text-primary" : "text-foreground hover:bg-muted/60"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        {item.badge != null && item.badge > 0 && (
                          <Badge variant="default" className="min-w-5 justify-center text-xs">
                            {item.badge}
                          </Badge>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
