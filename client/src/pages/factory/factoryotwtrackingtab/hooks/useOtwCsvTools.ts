import type { ChangeEvent } from "react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getErrorDetails } from "@shared/errorUtils";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { ContainerWithSupplier } from "../types";
import { containerCost, num } from "../utils";

function parseCsvLine(line: string): string[] {
  const output: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      output.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  output.push(current.trim());
  return output;
}

function normaliseDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const slashDate = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashDate) {
    const [, month, day, rawYear] = slashDate;
    const year = rawYear.length === 2 ? "20" + rawYear : rawYear;
    return year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0");
  }

  const namedDate = value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (namedDate) {
    const months: Record<string, string> = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const [, day, monthName, rawYear] = namedDate;
    const month = months[monthName.toLowerCase()];
    if (month) {
      const year = rawYear.length === 2 ? "20" + rawYear : rawYear;
      return year + "-" + month + "-" + day.padStart(2, "0");
    }
  }

  // Excel serial date (for example, 46273 = 2026-09-08). CSV exports from
  // spreadsheets may contain the underlying numeric value instead of the
  // formatted date displayed in Excel.
  const serial = Number(value);
  if (Number.isInteger(serial) && serial > 1000 && serial < 200000) {
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  return null;
}

export function useOtwCsvTools(filtered: ContainerWithSupplier[], otwContainers: ContainerWithSupplier[]) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  // Import rewrites ETAs on existing containers; export stays available to everyone.
  const recordChanges = useExistingRecordChangeAccess();

  function exportCsv() {
    const rows = [["Container #", "Supplier", "ETA (YYYY-MM-DD)", "Status", "Cost", "Freight", "Weight (KG)", "Notes"]];

    for (const container of filtered) {
      rows.push([
        container.containerNumber || "",
        container.supplierName || "",
        container.arrivalDate ? container.arrivalDate.slice(0, 10) : "",
        container.status || "",
        containerCost(container).amount > 0 ? String(containerCost(container).amount) : "",
        num(container.freight) > 0 ? String(num(container.freight)) : "",
        container.totalKg ? String(container.totalKg) : "",
        container.otwNote || "",
      ]);
    }

    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `containers-otw-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !recordChanges.allowed) return;

    setImporting(true);
    try {
      const text = await file.text();
      const csvLines = text.split(/\r?\n/).filter((line) => line.trim());
      const headerColumns = parseCsvLine(csvLines[0] || "").map((heading) => heading.toLowerCase());
      const containerColumn = headerColumns.findIndex((heading) => heading.includes("container"));
      const etaColumn = headerColumns.findIndex((heading) => heading.includes("eta"));
      const containerIndex = containerColumn >= 0 ? containerColumn : 0;
      const etaIndex = etaColumn >= 0 ? etaColumn : 2;
      const lookup = new Map<string, number>(
        otwContainers.map((container) => [container.containerNumber?.trim().toUpperCase() ?? "", container.id])
      );

      let updated = 0;
      let skipped = 0;
      for (const line of csvLines.slice(1)) {
        const columns = parseCsvLine(line);
        const containerNumber = (columns[containerIndex] ?? "").toUpperCase().trim();
        const eta = normaliseDate((columns[etaIndex] ?? "").trim());
        const id = lookup.get(containerNumber);
        if (!containerNumber || !eta || !id) {
          skipped++;
          continue;
        }

        try {
          await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, { arrivalDate: eta });
          updated++;
        } catch {
          skipped++;
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      toast({ title: "Import complete", description: `${updated} ETA(s) updated, ${skipped} skipped.` });
    } catch (error) {
      toast({ title: "Import failed", description: getErrorDetails(error).optionalMessage, variant: "destructive" });
    } finally {
      setImporting(false);
    }
  }

  return { importing, exportCsv, handleImportFile, canImport: recordChanges.allowed };
}
