import * as React from "react";

import { useAppMode } from "@/contexts/AppModeContext";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";

/**
 * ERP phone card layout for record tables.
 *
 * On ERP-mode phone layouts a table marked `data-mobile-cards="true"` is restacked by
 * `erp-mobile-operations.css`: each body row becomes a card, the first cell with text is its
 * title and the other cells become label/value fields. Labels come from the column headers
 * through `labelMobileCardCells`, so pages keep a single table markup for every breakpoint.
 */

const normalise = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * One label per column, read from every header row. Grouped headers (`rowSpan` / `colSpan`)
 * combine top to bottom, so a "Qty" column under an "Inward" group becomes "Inward · Qty".
 */
export function mobileCardColumnLabels(table: HTMLTableElement): string[] {
  const rows = table.tHead ? Array.from(table.tHead.rows) : [];
  const grid: string[][] = [];
  rows.forEach((row, rowIndex) => {
    grid[rowIndex] ??= [];
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      while (grid[rowIndex][column] !== undefined) column += 1;
      const text = normalise(cell.getAttribute("data-label") ?? cell.textContent);
      for (let r = 0; r < Math.max(1, cell.rowSpan); r += 1) {
        grid[rowIndex + r] ??= [];
        for (let c = 0; c < Math.max(1, cell.colSpan); c += 1) grid[rowIndex + r][column + c] = text;
      }
      column += Math.max(1, cell.colSpan);
    }
  });

  const columns = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const labels: string[] = [];
  for (let column = 0; column < columns; column += 1) {
    const parts: string[] = [];
    for (const row of grid) {
      const text = row[column];
      if (text && parts[parts.length - 1] !== text) parts.push(text);
    }
    labels.push(parts.join(" · "));
  }
  return labels;
}

const ORDINAL_LABEL = /^(#|no\.?|n°|s\.?\s?no\.?|sr\.?\s?no\.?)$/i;

function mobileCellRole(cell: HTMLTableCellElement, label: string, span: number, columns: number, titled: boolean) {
  if (columns > 1 && span >= columns) return "full";
  const text = normalise(cell.textContent);
  const controls = cell.querySelectorAll("button, a[href], input, [role=checkbox], [role=switch], select");
  const onlyCheckbox =
    !text &&
    controls.length === 1 &&
    (controls[0].getAttribute("role") === "checkbox" || (controls[0] as HTMLInputElement).type === "checkbox");
  if (onlyCheckbox) return "select";
  // Unlabelled, textless, control-free cells are decoration (row chevrons, spacers).
  if (!label && !text && controls.length === 0) return "hidden";
  // Row ordinals ("#", "No.") repeat the card's position; the card already shows it.
  if (/^\d+$/.test(text) && ORDINAL_LABEL.test(label)) return "hidden";
  // The title is the first cell with readable text; icon-only status cells stay labelled fields.
  if (!titled && text) return "title";
  if (controls.length > 0 && (!label || /^actions?$/i.test(label))) return "actions";
  return "field";
}

/**
 * Prepares a table for the phone card layout: every body/footer cell gets a `data-label` taken
 * from its column header and a `data-mobile-cell` role — `title` for the first cell with text,
 * `select` for a checkbox-only cell, `actions` for an unlabelled cell that only holds controls,
 * `hidden` for unlabelled decoration (row chevrons) and row ordinals, and `full` for a cell spanning every
 * column (empty and loading states). Author-provided `data-label` / `data-mobile-cell`
 * attributes are kept.
 */
export function labelMobileCardCells(table: HTMLTableElement) {
  const labels = mobileCardColumnLabels(table);
  const columnCount = labels.length;

  const sections = [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])];
  for (const section of sections) {
    for (const row of Array.from(section.rows)) {
      let column = 0;
      let titled = false;
      for (const cell of Array.from(row.cells)) {
        const span = Math.max(1, cell.colSpan);
        if (cell.getAttribute("data-label-source") !== "author") {
          if (cell.hasAttribute("data-label") && !cell.hasAttribute("data-label-source")) {
            cell.setAttribute("data-label-source", "author");
          } else {
            cell.setAttribute("data-label", labels[column] ?? "");
            cell.setAttribute("data-label-source", "header");
          }
        }
        if (cell.getAttribute("data-mobile-cell-source") !== "author") {
          if (cell.hasAttribute("data-mobile-cell") && !cell.hasAttribute("data-mobile-cell-source")) {
            cell.setAttribute("data-mobile-cell-source", "author");
          } else {
            const role = mobileCellRole(cell, labels[column] ?? "", span, columnCount, titled);
            cell.setAttribute("data-mobile-cell", role);
            cell.setAttribute("data-mobile-cell-source", "auto");
          }
        }
        if (cell.getAttribute("data-mobile-cell") === "title") titled = true;
        column += span;
      }
    }
  }
}

/**
 * Opts a table into the ERP phone card layout. Spread `tableProps` on the `<table>`; `cards`
 * tells the caller when the card layout is active (for example to lift a scroll wrapper's
 * height cap). Outside ERP mode, and on tablet/desktop, the table is untouched.
 */
export function useMobileCardTable(enabled = true) {
  const isPhone = useErpPhoneLayout();
  const appMode = useAppMode();
  // Card styling ships with the ERP shell; other modes keep their established tables.
  const cards = enabled && isPhone && appMode === "erp";
  const [table, setTable] = React.useState<HTMLTableElement | null>(null);

  React.useLayoutEffect(() => {
    if (!cards || !table) return;
    labelMobileCardCells(table);
    // Rows arrive and change after the first paint (queries, pagination, i18n); relabel them.
    const observer = new MutationObserver(() => labelMobileCardCells(table));
    observer.observe(table, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [cards, table]);

  return {
    cards,
    ref: setTable,
    tableProps: { ref: setTable, "data-mobile-cards": cards ? ("true" as const) : undefined },
  };
}
