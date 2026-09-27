import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Preset } from "../types";

const PRESET_OPTIONS: [Preset, string][] = [
  ["today-yesterday", "Today vs Yesterday"],
  ["month", "This Month vs Last Month"],
  ["year", "This Year vs Last Year"],
  ["custom", "Custom"],
];

/**
 * Comparison period presets. The four buttons need ~33rem, more than the page header has beside
 * the title below xl (tablet and small laptop); there the same presets are a compact select.
 */
export function ComparisonPresetPicker({ preset, onChange }: { preset: Preset; onChange: (preset: Preset) => void }) {
  return (
    <>
      <div className="hidden flex-wrap gap-2 xl:flex">
        {PRESET_OPTIONS.map(([value, label]) => (
          <Button
            key={value}
            variant={preset === value ? "default" : "outline"}
            size="sm"
            onClick={() => onChange(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <Select value={preset} onValueChange={(value) => onChange(value as Preset)}>
        <SelectTrigger
          className="col-span-2 w-full sm:w-56 xl:hidden"
          aria-label="Comparison period"
          data-testid="select-comparison-preset"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_OPTIONS.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
