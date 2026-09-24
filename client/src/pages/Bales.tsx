import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef } from "react";
import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { insertBaleSchema, type InsertBale } from "@shared/schema";
import { Package, Plus } from "lucide-react";
import { z } from "zod";
import { useBales } from "./bales/useBales";
import { BaleScanner } from "./bales/BaleScanner";
import { BalesTable } from "./bales/BalesTable";
import { BaleFormDialog } from "./bales/BaleFormDialog";

export default function Bales() {
  const { formatDisplayDate } = useDateFormat();
  const [, navigate] = useLocation();
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [scanMode, setScanMode] = useState<"quick" | "review">("quick");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [showBaleDialog, setShowBaleDialog] = useState(false);
  const [_scannedBale, setScannedBale] = useState<Partial<InsertBale> | null>(null);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [pendingBarcodeToMark, setPendingBarcodeToMark] = useState<number | null>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  const { bales, containers, isLoading } = useBales();

  const form = useForm<z.infer<typeof insertBaleSchema>>({
    resolver: zodResolver(insertBaleSchema),
    defaultValues: {
      barcode: "",
      category: "",
      grade: "A",
      origin: "EU",
      weight: "",
      datePressed: new Date().toLocaleDateString("en-CA"),
      price: "",
      currency: "USD",
      status: "AVAILABLE",
    },
  });

  const createBale = useMutation({
    mutationFn: async (data: InsertBale) => {
      return await apiRequest("POST", "/api/bales", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bales", selectedCompany?.id] });
      toast({ title: "Bale created successfully" });
      form.reset();
      setShowBaleDialog(false);
      setScannedBale(null);
      setBarcodeInput("");

      // Mark pending barcode as used after successful creation
      if (pendingBarcodeToMark) {
        fetch(`/api/pending-barcodes/${pendingBarcodeToMark}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ used: true }),
        });
        setPendingBarcodeToMark(null);
      }

      if (barcodeInputRef.current) {
        barcodeInputRef.current.value = "";
        barcodeInputRef.current.focus();
      }
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error creating bale",
        description: error.message,
        variant: "destructive",
      });
      setPendingBarcodeToMark(null);
    },
  });

  const deleteBale = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest("DELETE", `/api/bales/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bales", selectedCompany?.id] });
      toast({ title: "Bale deleted successfully" });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error deleting bale",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleScan = async (barcode: string) => {
    if (!barcode.trim()) return;

    try {
      // Check if bale already exists
      const response = await fetch(`/api/bales/barcode/${encodeURIComponent(barcode)}`, {
        credentials: "include",
      });

      if (response.ok) {
        toast({
          title: "Bale already exists",
          description: `Barcode: ${barcode}`,
          variant: "destructive",
        });
        setBarcodeInput("");
        if (barcodeInputRef.current) {
          barcodeInputRef.current.focus();
        }
        return;
      }

      // Check if barcode exists in pending barcodes (pre-printed labels)
      const pendingResponse = await fetch(`/api/pending-barcodes/${encodeURIComponent(barcode)}`, {
        credentials: "include",
      });

      let pendingBarcode = null;
      if (pendingResponse.ok) {
        pendingBarcode = await pendingResponse.json();
      }

      // Bale doesn't exist - create new one
      if (scanMode === "quick") {
        // Quick mode - immediately create with defaults (or pending barcode data)
        if (!selectedCompany) return;

        // Set pending barcode ID to mark as used after successful creation
        if (pendingBarcode) {
          setPendingBarcodeToMark(pendingBarcode.id);
        }

        const newBale: z.infer<typeof insertBaleSchema> = {
          companyId: selectedCompany.id,
          barcode,
          category: pendingBarcode?.category || "Unsorted",
          grade: pendingBarcode?.grade || "A",
          origin: pendingBarcode?.origin || "EU",
          weight: "1",
          datePressed: new Date().toLocaleDateString("en-CA"),
        };
        createBale.mutate(newBale);
        setBarcodeInput("");
      } else {
        // Review mode - show dialog with barcode pre-filled (use pending data if available)
        setScannedBale({ barcode });
        form.setValue("barcode", barcode);
        if (pendingBarcode?.category) form.setValue("category", pendingBarcode.category);
        if (pendingBarcode?.grade) form.setValue("grade", pendingBarcode.grade);
        if (pendingBarcode?.origin) form.setValue("origin", pendingBarcode.origin);

        // Set pending barcode ID to mark as used after successful creation
        if (pendingBarcode) {
          setPendingBarcodeToMark(pendingBarcode.id);
        }

        setShowBaleDialog(true);
        setBarcodeInput("");
      }
    } catch (_error) {
      toast({
        title: "Error checking barcode",
        description: "Please try again",
        variant: "destructive",
      });
      if (barcodeInputRef.current) {
        barcodeInputRef.current.focus();
      }
    }
  };

  const onSubmit = (data: z.infer<typeof insertBaleSchema>) => {
    const submitData = {
      ...data,
      containerId: String(data.containerId) === "none" ? null : data.containerId,
    };
    createBale.mutate(submitData as InsertBale);
  };

  const filteredBales = bales.filter((bale) =>
    searchAny(searchTerm, bale.barcode, bale.category, bale.grade, bale.origin)
  );

  if (!selectedCompany) {
    return (
      <div className="container mx-auto p-6">
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">Please select a company to manage bales</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <PageHeader
            title="Factory Bales"
            subtitle="Manage factory bale inventory with barcode scanning"
            icon={<Package className="h-5 w-5" />}
          />
        </div>
        <Button onClick={() => setShowBaleDialog(true)} data-testid="button-add-bale">
          <Plus className="h-4 w-4 mr-2" />
          Add Bale
        </Button>
      </div>

      <BaleScanner
        scanMode={scanMode}
        setScanMode={setScanMode}
        barcodeInput={barcodeInput}
        setBarcodeInput={setBarcodeInput}
        barcodeInputRef={barcodeInputRef}
        onScan={handleScan}
      />

      <BalesTable
        bales={filteredBales}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        formatDisplayDate={formatDisplayDate}
        onDeleteRequest={(baleId) => setPendingDelete(() => () => deleteBale.mutate(baleId))}
        onNavigateImport={() => navigate("/import-bales")}
      />

      <BaleFormDialog
        open={showBaleDialog}
        onOpenChange={setShowBaleDialog}
        form={form}
        onSubmit={onSubmit}
        isPending={createBale.isPending}
        containers={containers}
      />

      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
