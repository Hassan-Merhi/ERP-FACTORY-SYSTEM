/**
 * Side — extracted sub-component.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */
import {useState} from "react";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Separator} from "@/components/ui/separator";
import {ChevronDown, ChevronRight} from "lucide-react";

import type {AccountItem, BreakdownItem} from "../types";
import {fmt} from "../utils";
import {CategoryGroup} from "./CategoryGroup";

export function Side({
  label,
  sublabel,
  total,
  breakdown,
  accounts,
  colorClass,
  icon,
  onFxClick,
}: {
  label: string;
  sublabel: string;
  total: number;
  breakdown: BreakdownItem[];
  accounts: AccountItem[];
  colorClass: string;
  icon: React.ReactNode;
  onFxClick?: (side: "gain" | "loss") => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const grouped: Record<string, AccountItem[]> = {};
  for (const a of accounts) {
    if (!grouped[a.category]) grouped[a.category] = [];
    grouped[a.category].push(a);
  }

  return (
    <Card data-testid={`card-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-base">{label}</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          className={`text-3xl font-bold font-mono ${colorClass}`}
          data-testid={`text-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {fmt(total)}
        </p>

        {breakdown.length > 0 && (
          <div className="space-y-1.5">
            {breakdown.map((b, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{b.name}</span>
                <span className={`font-mono font-medium ${colorClass}`}>{fmt(b.value)}</span>
              </div>
            ))}
          </div>
        )}

        {accounts.length > 0 && (
          <>
            <Separator />
            <div>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2"
                onClick={() => setShowAll((v) => !v)}
                data-testid={`button-toggle-details-${label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {showAll ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {showAll ? "Hide" : "Show"} details ({accounts.length} item{accounts.length !== 1 ? "s" : ""})
              </button>
              {showAll && (
                <div className="space-y-2">
                  {Object.entries(grouped).map(([cat, accs]) => (
                    <CategoryGroup key={cat} title={cat} accounts={accs} accentClass={colorClass} onFxClick={onFxClick} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
