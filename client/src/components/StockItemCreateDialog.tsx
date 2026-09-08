import type { ClientErrorLike } from "@/lib/clientError";
import { useForm, type SubmitErrorHandler } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { insertStockItemSchema, type InsertStockItem } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";
import { z } from "zod";

interface StockItemCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface StockGroup {
  id: number;
  code: string;
  name: string;
}

interface StockGrade {
  id: number;
  name: string;
}

interface StockCategory {
  id: number;
  name: string;
}

// Extend the schema to make companyId optional for the form
// (companyId is added during submission); stockGroupId is required
const formSchema = insertStockItemSchema.extend({
  stockGroupId: z.number({ error: "Stock Group is required" }),
  companyId: z.number().optional(),
  gradeId: z.number().nullable().optional(),
  categoryId: z.number().nullable().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function StockItemCreateDialog({ open, onOpenChange }: StockItemCreateDialogProps) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  // Fetch stock groups
  const { data: stockGroups = [] } = useQuery<StockGroup[]>({
    queryKey: ["/api/stock-groups"],
    enabled: open,
  });

  const { data: stockGrades = [] } = useQuery<StockGrade[]>({
    queryKey: ["/api/stock-grades"],
    enabled: open,
  });

  const { data: stockCategories = [] } = useQuery<StockCategory[]>({
    queryKey: ["/api/stock-categories"],
    enabled: open,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: "",
      name: "",
      uom: "",
      stockGroupId: undefined,
      gradeId: null,
      categoryId: null,
      sellingPrice: "0.00",
      openingQty: "0",
      openingRate: "0.00",
      openingValue: "0.00",
      reorderLevel: "0",
      active: true,
    },
    mode: "onSubmit",
    shouldFocusError: true,
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async (data: InsertStockItem) => {
      return await apiRequest("POST", "/api/stock-items", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      toast({
        title: "Stock Item Created",
        description: "The stock item has been created successfully.",
      });
      form.reset();
      onOpenChange(false);
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Creation Failed",
        description: error.message || "Failed to create stock item",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: FormValues) => {
    if (!selectedCompany) {
      toast({
        title: "No Company Selected",
        description: "Please select a company first",
        variant: "destructive",
      });
      return;
    }

    createMutation.mutate({
      ...data,
      companyId: selectedCompany.id,
    } as InsertStockItem);
  };

  const onInvalid: SubmitErrorHandler<FormValues> = (errors) => {
    const errorMessages = Object.values(errors)
      .map((err) => (typeof err?.message === "string" ? err.message : undefined))
      .filter((message): message is string => Boolean(message));

    if (errorMessages.length > 0) {
      toast({
        title: "Validation Error",
        description: errorMessages.join(", "),
        variant: "destructive",
      });
    }
  };

  const handleCancel = () => {
    form.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="text-dialog-title">Create Stock Item</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-4 py-4" noValidate>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code *</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g., ITEM001" data-testid="input-code" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name *</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Item name" data-testid="input-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="uom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Unit of Measure *</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g., Pieces, Kg, Box" data-testid="input-uom" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="stockGroupId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Stock Group *</FormLabel>
                    <Select
                      value={field.value?.toString() || ""}
                      onValueChange={(value) => field.onChange(parseInt(value))}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-stock-group">
                          <SelectValue placeholder="Select a group (required)" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {stockGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id.toString()}>
                            {group.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {stockGrades.length > 0 && (
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="gradeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Grade</FormLabel>
                      <Select
                        value={field.value?.toString() || "none"}
                        onValueChange={(value) => field.onChange(value === "none" ? null : parseInt(value))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-grade">
                            <SelectValue placeholder="Select grade (optional)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">— No Grade —</SelectItem>
                          {stockGrades.map((grade) => (
                            <SelectItem key={grade.id} value={grade.id.toString()}>
                              {grade.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="categoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category</FormLabel>
                      <Select
                        value={field.value?.toString() || "none"}
                        onValueChange={(value) => field.onChange(value === "none" ? null : parseInt(value))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-category">
                            <SelectValue placeholder="Select category (optional)" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">— No Category —</SelectItem>
                          {stockCategories.map((cat) => (
                            <SelectItem key={cat.id} value={cat.id.toString()}>
                              {cat.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <div className="grid grid-cols-3 gap-4" style={{ display: "none" }}>
              <FormField
                control={form.control}
                name="openingQty"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Opening Qty</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ""} type="number" step="0.001" placeholder="0" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="openingRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Opening Rate</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ""} type="number" step="0.01" placeholder="0.00" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="openingValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Opening Value</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ""} type="number" step="0.01" placeholder="0.00" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                disabled={createMutation.isPending}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending} data-testid="button-create">
                {createMutation.isPending ? "Creating..." : "Create Item"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
