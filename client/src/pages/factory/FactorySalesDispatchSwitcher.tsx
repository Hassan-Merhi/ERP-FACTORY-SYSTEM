import { Link, useLocation } from "wouter";
import { ShoppingCart, Trash2 } from "lucide-react";
import { useFactoryNavigationAccess } from "@/hooks/useFactoryNavigationAccess";

const DESTINATIONS = [
  { label: "Factory POS", route: "/factory/pos", icon: ShoppingCart, testId: "switch-factory-pos" },
  { label: "Waste Dispatch", route: "/factory/waste-dispatch", icon: Trash2, testId: "switch-waste-dispatch" },
] as const;

/** Single in-page switcher for the existing, independently protected workflows. */
export function FactorySalesDispatchSwitcher() {
  const [location] = useLocation();
  const { ready, canOpen } = useFactoryNavigationAccess();
  if (!ready) return null;

  const destinations = DESTINATIONS.filter(({ route }) => canOpen(route));
  if (!destinations.length) return null;

  return (
    <nav aria-label="POS and waste dispatch" className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-muted/60 p-1.5" data-testid="factory-pos-dispatch-switcher">
      {destinations.map(({ label, route, icon: Icon, testId }) => {
        const selected = location === route;
        return (
          <Link
            key={route}
            href={route}
            aria-current={selected ? "page" : undefined}
            data-testid={testId}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${selected ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-background/75 hover:text-foreground"}`}
          >
            <Icon className="h-4 w-4" /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
