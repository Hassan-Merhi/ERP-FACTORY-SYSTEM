import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Upload, FileSpreadsheet, CheckCircle, XCircle, Download, ArrowRightLeft } from "lucide-react";
import type { AuthMe } from "@shared/apiTypes";

interface Location {
  id: number;
  name: string;
}

interface StockTransferItem {
  barcode: string;
  quantity: string | number;
  error?: string;
  stockItemName?: string;
  currentStock?: number;
}

interface StockTransferPreview {
  items: StockTransferItem[];
}

interface StockTransferValidationResult {
  errors: string[];
  validatedItems: StockTransferItem[];
}

type StockTransferImportPayload = {
  sourceLocationId: number;
  destinationLocationId: number;
  transferDate?: string;
  notes?: string;
  items: StockTransferItem[];
};

interface StockTransferImportProps {
  posUser?: AuthMe;
}

export default function StockTransferImport({ posUser }: StockTransferImportProps) {
  const [_location, navigate] = useLocation();
  const { toast } = useToast();
  const isPOS = !!posUser;

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StockTransferPreview | null>(null);
  const [validationResult, setValidationResult] = useState<StockTransferValidationResult | null>(null);
  const [selectedSourceLocation, setSelectedSourceLocation] = useState<string>(
    isPOS && posUser?.assignedLocationId ? posUser.assignedLocationId.toString() : ""
  );
  const [selectedDestLocation, setSelectedDestLocation] = useState<string>("");
  const [transferDate, setTransferDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [notes, setNotes] = useState<string>("");

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const parseMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/stock-transfer-import/parse", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to parse file");
      }
      return await res.json();
    },
    onSuccess: (data) => {
      setPreview(data);
      setValidationResult(null);
      toast({
        title: "File parsed successfully",
        description: `Found ${data.items.length} item(s). Click Validate to check the data.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Parse error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const validateMutation = useMutation({
    mutationFn: async (data: StockTransferImportPayload) => {
      const res = await apiRequest("POST", "/api/stock-transfer-import/validate", data);
      return await res.json();
    },
    onSuccess: (data) => {
      setValidationResult(data);
      const errorCount = data.errors?.length || 0;
      if (errorCount === 0) {
        toast({
          title: "Validation passed",
          description: "All items validated successfully. You can now import the data.",
        });
      } else {
        toast({
          title: "Validation failed",
          description: `Found ${errorCount} error(s). Please fix them before importing.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Validation error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: StockTransferImportPayload) => {
      const res = await apiRequest("POST", "/api/stock-transfer-import/import", data);
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Import successful",
        description: `${data.itemsCount} items transferred successfully.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory-by-location"] });
      navigate("/stock-transfers");
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Import error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setPreview(null);
      setValidationResult(null);
    }
  };

  const handleParse = () => {
    if (!file) {
      toast({
        title: "No file selected",
        description: "Please select an Excel file to upload",
        variant: "destructive",
      });
      return;
    }
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "File imports require a connection",
        variant: "destructive",
      });
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    parseMutation.mutate(formData);
  };

  const handleValidate = () => {
    if (!selectedSourceLocation) {
      toast({
        title: "Source location required",
        description: "Please select a source location",
        variant: "destructive",
      });
      return;
    }

    if (!selectedDestLocation) {
      toast({
        title: "Destination location required",
        description: "Please select a destination location",
        variant: "destructive",
      });
      return;
    }

    if (selectedSourceLocation === selectedDestLocation) {
      toast({
        title: "Invalid locations",
        description: "Source and destination must be different",
        variant: "destructive",
      });
      return;
    }

    if (!preview) {
      toast({
        title: "No preview data",
        description: "Please parse the file first",
        variant: "destructive",
      });
      return;
    }

    validateMutation.mutate({
      sourceLocationId: parseInt(selectedSourceLocation),
      destinationLocationId: parseInt(selectedDestLocation),
      items: preview.items,
    });
  };

  const handleImport = () => {
    if (!selectedSourceLocation) {
      toast({
        title: "Source location required",
        description: "Please select a source location",
        variant: "destructive",
      });
      return;
    }

    if (!selectedDestLocation) {
      toast({
        title: "Destination location required",
        description: "Please select a destination location",
        variant: "destructive",
      });
      return;
    }

    if (!preview) {
      toast({
        title: "No preview data",
        description: "Please parse the file first",
        variant: "destructive",
      });
      return;
    }

    if (!isValidated) {
      toast({
        title: "Validation required",
        description: "Please validate the data before importing",
        variant: "destructive",
      });
      return;
    }

    if (!validationResult?.validatedItems) {
      toast({
        title: "Validation data missing",
        description: "Please validate again before importing",
        variant: "destructive",
      });
      return;
    }

    // If there are validation errors, show confirmation dialog
    if (hasValidationErrors) {
      setConfirmDialogOpen(true);
      return;
    }

    // No errors - proceed directly with valid items
    const itemsToImport = validationResult.validatedItems.filter((item: StockTransferItem) => !item.error);
    importMutation.mutate({
      sourceLocationId: parseInt(selectedSourceLocation),
      destinationLocationId: parseInt(selectedDestLocation),
      transferDate,
      notes,
      items: itemsToImport,
    });
  };

  const handleConfirmedImport = () => {
    // Filter valid items and proceed with import
    const itemsToImport = validationResult?.validatedItems?.filter((item: StockTransferItem) => !item.error) || [];

    // Close confirmation dialog first
    setConfirmDialogOpen(false);

    if (itemsToImport.length === 0) {
      // Reset all state for a fresh start
      setFile(null);
      setPreview(null);
      setValidationResult(null);
      setSelectedDestLocation("");
      setTransferDate(new Date().toLocaleDateString("en-CA"));
      setNotes("");
      // Show informational message
      toast({
        title: "No items imported",
        description:
          "All items had validation errors. No transfer was created. You can try again with a different file.",
      });
      return;
    }

    importMutation.mutate({
      sourceLocationId: parseInt(selectedSourceLocation),
      destinationLocationId: parseInt(selectedDestLocation),
      transferDate,
      notes,
      items: itemsToImport,
    });
  };

  const downloadTemplate = () => {
    window.open("/api/stock-transfer-import/template", "_blank");
  };

  const isValidated = validationResult !== null;
  const hasValidationErrors = validationResult?.errors && validationResult.errors.length > 0;

  // Calculate valid items (items without errors)
  const validItems = validationResult?.validatedItems?.filter((item: StockTransferItem) => !item.error) || [];
  const validItemsCount = validItems.length;
  const totalItemsCount = validationResult?.validatedItems?.length || 0;

  // Confirmation dialog state
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  const sourceLocationName = locations.find((l) => l.id === parseInt(selectedSourceLocation))?.name;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <PageHeader title="Stock Transfer Import" icon={<ArrowRightLeft className="h-5 w-5" />} />
          <p className="text-muted-foreground mt-1">Import stock transfers from Excel (Barcode, Quantity)</p>
        </div>
        <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-template">
          <Download className="h-4 w-4 mr-2" />
          Download Template
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload Transfer Data</CardTitle>
          <CardDescription>Upload an Excel file with columns: Barcode, Quantity</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="file">Excel File</Label>
              <Input id="file" type="file" accept=".xlsx,.xls" onChange={handleFileChange} data-testid="input-file" />
              {file && <p className="text-sm text-muted-foreground">Selected: {file.name}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="transferDate">Transfer Date</Label>
              <Input
                id="transferDate"
                type="date"
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                data-testid="input-transfer-date"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sourceLocation">Source Location</Label>
              {isPOS ? (
                <div className="p-3 bg-muted rounded-md">
                  <span className="font-medium">{sourceLocationName || "Your Location"}</span>
                </div>
              ) : (
                <Select value={selectedSourceLocation} onValueChange={setSelectedSourceLocation}>
                  <SelectTrigger id="sourceLocation" data-testid="select-source-location">
                    <SelectValue placeholder="Select source location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="destLocation">Destination Location</Label>
              <Select value={selectedDestLocation} onValueChange={setSelectedDestLocation}>
                <SelectTrigger id="destLocation" data-testid="select-dest-location">
                  <SelectValue placeholder="Select destination location" />
                </SelectTrigger>
                <SelectContent>
                  {locations
                    .filter((loc) => loc.id.toString() !== selectedSourceLocation)
                    .map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (Optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes for this transfer"
              data-testid="input-notes"
            />
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button onClick={handleParse} disabled={!file || parseMutation.isPending} data-testid="button-parse">
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              {parseMutation.isPending ? "Parsing..." : "Parse File"}
            </Button>

            <Button
              onClick={handleValidate}
              disabled={!preview || !selectedSourceLocation || !selectedDestLocation || validateMutation.isPending}
              variant="outline"
              data-testid="button-validate"
            >
              {isValidated ? (
                hasValidationErrors ? (
                  <XCircle className="h-4 w-4 mr-2 text-destructive" />
                ) : (
                  <CheckCircle className="h-4 w-4 mr-2 text-green-600" />
                )
              ) : null}
              {validateMutation.isPending ? "Validating..." : "Validate"}
            </Button>

            <Button
              onClick={handleImport}
              disabled={!isValidated || importMutation.isPending}
              data-testid="button-import"
            >
              <Upload className="h-4 w-4 mr-2" />
              {importMutation.isPending
                ? "Importing..."
                : hasValidationErrors
                  ? `Import Transfer (${validItemsCount} valid)`
                  : "Import Transfer"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {validationResult?.errors && validationResult.errors.length > 0 && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Validation Errors</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc list-inside space-y-1">
              {validationResult.errors.map((error: string, index: number) => (
                <li key={index} className="text-sm text-destructive">
                  {error}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Preview ({preview.items.length} items)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Item Name</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.items.map((item: StockTransferItem, index: number) => {
                    const validation = validationResult?.validatedItems?.[index];
                    const hasError = validation?.error;

                    return (
                      <TableRow
                        key={index}
                        className={hasError ? "bg-destructive/10" : ""}
                        data-testid={`preview-row-${index}`}
                      >
                        <TableCell className="font-mono">{item.barcode}</TableCell>
                        <TableCell>
                          {validation?.stockItemName || <span className="text-muted-foreground italic">Unknown</span>}
                        </TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">
                          {validation?.currentStock !== undefined ? formatNumber(validation.currentStock, 0) : "-"}
                        </TableCell>
                        <TableCell>
                          {validation ? (
                            hasError ? (
                              <div className="flex items-center gap-1 text-destructive">
                                <XCircle className="h-4 w-4" />
                                <span className="text-sm">{validation.error}</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 text-green-600">
                                <CheckCircle className="h-4 w-4" />
                                <span className="text-sm">OK</span>
                              </div>
                            )
                          ) : (
                            <span className="text-sm text-muted-foreground">Not validated</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Import Confirmation Dialog */}
      <ConfirmDialog
        open={confirmDialogOpen}
        onOpenChange={setConfirmDialogOpen}
        title="Import with Validation Errors?"
        tone="warning"
        confirmText={validItemsCount === 0 ? "OK" : `Import ${validItemsCount} Item(s)`}
        onConfirm={handleConfirmedImport}
        description={
          validItemsCount === 0 ? (
            `All ${totalItemsCount} items have validation errors. Nothing will be imported.`
          ) : (
            <>
              {totalItemsCount - validItemsCount} of {totalItemsCount} items have validation errors and will be skipped.
              <br />
              <br />
              <strong>{validItemsCount} valid item(s)</strong> will be transferred.
            </>
          )
        }
      />
    </div>
  );
}