import { useState, useEffect, useRef, ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { GripVertical, LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SidebarHeader, SidebarFooter } from "@/components/ui/sidebar";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { reconcilePinnedOrder } from "./pinnedOrder";
import { SeasonalBrandAccent } from "@/components/SeasonalBrandAccent";
import { DakzoBrand } from "@/components/DakzoBrand";
import {
  ActiveRail,
  activeClasses,
  baseLinkClasses,
  inactiveClasses,
  sidebarPathMatches,
  type NavIcon,
  type NavItem,
  type NavSection,
} from "./SidebarSectionGroup";
export { SidebarFlatLink, SidebarNavLink, SidebarSectionGroup } from "./SidebarSectionGroup";
export type { NavIcon, NavItem, NavSection } from "./SidebarSectionGroup";

export function useOpenSections(visibleSections: NavSection[], options: { defaultFirstWhenNoneActive?: boolean } = {}) {
  const [location] = useLocation();
  const activeSection = visibleSections.find((s) => s.items.some((i) => sidebarPathMatches(location, i.url)));
  const initialLabel =
    activeSection?.label ?? (options.defaultFirstWhenNoneActive ? visibleSections[0]?.label : undefined);
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(initialLabel ? [initialLabel] : []));

  const activeLabel = activeSection?.label;
  useEffect(() => {
    if (!activeLabel) return;
    setOpenSections((prev) => {
      if (prev.has(activeLabel)) return prev;
      const next = new Set(prev);
      next.add(activeLabel);
      return next;
    });
  }, [activeLabel]);

  const toggleSection = (label: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return { openSections, toggleSection };
}

export function usePinnedOrder(storageKey: string, defaults: NavItem[]) {
  const [pinnedOrder, setPinnedOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      return reconcilePinnedOrder(
        saved,
        defaults.map((i) => i.url)
      );
    } catch {
      return defaults.map((i) => i.url);
    }
  });

  const save = (next: string[]) => {
    setPinnedOrder(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
    }
  };

  const reorder = (fromUrl: string, targetUrl: string) => {
    if (fromUrl === targetUrl) return;
    const fromIdx = pinnedOrder.indexOf(fromUrl);
    const toIdx = pinnedOrder.indexOf(targetUrl);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...pinnedOrder];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, fromUrl);
    save(next);
  };

  const items: NavItem[] = pinnedOrder.map((url) => defaults.find((i) => i.url === url)).filter(Boolean) as NavItem[];

  return { items, reorder };
}

interface PinnedNavListProps {
  items: NavItem[];
  color: string;
  onReorder: (fromUrl: string, targetUrl: string) => void;
  isVisible?: (item: NavItem) => boolean;
  testIdFor: (item: NavItem) => string;
  trailingFor?: (item: NavItem) => ReactNode;
}

export function PinnedNavList({ items, color, onReorder, isVisible, testIdFor, trailingFor }: PinnedNavListProps) {
  const [location] = useLocation();
  const dragRef = useRef<string | null>(null);

  const visible = isVisible ? items.filter(isVisible) : items;
  if (visible.length === 0) return null;

  return (
    <div className="space-y-0.5 mb-2">
      {visible.map((item) => {
        const isActive = sidebarPathMatches(location, item.url);
        const Icon = item.icon;
        return (
          <div
            key={item.url}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={() => {
              const from = dragRef.current;
              if (from) onReorder(from, item.url);
              dragRef.current = null;
            }}
            className="flex items-center group"
          >
            <span
              draggable
              onDragStart={(e) => {
                e.stopPropagation();
                dragRef.current = item.url;
              }}
              aria-hidden="true"
              // Mouse-only reordering: touch browsers cannot start HTML drag-and-drop, so the handle
              // is dropped there rather than left as an invisible control that does nothing.
              className="flex items-center justify-center w-5 py-1.5 cursor-grab opacity-0 group-hover:opacity-40 shrink-0 pointer-coarse:hidden"
              title="Drag to reorder"
            >
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
            <Link
              href={item.url}
              draggable={false}
              data-testid={testIdFor(item)}
              className={`${baseLinkClasses} flex-1 ${isActive ? activeClasses : inactiveClasses}`}
            >
              {isActive && <ActiveRail color={color} />}
              {isActive ? (
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-md shrink-0"
                  style={{ backgroundColor: `${color}22` }}
                >
                  <Icon className="h-3.5 w-3.5" style={{ color }} />
                </span>
              ) : (
                <Icon className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 wrap-break-word leading-tight">{item.title}</span>
              {trailingFor?.(item)}
            </Link>
          </div>
        );
      })}
    </div>
  );
}

interface ModuleHeaderProps {
  icon: NavIcon;
  label: string;
  tagline: string;
  /** CSS color used for the brand icon tile background. */
  accent: string;
}

/** Keep a single Dakzo Systems identity across ERP, Factory and Properties.
 * Legacy module metadata remains accepted by callers but is not rendered. */
export function ModuleHeader({ accent }: ModuleHeaderProps) {
  return (
    <SidebarHeader
      className="premium-nav-brand px-4 py-3 border-b border-sidebar-border relative overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${accent}30 0%, ${accent}10 55%, transparent 100%)`,
      }}
    >
      <SeasonalBrandAccent />
      <DakzoBrand compact className="relative text-sidebar-foreground" />
    </SidebarHeader>
  );
}

interface ModuleFooterProps {
  /** Nullable because the session user's role is nullable at the API boundary. */
  user?: { username?: string | null; role?: string | null };
  /** Tailwind classes for the avatar tint (defaults to accent-colored). */
  avatarClassName?: string;
  /** Module accent color — used as avatar background when no avatarClassName is set. */
  accent?: string;
  /** Canonical app logout handler. Never duplicate session teardown in the sidebar. */
  onLogout: () => void | Promise<void>;
}

export function ModuleFooter({ user, avatarClassName, accent, onLogout }: ModuleFooterProps) {
  const initials = user?.username ? user.username.substring(0, 2).toUpperCase() : "AD";
  const { isOnline } = useConnectivity();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <SidebarFooter
      className="premium-nav-footer px-4 py-3 border-t border-sidebar-border relative overflow-hidden"
      style={{
        background: accent ? `linear-gradient(to top, ${accent}22 0%, ${accent}08 55%, transparent 100%)` : undefined,
      }}
    >
      <div className="flex items-center gap-3 relative">
        {/* Avatar with accent ring + connectivity dot */}
        <div className="relative shrink-0">
          <div
            className="rounded-full p-[2px]"
            style={{
              background: accent ? `linear-gradient(135deg, ${accent}cc, ${accent}44)` : undefined,
            }}
          >
            <Avatar className="h-8 w-8 block">
              <AvatarFallback
                className={avatarClassName ?? "text-xs font-bold text-white"}
                style={!avatarClassName && accent ? { backgroundColor: accent } : undefined}
              >
                {initials}
              </AvatarFallback>
            </Avatar>
          </div>
          {/* Online / offline dot */}
          <span
            className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar"
            style={{ backgroundColor: isOnline ? "#22c55e" : "#6b7280" }}
          />
        </div>
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-sm font-medium leading-tight truncate">{user?.username || "User"}</span>
          <span className="text-xs text-muted-foreground leading-tight">{user?.role || "Role"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void handleLogout()}
          disabled={isLoggingOut}
          title={isLoggingOut ? "Logging out…" : "Log out"}
          data-testid="button-sidebar-logout"
          className="shrink-0 text-muted-foreground"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground/40 font-mono tracking-wide select-none">V.2.5</span>
        <span className="text-[11px] text-muted-foreground/40 select-none">© Dakzo Systems.</span>
      </div>
    </SidebarFooter>
  );
}

/** Module color tokens for ModuleHeader/Footer accents. */
export const MODULE_ACCENT = {
  erp: "hsl(var(--module-erp))",
  factory: "hsl(var(--module-factory))",
  properties: "hsl(var(--module-properties))",
  /** POS keeps the violet accent its own shell used. */
  pos: "#8b5cf6",
};

/** Section color tokens for navSections. */
export const NAV_COLOR = {
  overview: "hsl(var(--nav-overview))",
  pinned: "hsl(var(--nav-pinned))",
  inventory: "hsl(var(--nav-inventory))",
  sales: "hsl(var(--nav-sales))",
  accounting: "hsl(var(--nav-accounting))",
  analytics: "hsl(var(--nav-analytics))",
  rentals: "hsl(var(--nav-rentals))",
  finance: "hsl(var(--nav-finance))",
  operations: "hsl(var(--nav-operations))",
  bales: "hsl(var(--nav-bales))",
  reports: "hsl(var(--nav-reports))",
  intelligence: "hsl(var(--nav-intelligence))",
  utility: "hsl(var(--nav-utility))",
};
