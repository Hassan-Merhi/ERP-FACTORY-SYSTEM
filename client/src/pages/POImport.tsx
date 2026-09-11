import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";

const formatCurrency = (num: number) => {
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import { Upload, FileSpreadsheet, CheckCircle, XCircle, Download, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Supplier } from "@shared/schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface SupplierComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  suppliers: Supplier[];
  placeholder?: string;
  testId?: string;
  isLoading?: boolean;
  hasError?: boolean;
}

interface POImportItem {
  poNumber: string;
  itemName: string;
  quantity: string | number;
  rate: string | number;
  lineTotal: string | number;
}

interface POImportCharges {
  freight: string | number;
  surcharge: string | number;
  fumigation: string | number;
  discount: string | number;
  documentCharges: string | number;
}

interface POImportContainer {
  containerNumber: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: string | number;
  grandTotal: string | number;
  charges: POImportCharges;
  items: POImportItem[];
}

interface POImportPreview {
  fileHash: string;
  fileName: string;
  preview: POImportContainer[];
}

interface POValidationResult {
  errors: React.ReactNode[];
}

type POImportPayload = POImportPreview & {
  containerNumber: string;
  supplierId: number;
  importDate: string;
  freightPaidBy: "supplier" | "parent";
  freightParentAccountId: number | null;
};

function SupplierCombobox({
  value,
  onValueChange,
  suppliers,
  placeholder = "Select supplier",
  testId,
  isLoading = false,
  hasError = false,
}: SupplierComboboxProps) {
  const [open, setOpen] = useState(false);
  const selectedSupplier = suppliers.find((supplier) => supplier.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          data-testid={testId}
          disabled={isLoading || hasError}
        >
          {isLoading
            ? "Loading suppliers..."
            : hasError
              ? "Unable to load suppliers"
              : selectedSupplier
                ? selectedSupplier.legalName
                : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput placeholder="Search suppliers..." />
          <CommandList>
            <CommandEmpty>No supplier found for this company.</CommandEmpty>
            <CommandGroup>
              {suppliers.map((supplier) => (
                <CommandItem
                  key={supplier.id}
                  value={supplier.legalName}
                  onSelect={() => {
                    onValueChange(supplier.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === supplier.id.toString() ? "opacity-100" : "opacity-0")}
                  />
                  {supplier.legalName}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function POImport() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<POImportPreview | null>(null);
  const [validationResult, setValidationResult] = useState<POValidationResult | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState<string>("");
  const [containerNumber, setContainerNumber] = useState<string>("");
  const [importDate, setImportDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [freightPaidBy, setFreightPaidBy] = useState<"supplier" | "parent">("supplier");
  const [freightParentAccountId, setFreightParentAccountId] = useState<string>("");

  const {
    data: suppliers = [],
    isLoading: suppliersLoading,
    isError: suppliersError,
  } = useQuery<Supplier[]>({
    queryKey: companyQueryKey("/api/suppliers?allowParentFallback=true", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: parentFreightAccounts = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: companyQueryKey("/api/purchase-orders/parent-freight-accounts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    retry: false,
  });

  // Keep the parsed preview usable while a stock item is created elsewhere in
  // the app. StockItemCreateDialog invalidates this shared query key, which
  // gives the import screen a signal to re-check missing item references.
  const { dataUpdatedAt: stockItemsUpdatedAt } = useQuery({
    queryKey: ["/api/stock-items"],
    enabled: Boolean(selectedCompany?.id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [validatedAgainstStockItemsAt, setValidatedAgainstStockItemsAt] = useState(0);

  const parseMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/po-import/parse", { method: "POST", body: formData });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to parse file");
      }
      return await res.json();
    },
    onSuccess: (data) => {
      setPreview(data);
      setValidationResult(null);
      if (data.preview.length > 0) setContainerNumber(data.preview[0].containerNumber || "");
      toast({
        title: "File parsed successfully",
        description: `Found ${data.preview.length} container(s) with ${data.preview.reduce(
          (sum: number, p: POImportContainer) => sum + p.itemsCount,
          0
        )} items. Click Validate to check the data.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Parse error", description: error.message, variant: "destructive" });
    },
  });

  const validateMutation = useMutation({
    mutationFn: async (data: POImportPayload) => {
      const res = await apiRequest("POST", "/api/po-import/validate", data);
      return await res.json();
    },
    onSuccess: (data) => {
      setValidationResult(data);
      const errorCount = data.errors?.length || 0;
      toast({
        title: errorCount === 0 ? "Validation passed" : "Validation failed",
        description:
          errorCount === 0
            ? "All items validated successfully. You can now import the data."
            : `Found ${errorCount} error(s). Please fix them before importing.`,
        variant: errorCount === 0 ? "default" : "destructive",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Validation error", description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: POImportPayload) => {
      const res = await apiRequest("POST", "/api/po-import/import", data);
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Import successful",
        description: `Container ${data.containerNumber} imported with ${data.itemsCount} items`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      navigate("/containers");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
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

  const selectedContainer = preview?.preview?.find((c: POImportContainer) => c.containerNumber === containerNumber);
  const hasValidationErrors = Boolean(validationResult?.errors?.length);
  const isValidated = validationResult !== null;

  const buildPayload = useCallback(
    () => ({
      fileHash: preview!.fileHash,
      fileName: preview!.fileName,
      containerNumber,
      supplierId: Number.parseInt(selectedSupplier, 10),
      importDate,
      preview: preview!.preview,
      freightPaidBy,
      freightParentAccountId: freightParentAccountId ? Number.parseInt(freightParentAccountId, 10) : null,
    }),
    [preview, containerNumber, selectedSupplier, importDate, freightPaidBy, freightParentAccountId]
  );

  useEffect(() => {
    if (
      !preview ||
      !validationResult?.errors?.length ||
      !stockItemsUpdatedAt ||
      stockItemsUpdatedAt <= validatedAgainstStockItemsAt ||
      validateMutation.isPending
    ) {
      return;
    }

    setValidatedAgainstStockItemsAt(stockItemsUpdatedAt);
    validateMutation.mutate(buildPayload());
  }, [preview, validationResult, stockItemsUpdatedAt, validatedAgainstStockItemsAt, validateMutation, buildPayload]);

  const checkRequiredFields = () => {
    if (!selectedCompany?.id) {
      toast({ title: "Company required", description: "Please select a company first", variant: "destructive" });
      return false;
    }
    if (!selectedSupplier) {
      toast({ title: "Supplier required", description: "Please select a supplier", variant: "destructive" });
      return false;
    }
    if (!containerNumber) {
      toast({
        title: "Container number required",
        description: "Please enter a container number",
        variant: "destructive",
      });
      return false;
    }
    if (!preview) {
      toast({ title: "No preview data", description: "Please parse the file first", variant: "destructive" });
      return false;
    }
    return true;
  };

  const handleValidate = () => {
    if (!checkRequiredFields()) return;
    setValidatedAgainstStockItemsAt(stockItemsUpdatedAt);
    validateMutation.mutate(buildPayload());
  };

  const handleImport = () => {
    if (!checkRequiredFields()) return;
    if (!isValidated) {
      toast({
        title: "Validation required",
        description: "Please validate the data before importing",
        variant: "destructive",
      });
      return;
    }
    if (hasValidationErrors) {
      toast({
        title: "Validation errors present",
        description: "Please fix validation errors before importing",
        variant: "destructive",
      });
      return;
    }
    if (freightPaidBy === "parent" && Number(selectedContainer?.charges?.freight || 0) > 0 && !freightParentAccountId) {
      toast({
        title: "Parent freight account required",
        description: "Please select a parent company account to book the freight against",
        variant: "destructive",
      });
      return;
    }
    importMutation.mutate(buildPayload());
  };

  const handleCancel = () => {
    setFile(null);
    setPreview(null);
    setValidationResult(null);
    setContainerNumber("");
    setSelectedSupplier("");
    setFreightPaidBy("supplier");
    setFreightParentAccountId("");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <PageHeader title="PO Import (Excel)" />
        <Button
          variant="outline"
          onClick={() => window.open("/api/po-import/template", "_blank")}
          data-testid="button-download-template"
        >
          <Download className="w-4 h-4 mr-2" />
          Download Template
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload Purchase Order Excel File</CardTitle>
          <CardDescription>
            Three-step process: Parse → Validate → Import. Need help? Download the template above to see the required
            format.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file-upload">Step 1: Select & Parse Excel File (.xlsx)</Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="file-upload"
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileChange}
                data-testid="input-file-upload"
              />
              <Button onClick={handleParse} disabled={!file || parseMutation.isPending} data-testid="button-parse">
                {parseMutation.isPending ? (
                  "Parsing..."
                ) : (
                  <>
                    <FileSpreadsheet className="w-4 h-4 mr-2" />
                    Parse
                  </>
                )}
              </Button>
            </div>
            {file && <p className="text-sm text-muted-foreground">Selected: {file.name}</p>}
          </div>

          {preview && (
            <div className="space-y-4">
              <Label>Step 2: Configure Import Details</Label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="supplier">Supplier *</Label>
                  <SupplierCombobox
                    value={selectedSupplier}
                    onValueChange={(supplierId) => {
                      setSelectedSupplier(supplierId);
                      setValidationResult(null);
                    }}
                    suppliers={suppliers}
                    placeholder="Select supplier"
                    testId="select-supplier"
                    isLoading={suppliersLoading}
                    hasError={suppliersError}
                  />
                  {suppliersError && (
                    <p className="text-sm text-destructive">Suppliers could not be loaded for the active company.</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="container-number">Container Number *</Label>
                  <Input
                    id="container-number"
                    value={containerNumber}
                    onChange={(e) => {
                      setContainerNumber(e.target.value);
                      setValidationResult(null);
                    }}
                    placeholder="CNTR-001"
                    data-testid="input-container-number"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="import-date">Import Date</Label>
                  <Input
                    id="import-date"
                    type="date"
                    value={importDate}
                    onChange={(e) => setImportDate(e.target.value)}
                    data-testid="input-import-date"
                  />
                </div>
              </div>

              {Number(selectedContainer?.charges?.freight || 0) > 0 && parentFreightAccounts.length > 0 && (
                <div className="space-y-3 pt-1">
                  <Label>Freight Paid By</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={freightPaidBy === "supplier" ? "default" : "outline"}
                      onClick={() => {
                        setFreightPaidBy("supplier");
                        setFreightParentAccountId("");
                      }}
                      data-testid="button-freight-by-supplier"
                    >
                      By Supplier
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={freightPaidBy === "parent" ? "default" : "outline"}
                      onClick={() => setFreightPaidBy("parent")}
                      data-testid="button-freight-by-parent"
                    >
                      Parent Co.
                    </Button>
                  </div>
                  {freightPaidBy === "parent" && (
                    <div className="space-y-1">
                      <Label>Parent Freight Account *</Label>
                      <Select value={freightParentAccountId} onValueChange={setFreightParentAccountId}>
                        <SelectTrigger data-testid="select-freight-parent-account">
                          <SelectValue placeholder="Select account..." />
                        </SelectTrigger>
                        <SelectContent>
                          {parentFreightAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={String(acc.id)}>
                              {acc.name} {acc.code ? `(${acc.code})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {preview && preview.preview.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Preview & Validation</CardTitle>
            <CardDescription>
              Review the data and validate before importing. {preview.preview.length} container(s) found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {validationResult && hasValidationErrors && (
              <div className="mb-4 p-4 bg-destructive/10 border border-destructive rounded-md">
                <div className="flex items-start gap-2">
                  <XCircle className="w-5 h-5 text-destructive mt-0.5" />
                  <div>
                    <h3 className="font-semibold text-destructive">Validation Errors Found</h3>
                    <ul className="mt-2 space-y-1 text-sm text-destructive">
                      {validationResult.errors.map((error: React.ReactNode, idx: number) => (
                        <li key={idx}>• {error}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {validationResult && !hasValidationErrors && (
              <div className="mb-4 p-4 bg-green-500/10 border border-green-500 rounded-md">
                <div className="flex items-start gap-2">
                  <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />
                  <div>
                    <h3 className="font-semibold text-green-600">Validation Passed</h3>
                    <p className="mt-1 text-sm text-green-600">All items validated successfully. Ready to import.</p>
                  </div>
                </div>
              </div>
            )}

            {preview.preview.map((container: POImportContainer, idx: number) => (
              <div key={idx} className="space-y-4 mb-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Container: {container.containerNumber}</h3>
                  <div className="flex gap-4 text-sm">
                    <span className="text-muted-foreground">{container.itemsCount} items</span>
                    <span className="text-muted-foreground">{container.posCount} PO(s)</span>
                  </div>
                </div>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>PO Number</TableHead>
                        <TableHead>Item Name</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Line Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {container.items.map((item: POImportItem, itemIdx: number) => (
                        <TableRow key={itemIdx}>
                          <TableCell>{item.poNumber}</TableCell>
                          <TableCell>{item.itemName}</TableCell>
                          <TableCell className="text-right">{formatCurrency(Number(item.quantity))}</TableCell>
                          <TableCell className="text-right">${formatCurrency(Number(item.rate))}</TableCell>
                          <TableCell className="text-right font-medium">
                            ${formatCurrency(Number(item.lineTotal))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 bg-muted rounded-md">
                  <div>
                    <p className="text-sm text-muted-foreground">Items Total</p>
                    <p className="text-lg font-semibold">${formatCurrency(Number(container.itemsTotal))}</p>
                  </div>
                  {Number(container.charges.freight) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Freight</p>
                      <p className="text-lg font-semibold">${formatCurrency(Number(container.charges.freight))}</p>
                    </div>
                  )}
                  {Number(container.charges.surcharge) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Surcharge</p>
                      <p className="text-lg font-semibold">${formatCurrency(Number(container.charges.surcharge))}</p>
                    </div>
                  )}
                  {Number(container.charges.fumigation) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Fumigation</p>
                      <p className="text-lg font-semibold">${formatCurrency(Number(container.charges.fumigation))}</p>
                    </div>
                  )}
                  {Number(container.charges.discount) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Discount</p>
                      <p className="text-lg font-semibold text-red-500">
                        -${formatCurrency(Number(container.charges.discount))}
                      </p>
                    </div>
                  )}
                  {Number(container.charges.documentCharges) > 0 && (
                    <div>
                      <p className="text-sm text-muted-foreground">Document Charges</p>
                      <p className="text-lg font-semibold">
                        ${formatCurrency(Number(container.charges.documentCharges))}
                      </p>
                    </div>
                  )}
                  <div className="col-span-full border-t pt-2">
                    <p className="text-sm text-muted-foreground">Grand Total</p>
                    <p className="text-xl font-bold">${formatCurrency(Number(container.grandTotal))}</p>
                  </div>
                </div>
              </div>
            ))}

            <div className="flex flex-wrap gap-2 justify-end mt-4">
              <Button variant="outline" onClick={handleCancel} data-testid="button-cancel">
                Cancel
              </Button>
              <Button
                onClick={handleValidate}
                disabled={
                  validateMutation.isPending ||
                  suppliersLoading ||
                  suppliersError ||
                  !selectedSupplier ||
                  !containerNumber
                }
                variant={isValidated && !hasValidationErrors ? "secondary" : "default"}
                data-testid="button-validate"
              >
                {validateMutation.isPending ? (
                  "Validating..."
                ) : (
                  <>
                    {isValidated && !hasValidationErrors ? (
                      <CheckCircle className="w-4 h-4 mr-2" />
                    ) : (
                      <FileSpreadsheet className="w-4 h-4 mr-2" />
                    )}
                    {isValidated ? "Re-validate" : "Validate"}
                  </>
                )}
              </Button>
              <Button
                onClick={handleImport}
                disabled={importMutation.isPending || !isValidated || hasValidationErrors}
                data-testid="button-import"
              >
                {importMutation.isPending ? (
                  "Importing..."
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Import
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
