import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

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

/**
 * Phone voucher-type selector. Seven types do not fit a phone row (four were off-screen in the
 * old scrolling strip), so the current type is one full-width control that opens a grouped
 * sheet of every type the user may use. Tablet and desktop keep the sidebar nav.
 */
export function VoucherMobileTabs({ visibleSidebarGroups, activeTab, setActiveTab }: VoucherTabNavProps) {
  const [open, setOpen] = useState(false);
  const activeGroup = visibleSidebarGroups.find((group) => group.items.some((item) => item.key === activeTab));
  const active = activeGroup?.items.find((item) => item.key === activeTab);
  const ActiveIcon = active?.icon;

  return (
    <div className="sm:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            className="flex min-h-12 w-full items-center gap-3 rounded-xl border bg-card px-3 text-start"
            data-testid="button-voucher-type-select"
            aria-label={`Voucher type: ${active?.label ?? ""}`}
          >
            {ActiveIcon && (
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                style={
                  activeGroup ? { backgroundColor: `${activeGroup.color}22`, color: activeGroup.color } : undefined
                }
              >
                <ActiveIcon className="h-4 w-4" aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Voucher type
              </span>
              <span className="block truncate text-sm font-semibold">{active?.label}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          data-i18n-portal=""
          className="mx-auto max-h-[calc(var(--erp-visual-viewport-height,var(--app-viewport-height))-2.5rem)] !flex-nowrap gap-0 rounded-t-2xl p-0"
          data-testid="sheet-voucher-types"
        >
          <div className="border-b px-4 pb-3 pt-4">
            <SheetTitle className="pe-10">Voucher type</SheetTitle>
            <SheetDescription className="sr-only">Choose the voucher to enter.</SheetDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1rem,var(--safe-area-bottom))] pt-2">
            {visibleSidebarGroups.map((group) => (
              <section key={group.label} className="mb-2">
                <h2
                  className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide"
                  style={{ color: group.color }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: group.color }} />
                  {group.label}
                </h2>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.key);
                        setOpen(false);
                      }}
                      aria-current={isActive ? "true" : undefined}
                      data-testid={`tab-mobile-${item.key}`}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm",
                        isActive ? "bg-primary/10 font-semibold text-primary" : "hover:bg-muted/60"
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="flex-1">{item.label}</span>
                      {isActive && <Check className="h-4 w-4" aria-hidden="true" />}
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
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
