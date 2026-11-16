// Extracted from ./sidebarPrimitives.tsx to keep that module under the source-size cap.
import { ReactNode, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Building2,
  ChevronDown,
  Factory,
  Landmark,
  Layers,
  type LucideIcon,
  Package,
  Sparkles,
  Store,
  Truck,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Styleable lucide-react navigation icon. */
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

export const baseLinkClasses =
  "premium-nav-link relative flex items-center gap-2.5 rounded-md py-1.5 pl-3 pr-2.5 text-sm transition-colors";

export const inactiveClasses = "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground";

export const activeClasses =
  "premium-nav-active bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-2xs";

const SECTION_ICONS: Record<string, LucideIcon> = {
  production: Factory,
  inventory: Package,
  "sales & loading": Truck,
  "sales & pos": Store,
  finance: Wallet,
  accounting: Landmark,
  "accounting tools": Landmark,
  analytics: BarChart3,
  rentals: Building2,
  intelligence: Sparkles,
  operations: Layers,
  reports: BarChart3,
  "ai tools": Sparkles,
};

function canonicalSidebarPath(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const cutAt = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const normalized = cutAt === undefined ? url : url.slice(0, cutAt);
  return normalized || "/";
}

export function sidebarPathMatches(location: string, href: string): boolean {
  return canonicalSidebarPath(location) === canonicalSidebarPath(href);
}

interface ActiveRailProps {
  color: string;
}

export function ActiveRail({ color }: ActiveRailProps) {
  return (
    <span
      aria-hidden
      className="premium-nav-active-rail absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full"
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
  const isActive = sidebarPathMatches(location, item.url);
  const Icon = item.icon;
  const linkRef = useRef<HTMLAnchorElement>(null);
  // A long section list (the phone drawer especially) opens with the current page in view.
  useEffect(() => {
    if (isActive) linkRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [isActive]);
  return (
    <Link
      ref={linkRef}
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
      <span className="min-w-0 flex-1 wrap-break-word leading-tight">{item.title}</span>
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
  const isActive = sidebarPathMatches(location, href);
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
      <span className="min-w-0 flex-1 wrap-break-word leading-tight">{label}</span>
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
  const hasActive = section.items.some((i) => sidebarPathMatches(location, i.url));
  const SectionIcon = SECTION_ICONS[section.label.toLowerCase()] ?? Layers;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        data-testid={sectionTestId}
        className="premium-nav-section flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left transition-colors hover:bg-sidebar-accent/30"
      >
        <span
          className="premium-nav-section-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ color: section.color, backgroundColor: `color-mix(in srgb, ${section.color} 17%, transparent)` }}
        >
          <SectionIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span
          className="flex-1 text-[11px] font-semibold uppercase tracking-widest"
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
