import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Palette } from "lucide-react";
import { useCreateBaleProductDialogState, type CreateBaleProductDialogProps } from "./useCreateBaleProductDialogState";

export function CreateBaleProductDialog({ open, onOpenChange, adminAuth }: CreateBaleProductDialogProps) {
  const { colors, canCreateProduct, categories, form, createMutation } = useCreateBaleProductDialogState({
    onOpenChange,
    adminAuth,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Bale Product</DialogTitle>
          <DialogDescription>
            Store English and Arabic on one product. Article code, weight, prices, stock, and costing remain
            language-neutral.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((data) => {
              if (canCreateProduct) createMutation.mutate(data);
            })}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="grade"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Grade *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-create-grade">
                        <SelectValue placeholder="Select grade..." />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="#1">#1 (HMD11...)</SelectItem>
                      <SelectItem value="#2">#2 (HMD12...)</SelectItem>
                      <SelectItem value="#3">#3 (HMD13...)</SelectItem>
                      <SelectItem value="#4">#4 (HMD14...)</SelectItem>
                      <SelectItem value="CREAM">CREAM (HMD10...)</SelectItem>
                      <SelectItem value="Garbage">Garbage (HMD16...)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product Name — English *</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Men Bag Cream 20kg" data-testid="input-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="nameAr"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>اسم المنتج — العربية</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="حقيبة رجالية كريمي 20 كغ" dir="rtl" data-testid="input-name-ar" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="categoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-category">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Uncategorized</SelectItem>
                        {categories
                          ?.filter((category) => category.isActive)
                          .map((category) => (
                            <SelectItem key={category.id} value={String(category.id)}>
                              {category.nameAr && category.nameAr !== category.name
                                ? `${category.name} / ${category.nameAr}`
                                : category.name}
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
                name="weightPerBaleKg"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Weight/Bale (kg)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="45" type="number" step="0.01" data-testid="input-weight" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="productionPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Production Price</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" step="0.01" min="0" data-testid="input-production-price" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sellingPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Selling Price</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" step="0.01" min="0" data-testid="input-selling-price" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description — English</FormLabel>
                    <FormControl>
                      <Textarea {...field} placeholder="Product details..." data-testid="input-description" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="descriptionAr"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>الوصف — العربية</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="تفاصيل المنتج..."
                        dir="rtl"
                        data-testid="input-description-ar"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="labelDesignColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-1.5">
                    <Palette className="h-3.5 w-3.5 text-muted-foreground" />
                    Label Design Color
                  </FormLabel>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="button-label-color-none"
                      onClick={() => field.onChange("")}
                      className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${!field.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover-elevate"}`}
                    >
                      No Design
                    </button>
                    {colors.map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        data-testid={`button-label-color-${option.value}`}
                        onClick={() => field.onChange(option.value)}
                        className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${field.value === option.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover-elevate"}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel">
                Cancel
              </Button>
              {canCreateProduct && (
                <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit">
                  {createMutation.isPending ? "Creating..." : "Create Product"}
                </Button>
              )}
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
