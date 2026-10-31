import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Preset } from "../types";

const PRESET_OPTIONS: [Preset, string][] = [
  ["today-yesterday", "Today vs Yesterday"],
  ["month", "This Month vs Last Month"],
  ["year", "This Year vs Last Year"],
  ["custom", "Custom"],
];

/** Preserves the same four date presets, with mobile-friendly selection. */
export function ComparisonPresetPicker({ preset, onChange }: { preset: Preset; onChange: (preset: Preset) => void }) {
  return (
    <>
      <div className="hidden flex-wrap items-center gap-2 xl:flex" role="group" aria-label="Comparison period">
        {PRESET_OPTIONS.map(([value, label]) => (
          <Button
            key={value}
            variant={preset === value ? "default" : "outline"}
            size="sm"
            className={cn(
              "h-10 rounded-xl px-3 text-xs font-semibold transition-all",
              preset === value
                ? "border border-blue-500 bg-blue-600 text-white shadow-md shadow-blue-600/20 hover:bg-blue-500"
                : "border-border/70 bg-background/50 text-foreground/80 hover:border-blue-500/40 hover:bg-blue-500/10"
            )}
            onClick={() => onChange(value)}
            aria-pressed={preset === value}
            data-testid={"button-comparison-period-" + value}
          >
            {value === "custom" && <CalendarDays className="mr-1.5 h-4 w-4" />}
            {label}
          </Button>
        ))}
      </div>
      <Select value={preset} onValueChange={(value) => onChange(value as Preset)}>
        <SelectTrigger
          className="col-span-2 h-10 w-full rounded-xl border-blue-500/25 bg-background/60 sm:w-60 xl:hidden"
          aria-label="Comparison period"
          data-testid="select-comparison-preset"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_OPTIONS.map(([value, label]) => (
            <SelectItem key={value} value={value}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
