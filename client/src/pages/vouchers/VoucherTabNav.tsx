import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  color: string;
  items: NavItem[];
}

interface VoucherTabNavProps {
  visibleSidebarGroups: NavGroup[];
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export function VoucherMobileTabs({ visibleSidebarGroups, activeTab, setActiveTab }: VoucherTabNavProps) {
  return (
    <div className="sm:hidden -mx-4 px-4 overflow-x-auto">
      <div className="flex gap-1.5 pb-1 w-max">
        {visibleSidebarGroups.flatMap((group) =>
          group.items.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                data-testid={`tab-mobile-${item.key}`}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-sm font-medium border transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground border-accent/60"
                    : "bg-transparent text-muted-foreground border-border hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {item.label}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function VoucherDesktopNav({ visibleSidebarGroups, activeTab, setActiveTab }: VoucherTabNavProps) {
  return (
    <nav
      // A landscape phone is wide enough for the sm sidebar but only ~390px tall, so the full
      // voucher-type list is taller than the screen. Sticky means it never scrolls up, which
      // left the lower voucher types permanently unreachable. Cap it to the visible height and
      // let it scroll internally; taller viewports never reach the cap, so nothing changes there.
      className="hidden sm:flex flex-col w-52 shrink-0 rounded-xl border bg-card p-2 gap-3 self-start sticky top-4 max-h-[calc(var(--app-viewport-height)-6rem)] overflow-y-auto overscroll-contain"
      style={{ zIndex: 10 }}
    >
      {visibleSidebarGroups.map((group, groupIdx) => (
        <div key={group.label}>
          {groupIdx > 0 && <div className="border-t -mx-2 mb-1" />}
          <div className="flex items-center gap-1.5 px-2 mb-1 mt-0.5">
            <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: group.color }} />
            <p
              className="text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: group.color, opacity: 0.85 }}
            >
              {group.label}
            </p>
          </div>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  data-testid={`tab-${item.key}`}
                  className={cn(
                    "relative w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-sm transition-colors text-left",
                    isActive
                      ? "font-medium"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground font-normal"
                  )}
                  style={isActive ? { backgroundColor: `${group.color}18`, color: group.color } : undefined}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full"
                      style={{ backgroundColor: group.color }}
                    />
                  )}
                  {isActive ? (
                    <span
                      className="flex h-6 w-6 items-center justify-center rounded-md shrink-0"
                      style={{ backgroundColor: `${group.color}22` }}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: group.color }} />
                    </span>
                  ) : (
                    <Icon className="h-4 w-4 shrink-0" />
                  )}
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
