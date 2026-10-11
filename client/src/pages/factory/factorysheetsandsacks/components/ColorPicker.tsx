/**
 * ColorPicker — extracted sub-component.
 *
 * Extracted from FactorySheetsAndSacks.tsx during the Phase 4 god-file split.
 */
import { Check } from "lucide-react";

import { COLOR_PRESETS, isLight } from "../utils";

export // ─── Color Picker ─────────────────────────────────────────────────────────────
function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {COLOR_PRESETS.map((c) => (
          <button
            key={c.value}
            type="button"
            title={c.label}
            onClick={() => onChange(c.value)}
            className="relative rounded-full border-2 transition-all focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              width: 28,
              height: 28,
              backgroundColor: c.value || "transparent",
              borderColor: value === c.value ? "#000" : c.value ? c.value : "#cbd5e1",
              boxShadow: value === c.value ? "0 0 0 2px rgba(0,0,0,0.25)" : undefined,
            }}
          >
            {!c.value && (
              <span className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs font-medium">
                ✕
              </span>
            )}
            {value === c.value && c.value && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Check className="h-3 w-3" style={{ color: isLight(c.value) ? "#000" : "#fff" }} />
              </span>
            )}
          </button>
        ))}
        <div className="relative flex items-center" title="Custom color">
          <input
            type="color"
            value={value && !COLOR_PRESETS.some((c) => c.value === value) ? value : "#888888"}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-full border-2 border-border cursor-pointer"
            style={{ width: 28, height: 28, padding: 2 }}
          />
        </div>
      </div>
      {value && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="inline-block rounded-full border border-border"
            style={{ width: 12, height: 12, backgroundColor: value }}
          />
          {COLOR_PRESETS.find((c) => c.value === value)?.label ?? value}
        </div>
      )}
    </div>
  );
}

// ─── Item Form Dialog ─────────────────────────────────────────────────────────
