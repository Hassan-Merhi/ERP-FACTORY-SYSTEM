import { useState, useEffect, useRef, ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ChevronDown, GripVertical, LogOut, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SidebarHeader, SidebarFooter } from "@/components/ui/sidebar";
import { useConnectivity } from "@/contexts/ConnectivityContext";

/**
 * A navigation glyph. Every call site passes a lucide-react icon, which is a
 * component taking the SVG props these primitives set (`className`, `style`).
 * Typing it this way rather than as `any` means a non-component — or a
 * component that cannot be styled — is rejected at the definition site.
 */
export type NavIcon = LucideIcon;

export interface NavItem {
  title: string;
  url: string;
  icon: NavIcon;
}

export interface NavSection {
  label: string;
  /** CSS color value (e.g. `hsl(var(--nav-inventory))`) used for active accent. */
  color: string;
  items: NavItem[];
  /** When true, section is only shown to Developer-role users. */
  devOnly?: boolean;
}

const baseLinkClasses = "relative flex items-center gap-2.5 rounded-md py-1.5 pl-3 pr-2.5 text-sm transition-colors";
const inactiveClasses = "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground";
const activeClasses = "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-xs";

interface ActiveRailProps {
  color: string;
}
function ActiveRail({ color }: ActiveRailProps) {
  return (
    <span
      aria-hidden
      className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full"
      style={{ backgroundColor: color }}
    />
  );
}

interface SidebarNavLinkProps {
  item: NavItem;
  color: string;
  testId: string;
  trailing?: ReactNode;
  draggable?: boolean;
}

export function SidebarNavLink({ item, color, testId, trailing, draggable }: SidebarNavLinkProps) {
  const [location] = useLocation();
  const isActive = location === item.url;
  const Icon = item.icon;
  return (
    <Link
      href={item.url}
      draggable={draggable === false ? false : undefined}
      data-testid={testId}
      className={`${baseLinkClasses} ${isActive ? activeClasses : inactiveClasses} flex-1`}
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
      <span className="flex-1 leading-tight">{item.title}</span>
      {trailing}
    </Link>
  );
}

interface SidebarFlatLinkProps {
  href: string;
  icon: NavIcon;
  label: string;
  color?: string;
  badge?: number;
  testId: string;
  trailing?: ReactNode;
}

export function SidebarFlatLink({
  href,
  icon: Icon,
  label,
  color = "hsl(var(--nav-utility))",
  badge,
  testId,
  trailing,
}: SidebarFlatLinkProps) {
  const [location] = useLocation();
  const isActive = location === href;
  return (
    <Link
      href={href}
      data-testid={testId}
      className={`${baseLinkClasses} ${isActive ? activeClasses : inactiveClasses}`}
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
      <span className="flex-1 leading-tight">{label}</span>
      {badge != null && badge > 0 && (
        <Badge variant="default" className="text-xs min-w-5 justify-center">
          {badge}
        </Badge>
      )}
      {trailing}
    </Link>
  );
}

interface SidebarSectionGroupProps {
  section: NavSection;
  isOpen: boolean;
  onToggle: () => void;
  testIdFor: (item: NavItem) => string;
  trailingFor?: (item: NavItem) => ReactNode;
  sectionTestId: string;
}

export function SidebarSectionGroup({
  section,
  isOpen,
  onToggle,
  testIdFor,
  trailingFor,
  sectionTestId,
}: SidebarSectionGroupProps) {
  const [location] = useLocation();
  const hasActive = section.items.some((i) => location === i.url);
  return (
    <div>
      <button
        onClick={onToggle}
        data-testid={sectionTestId}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left transition-colors hover:bg-sidebar-accent/30"
      >
        <span
          className="h-1.5 w-1.5 rounded-full shrink-0 transition-opacity"
          style={{ backgroundColor: section.color, opacity: hasActive ? 1 : 0.55 }}
        />
        <span
          className="flex-1 text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: section.color, opacity: hasActive ? 1 : 0.65 }}
        >
          {section.label}
        </span>
        <ChevronDown
          className="h-3 w-3 shrink-0 transition-transform duration-200"
          style={{
            color: section.color,
            opacity: 0.65,
            transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
          }}
        />
      </button>
      {isOpen && (
        <div className="mt-0.5 space-y-0.5 ml-[13px] border-l-2" style={{ borderColor: `${section.color}28` }}>
          {section.items.map((item) => (
            <SidebarNavLink
              key={item.url}
              item={item}
              color={section.color}
              testId={testIdFor(item)}
              trailing={trailingFor?.(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function useOpenSections(visibleSections: NavSection[], options: { defaultFirstWhenNoneActive?: boolean } = {}) {
  const [location] = useLocation();
  const activeSection = visibleSections.find((s) => s.items.some((i) => location === i.url));
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
      const saved = raw ? (JSON.parse(raw) as string[]) : null;
      const defaultUrls = defaults.map((i) => i.url);
      if (saved && defaultUrls.every((u) => saved.includes(u))) {
        return saved.filter((u) => defaultUrls.includes(u));
      }
      return defaultUrls;
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
        const isActive = location === item.url;
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
              className="flex items-center justify-center w-5 py-1.5 cursor-grab opacity-0 group-hover:opacity-40 shrink-0"
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
              <span className="flex-1 leading-tight">{item.title}</span>
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

export function ModuleHeader({ icon: Icon, label, tagline, accent }: ModuleHeaderProps) {
  const badgeLabel = tagline.split("/")[0].trim();
  return (
    <SidebarHeader
      className="px-4 py-4 border-b border-sidebar-border relative overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${accent}30 0%, ${accent}10 55%, transparent 100%)`,
      }}
    >
      {/* subtle radial glow behind the icon */}
      <div
        className="absolute -top-4 -left-4 h-20 w-20 rounded-full pointer-events-none"
        style={{ background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)` }}
      />
      <div className="flex items-center gap-3 relative">
        {/* Icon tile — layered depth */}
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white"
          style={{
            backgroundColor: accent,
            boxShadow: `0 3px 16px ${accent}66, inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.15)`,
          }}
        >
          <Icon className="h-5 w-5 drop-shadow-sm" />
        </div>
        <div className="flex flex-col min-w-0 gap-0.5">
          <span className="text-sm font-bold leading-tight">{label}</span>
          {/* Module badge beneath title */}
          <span
            className="inline-flex w-fit items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest"
            style={{ backgroundColor: `${accent}22`, color: accent }}
          >
            {badgeLabel}
          </span>
        </div>
      </div>
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
}

export function ModuleFooter({ user, avatarClassName, accent }: ModuleFooterProps) {
  const initials = user?.username ? user.username.substring(0, 2).toUpperCase() : "AD";
  const { isOnline } = useConnectivity();

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Best-effort side request; the user-visible flow does not depend on it completing.
    }
    window.location.href = "/login";
  };

  return (
    <SidebarFooter
      className="px-4 py-3 border-t border-sidebar-border relative overflow-hidden"
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
          onClick={handleLogout}
          title="Log out"
          data-testid="button-sidebar-logout"
          className="shrink-0 text-muted-foreground"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground/40 font-mono tracking-wide select-none">V.2.5</span>
        <span className="text-[10px] text-muted-foreground/40 select-none">© Dakzo Systems.</span>
      </div>
    </SidebarFooter>
  );
}

/** Module color tokens for ModuleHeader/Footer accents. */
export const MODULE_ACCENT = {
  erp: "hsl(var(--module-erp))",
  factory: "hsl(var(--module-factory))",
  properties: "hsl(var(--module-properties))",
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
