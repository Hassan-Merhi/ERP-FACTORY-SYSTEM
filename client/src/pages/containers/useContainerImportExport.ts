import { getErrorDetails } from "@shared/errorUtils";
import { useRef, useState } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { utils, writeFile, read } from "@/lib/excelHelper";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import type { Container } from "@shared/schema";
import { cellVal, cellStr, cellNum, excelDateToString } from "./containerExcel";

interface ImportExportParams {
  containers: Container[];
  filteredOtwContainers: Container[];
  getSupplierName: (supplierId: number) => string;
  formatDisplayDate: (date: string) => string;
}

export function useContainerImportExport({
  containers,
  filteredOtwContainers,
  getSupplierName,
  formatDisplayDate,
}: ImportExportParams) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);

  const exportToExcel = async () => {
    const data = containers.map((container) => ({
      "Container Number": container.containerNumber,
      Supplier: getSupplierName(container.supplierId),
      Status: container.status,
      Amount: parseFloat(container.grandTotal || "0"),
      "Import Date": formatDisplayDate(container.importDate),
    }));
    const worksheet = utils.json_to_sheet(data);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Containers");
    await writeFile(workbook, exportFileName("containers", "xlsx"));
  };

  const exportAllContainersFull = async () => {
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection", variant: "destructive" });
      return;
    }
    try {
      await downloadFromUrl("/api/containers/export-all", {
        fileName: exportFileName("containers full export", "xlsx"),
      });
      toast({ title: "Export successful", description: "All containers exported with full details" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    }
  };

  const exportOtwToExcel = async () => {
    const data = filteredOtwContainers.map((c) => ({
      "Container #": c.containerNumber,
      Supplier: getSupplierName(c.supplierId),
      Amount: parseFloat(c.grandTotal || "0"),
      Shop: c.shopName || "",
      ETA: c.eta || "",
      Transporter: c.transporter || "",
      "Transport Fee": c.transportFee || "",
      "Number Plate": c.numberPlate || "",
      Location: c.trackingLocation || "",
      "Border Date": c.borderDate || "",
      "Offload Date": c.offloadDate || "",
      Agent: c.agent || "",
      "Duty Fee": c.dutyFee || "",
      "Doc Received": c.docReceived ? "Yes" : "No",
      Description: c.trackingDescription || "",
    }));
    const worksheet = utils.json_to_sheet(data);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "OTW Containers");
    await writeFile(workbook, exportFileName("OTW containers", "xlsx"));
  };

  const downloadImportTemplate = async () => {
    const templateData = [
      {
        "Container #": "EXAMPLE123456",
        Shop: "Hadi #1",
        ETA: "2026-01-15",
        Transporter: "FARHAT",
        "Transport Fee": "8500",
        "Number Plate": "T123 ABC",
        Location: "KASUMBALESA",
        "Border Date": "2026-01-20",
        "Offload Date": "2026-01-22",
        Agent: "NCA",
        "Duty Fee": "5000",
        "Doc Received": "YES",
        Description: "Sample description",
      },
    ];
    const worksheet = utils.json_to_sheet(templateData);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, "Import Template");
    await writeFile(workbook, "container_import_template.xlsx");
  };

  const handleImportClick = async () => {
    if (!recordChanges.allowed) return;
    fileInputRef.current?.click();
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !recordChanges.allowed) return;
    setIsImporting(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = await read(data);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = utils.sheet_to_json(sheet);
      if (jsonData.length === 0) {
        throw new Error("The Excel file is empty. Please add data rows and try again.");
      }
      const headerRow = utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] || [];
      const columns = headerRow.map((h) => String(h || "").trim());
      const containerColAliases = ["Container #", "Container Number", "containerNumber"];
      const hasContainerCol = containerColAliases.some((alias) => columns.includes(alias));
      if (!hasContainerCol) {
        throw new Error(
          `Missing required column: "Container #"\n\n` +
            `Expected columns: Container #, Shop, ETA, Transporter, etc.\n` +
            `Found columns: ${columns.slice(0, 5).join(", ")}${columns.length > 5 ? "..." : ""}\n\n` +
            `Tip: Download the template to see the expected format.`
        );
      }
      const rows = jsonData.map((row) => ({
        containerNumber: cellStr(row["Container #"] || row["Container Number"] || row["containerNumber"]),
        shopName: cellStr(row["Shop"] || row["Shop Name"] || row["shopName"]),
        eta: excelDateToString(cellVal(row["ETA"] || row["eta"])),
        transporter: cellStr(row["Transporter"] || row["transporter"]),
        transportFee: cellNum(row["Transport Fee"] || row["transportFee"]),
        numberPlate: cellStr(row["Number Plate"] || row["Plate"] || row["numberPlate"]),
        trackingLocation: cellStr(row["Location"] || row["trackingLocation"]),
        borderDate: excelDateToString(cellVal(row["Border Date"] || row["borderDate"])),
        offloadDate: excelDateToString(cellVal(row["Offload Date"] || row["offloadDate"])),
        agent: cellStr(row["Agent"] || row["agent"]),
        dutyFee: cellNum(row["Duty Fee"] || row["dutyFee"]),
        docReceived: cellStr(row["Doc Received"] || row["docReceived"]),
        trackingDescription: cellStr(row["Description"] || row["trackingDescription"]),
      }));
      const response = await apiRequest("POST", "/api/containers/tracking/import", { rows });
      const result = await response.json();
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active"] });
      if (result.errors && result.errors.length > 0) {
        toast({
          title: `Import completed with issues`,
          description: `${result.updated} updated, ${result.notFound} not found. ${result.errors[0]}`,
          variant: "destructive",
        });
      } else {
        toast({ title: "Import successful", description: `${result.updated} container(s) updated` });
      }
    } catch (error) {
      toast({ title: "Import failed", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return {
    fileInputRef,
    isImporting,
    exportToExcel,
    exportAllContainersFull,
    exportOtwToExcel,
    downloadImportTemplate,
    handleImportClick,
    handleFileImport,
    canChangeExistingRecords: recordChanges.allowed,
  };
}
