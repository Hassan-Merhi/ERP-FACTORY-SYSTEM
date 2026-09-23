import { BookOpen, Boxes, Menu, ShoppingCart, Wallet } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useErpVisibleSections } from "@/components/AppSidebar";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface ErpMobileBottomNavProps {
  user: {
    username?: string | null;
    currentRole?: string | null;
    role?: string | null;
  };
}

const preferredDestinations = [
  { label: "Inventory", url: "/inventory", icon: Boxes },
  { label: "POS", url: "/pos", icon: ShoppingCart },
  { label: "Accounts", url: "/accounts", icon: Wallet },
  { label: "Daybook", url: "/daybook", icon: BookOpen },
] as const;

export function ErpMobileBottomNav({ user }: ErpMobileBottomNavProps) {
  const [location] = useLocation();
  const { setOpenMobile } = useSidebar();
  const { sections, visiblePinnedItems } = useErpVisibleSections(user);
  const visibleUrls = new Set([
    ...visiblePinnedItems.map((item) => item.url),
    ...sections.flatMap((section) => section.items.map((item) => item.url)),
  ]);
  const destinations = preferredDestinations.filter((item) => visibleUrls.has(item.url)).slice(0, 4);

  return (
    <nav
      aria-label="ERP mobile navigation"
      data-slot="erp-mobile-bottom-nav"
      className="safe-area-bottom fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-1.5 pb-[max(env(safe-area-inset-bottom),0.25rem)] pt-1.5 backdrop-blur sm:hidden"
    >
      <div className="mx-auto grid max-w-md grid-flow-col auto-cols-fr gap-1">
        {destinations.map(({ label, url, icon: Icon }) => {
          const active = location === url || location.startsWith(`${url}/`);
          return (
            <Link
              key={url}
              href={url}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-medium text-muted-foreground",
                active && "bg-accent text-accent-foreground"
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span className="max-w-full truncate">{label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setOpenMobile(true)}
          className="flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[10px] font-medium text-muted-foreground"
          aria-label="Open all ERP pages"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}
