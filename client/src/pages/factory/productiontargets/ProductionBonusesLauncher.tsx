import { Coins } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The daily Production Targets banner that opens the Production Bonuses workspace. */
export function ProductionBonusesLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="pt-bonus-banner" data-testid="production-bonuses-launcher">
      <div className="flex items-center gap-3">
        <div className="pt-bonus-icon">
          <Coins className="h-6 w-6" />
        </div>
        <div>
          <p className="font-semibold">Production Bonuses</p>
          <p className="text-xs text-muted-foreground">
            Set rates, review calculations, approve worker bonuses and pay from Cash / Bank.
          </p>
        </div>
      </div>
      <Button type="button" className="pt-btn-violet" onClick={onOpen} data-testid="button-open-production-bonuses">
        Open Production Bonuses
      </Button>
    </div>
  );
}
