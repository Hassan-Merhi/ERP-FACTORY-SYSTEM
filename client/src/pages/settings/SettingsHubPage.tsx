import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Users,
  Building2,
  Settings2,
  Wrench,
  ShoppingCart,
  Download,
  MessageCircle,
  Database,
  Shield,
  ChevronRight,
  Search,
  AlertTriangle,
  Zap,
  Factory,
  Activity,
  ImageIcon,
} from "lucide-react";

interface HubCategory {
  key: string;
  title: string;
  description: string;
  icon: React.ElementType;
  colorClass: string;
  iconColorClass: string;
  keywords: string[];
  firstSection: string;
  href?: string;
  adminOnly?: boolean;
  devOnly?: boolean;
  dangerous?: boolean;
  factoryOnly?: boolean;
  nonFactory?: boolean;
  badge?: string;
  group: "core" | "operations" | "controls";
}

const HUB_CATEGORIES: HubCategory[] = [
  {
    key: "users-permissions",
    title: "Users & Permissions",
    description: "Manage users, roles, module access, and page visibility controls",
    icon: Users,
    colorClass: "bg-blue-500/10",
    iconColorClass: "text-blue-500",
    adminOnly: true,
    keywords: ["users", "roles", "permissions", "access", "visibility", "password", "login", "factory access", "page"],
    firstSection: "users-permissions",
    group: "core",
  },
  {
    key: "company",
    title: "Company & Modules",
    description: "Manage companies and display preferences",
    icon: Building2,
    colorClass: "bg-indigo-500/10",
    iconColorClass: "text-indigo-500",
    keywords: ["company", "companies", "preferences", "date format"],
    firstSection: "companies",
    group: "core",
  },
  {
    key: "reports",
    title: "Reports & Exports",
    description: "Daily exports, stock reports, net position, and export center",
    icon: Download,
    colorClass: "bg-orange-500/10",
    iconColorClass: "text-orange-500",
    keywords: ["reports", "exports", "daily", "stock", "net", "position", "export", "accounts"],
    firstSection: "export-center",
    group: "operations",
  },
  {
    key: "notifications",
    title: "WhatsApp & Notifications",
    description: "WhatsApp exports, group settings, and automated report delivery",
    icon: MessageCircle,
    colorClass: "bg-emerald-500/10",
    iconColorClass: "text-emerald-500",
    keywords: ["whatsapp", "notifications", "groups", "alerts", "auto send", "messaging"],
    firstSection: "whatsapp-export",
    group: "operations",
  },
  {
    key: "pos",
    title: "POS Settings",
    description: "POS settings, exchange rates, fiscal periods, price groups, and intercompany auto-transfer",
    icon: ShoppingCart,
    colorClass: "bg-yellow-500/10",
    iconColorClass: "text-yellow-600",
    nonFactory: true,
    devOnly: true,
    keywords: ["pos", "point of sale", "price", "groups", "receipt", "intercompany", "transfer"],
    firstSection: "pos-setup",
    group: "operations",
  },
  {
    key: "data-tools",
    title: "Data Tools",
    description: "File storage, bulk rename, and data management",
    icon: Database,
    colorClass: "bg-purple-500/10",
    iconColorClass: "text-purple-500",
    keywords: ["data", "files", "storage", "bulk", "rename", "backup"],
    firstSection: "files",
    group: "controls",
    devOnly: true,
  },
  {
    key: "security",
    title: "Security & Audit",
    description: "Edit log, login history, and change tracking across the system",
    icon: Shield,
    colorClass: "bg-red-500/10",
    iconColorClass: "text-red-500",
    keywords: ["security", "audit", "log", "history", "login", "sessions", "changes", "edit log"],
    firstSection: "edit-log",
    group: "controls",
  },
  {
    key: "system",
    title: "System Tools",
    description: "Maintenance, repair tools, diagnostics, and advanced operations",
    icon: Wrench,
    colorClass: "bg-slate-500/10",
    iconColorClass: "text-slate-500",
    adminOnly: true,
    dangerous: true,
    keywords: ["system", "tools", "repair", "diagnostics", "maintenance", "developer", "reset", "orphaned", "fix"],
    firstSection: "system",
    badge: "Admin",
    group: "controls",
  },
  {
    key: "sessions-hub",
    title: "Sessions & Users",
    description: "Monitor active sessions and watch live user activity in real-time",
    icon: Shield,
    colorClass: "bg-cyan-500/10",
    iconColorClass: "text-cyan-500",
    keywords: [
      "active",
      "users",
      "watch",
      "screen",
      "live",
      "session",
      "presence",
      "monitor",
      "factory",
      "erp",
      "sessions",
    ],
    firstSection: "sessions-hub",
    group: "controls",
    devOnly: true,
  },
  {
    key: "approvals",
    title: "Approval Requests",
    description: "Review and action risky operations that need a second set of eyes before proceeding",
    icon: Activity,
    colorClass: "bg-violet-500/10",
    iconColorClass: "text-violet-500",
    keywords: ["approvals", "requests", "review", "pending", "action", "authorize", "sign off"],
    firstSection: "approvals",
    group: "controls",
  },
  {
    key: "business-alerts",
    title: "Business Alerts",
    description: "Automated checks for negative stock, large withdrawals, pending approvals, and import errors",
    icon: AlertTriangle,
    colorClass: "bg-amber-500/10",
    iconColorClass: "text-amber-500",
    keywords: ["alerts", "warnings", "negative stock", "overdue", "checks", "business", "monitoring"],
    firstSection: "business-alerts",
    group: "controls",
  },
  {
    key: "label-banners",
    title: "Label Banner Images",
    description: "Add custom color slots, upload banner images, and manage the design picker for A4 bale labels",
    icon: ImageIcon,
    colorClass: "bg-purple-500/10",
    iconColorClass: "text-purple-500",
    adminOnly: true,
    keywords: [
      "label",
      "banner",
      "image",
      "color",
      "bale",
      "design",
      "print",
      "factory",
      "upload",
      "purple",
      "green",
      "gold",
    ],
    firstSection: "label-banners",
    href: "/factory/label-banners",
    factoryOnly: true,
    badge: "Admin",
    group: "controls",
  },
];

const QUICK_ACCESS_KEYS = ["users-permissions", "company", "notifications", "security"];

const GROUPS: { key: "core" | "operations" | "controls"; label: string; subtitle: string }[] = [
  { key: "core", label: "Core", subtitle: "Users, companies, and accounting" },
  { key: "operations", label: "Operations", subtitle: "Reports, POS, and messaging" },
  { key: "controls", label: "Controls", subtitle: "Data, security, and system tools" },
];

interface SettingsHubPageProps {
  onNavigate: (section: string) => void;
  currentUser?: { role?: string };
  appMode?: string;
}

export function SettingsHubPage({ onNavigate, currentUser, appMode }: SettingsHubPageProps) {
  const [search, setSearch] = useState("");

  const role = currentUser?.role;
  const isFactory = appMode === "factory";
  const _isAdmin = role === "Admin" || role === "Developer" || role === "Owner";
  const isDev = role === "Developer";

  const visibleCategories = useMemo(() => {
    return HUB_CATEGORIES.filter((cat) => {
      if (cat.devOnly && !isDev) return false;
      if (cat.nonFactory && isFactory) return false;
      if (cat.factoryOnly && !isFactory) return false;
      return true;
    });
  }, [isFactory, isDev]);

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return visibleCategories;
    return visibleCategories.filter((cat) => searchAny(search, cat.title, cat.description, ...cat.keywords));
  }, [search, visibleCategories]);

  const hiddenCount = HUB_CATEGORIES.length - visibleCategories.length;
  const isSearching = search.trim().length > 0;

  const quickAccessCards = useMemo(
    () => visibleCategories.filter((c) => QUICK_ACCESS_KEYS.includes(c.key)),
    [visibleCategories]
  );

  const groupedResults = useMemo(() => {
    if (isSearching) return null;
    return GROUPS.map((g) => ({
      ...g,
      items: visibleCategories.filter((c) => c.group === g.key),
    })).filter((g) => g.items.length > 0);
  }, [isSearching, visibleCategories]);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── Hero ── */}
      <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background border-b">
        <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 md:py-12">
          <div className="flex flex-col md:flex-row md:items-start gap-6">
            {/* Left: heading + search */}
            <div className="flex-1 space-y-5">
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Settings2 className="h-6 w-6 text-primary" />
                  <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings Hub</h1>
                  <Badge className="text-xs">New</Badge>
                  {isFactory && (
                    <Badge variant="outline" className="text-xs gap-1">
                      <Factory className="h-3 w-3" />
                      Factory Mode
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-sm md:text-base max-w-lg">
                  Configure your system, manage users, permissions, and tools from one place.
                </p>
              </div>

              {/* Search bar */}
              <div className="relative max-w-xl">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search settings — users, permissions, exports, POS, audit…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10 h-11 rounded-xl bg-background/80 backdrop-blur-sm shadow-sm"
                  data-testid="input-settings-search"
                />
              </div>
            </div>

            {/* Right: stats card */}
            <Card className="shrink-0 p-4 md:min-w-[200px] space-y-3 bg-background/70 backdrop-blur-sm shadow-sm">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Overview</p>
              <div className="space-y-2">
                <StatRow label="Visible areas" value={visibleCategories.length} />
                <StatRow label="Shown results" value={filteredCategories.length} highlight={isSearching} />
                <StatRow label="Hidden areas" value={hiddenCount} muted />
                <div className="pt-1 border-t">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Your role</span>
                    <Badge variant="secondary" className="text-xs">
                      {role ?? "Viewer"}
                    </Badge>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-8">
        {/* ── Search results ── */}
        {isSearching ? (
          filteredCategories.length === 0 ? (
            <EmptyState onClear={() => setSearch("")} />
          ) : (
            <section className="space-y-3">
              <SectionHeader
                label={`${filteredCategories.length} result${filteredCategories.length !== 1 ? "s" : ""} for "${search}"`}
                subtitle=""
              />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredCategories.map((cat) => (
                  <SettingsCard key={cat.key} cat={cat} onNavigate={onNavigate} />
                ))}
              </div>
            </section>
          )
        ) : (
          <>
            {/* ── Quick access ── */}
            {quickAccessCards.length > 0 && (
              <section className="space-y-3">
                <SectionHeader label="Quick Access" subtitle="Frequently used settings">
                  <Zap className="h-4 w-4 text-primary" />
                </SectionHeader>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {quickAccessCards.map((cat) => (
                    <QuickCard key={cat.key} cat={cat} onNavigate={onNavigate} />
                  ))}
                </div>
              </section>
            )}

            {/* ── Grouped sections ── */}
            {groupedResults?.map((group) => (
              <section key={group.key} className="space-y-3">
                <SectionHeader label={group.label} subtitle={group.subtitle} />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((cat) => (
                    <SettingsCard key={cat.key} cat={cat} onNavigate={onNavigate} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function StatRow({
  label,
  value,
  highlight,
  muted,
}: {
  label: string;
  value: number;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={`text-xs ${muted ? "text-muted-foreground/60" : "text-muted-foreground"}`}>{label}</span>
      <span
        className={`text-sm font-semibold tabular-nums ${highlight ? "text-primary" : muted ? "text-muted-foreground/60" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function SectionHeader({ label, subtitle, children }: { label: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <div>
        <h2 className="text-sm font-semibold leading-none">{label}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function QuickCard({ cat, onNavigate }: { cat: HubCategory; onNavigate: (s: string) => void }) {
  const Icon = cat.icon;
  const [, setLocation] = useLocation();
  return (
    <Card
      className="p-4 cursor-pointer hover-elevate transition-shadow group flex flex-col gap-3"
      onClick={() => (cat.href ? setLocation(cat.href) : onNavigate(cat.firstSection))}
      data-testid={`card-quick-${cat.key}`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${cat.colorClass}`}>
        <Icon className={`h-5 w-5 ${cat.iconColorClass}`} />
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-sm font-medium leading-tight">{cat.title}</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 -translate-x-1 group-hover:translate-x-0 transition-transform" />
      </div>
    </Card>
  );
}

function SettingsCard({ cat, onNavigate }: { cat: HubCategory; onNavigate: (s: string) => void }) {
  const Icon = cat.icon;
  const [, setLocation] = useLocation();
  return (
    <Card
      className="p-5 cursor-pointer hover-elevate transition-shadow group"
      onClick={() => (cat.href ? setLocation(cat.href) : onNavigate(cat.firstSection))}
      data-testid={`card-settings-${cat.key}`}
    >
      <div className="flex items-start gap-4">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${cat.colorClass}`}>
          <Icon className={`h-5 w-5 ${cat.iconColorClass}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="font-semibold text-sm leading-tight">{cat.title}</h3>
            {cat.dangerous && (
              <Badge variant="outline" className="text-xs text-destructive border-destructive/40 gap-1 py-0">
                <AlertTriangle className="h-2.5 w-2.5" />
                Dangerous
              </Badge>
            )}
            {cat.badge && !cat.dangerous && (
              <Badge variant="outline" className="text-xs py-0">
                {cat.badge}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">{cat.description}</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5 -translate-x-1 group-hover:translate-x-0 transition-transform" />
      </div>
    </Card>
  );
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <Card className="py-16 flex flex-col items-center gap-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
        <Search className="h-6 w-6 text-muted-foreground opacity-50" />
      </div>
      <div className="space-y-1">
        <p className="font-semibold">No settings found</p>
        <p className="text-sm text-muted-foreground">Try a different keyword or browse all sections below.</p>
      </div>
      <Button variant="outline" size="sm" onClick={onClear} data-testid="button-clear-search">
        Clear search
      </Button>
    </Card>
  );
}
