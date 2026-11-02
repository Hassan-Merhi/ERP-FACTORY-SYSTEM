import { useEffect, useState } from "react";
import type { ShippingColId } from "../types";
import { DEFAULT_COL_VIS, SHIPPING_COLS } from "../utils";

export function useShippingColumnVisibility(userId: string | number | null | undefined) {
  const [colVis, setColVis] = useState<Record<ShippingColId, boolean>>(DEFAULT_COL_VIS);

  useEffect(() => {
    if (!userId) return;
    try {
      const saved = localStorage.getItem(`fsc_col_vis_${userId}`);
      if (saved) setColVis({ ...DEFAULT_COL_VIS, ...JSON.parse(saved) });
    } catch {
      // Local storage can be unavailable in privacy mode.
    }
  }, [userId]);

  function toggleCol(id: ShippingColId) {
    setColVis((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        if (userId) localStorage.setItem(`fsc_col_vis_${userId}`, JSON.stringify(next));
      } catch {
        // Keep the in-memory preference even when persistence is unavailable.
      }
      return next;
    });
  }

  function showAllCols() {
    setColVis({ ...DEFAULT_COL_VIS });
    try {
      if (userId) localStorage.setItem(`fsc_col_vis_${userId}`, JSON.stringify(DEFAULT_COL_VIS));
    } catch {
      // Keep the in-memory preference even when persistence is unavailable.
    }
  }

  const hiddenCount = SHIPPING_COLS.filter((column) => !colVis[column.id]).length;
  return { colVis, toggleCol, showAllCols, hiddenCount };
}
