import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { insertCompanySchema } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { z } from "zod";
import { useEffect } from "react";

const companyFormSchema = insertCompanySchema;
type CompanyFormData = z.infer<typeof companyFormSchema>;

interface CompanyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingCompany: unknown;
  onSubmit: (data: CompanyFormData) => void;
  isPending: boolean;
}

export function CompanyDialog({ open, onOpenChange, editingCompany, onSubmit, isPending }: CompanyDialogProps) {
  const form = useForm<CompanyFormData>({
    resolver: zodResolver(companyFormSchema),
    defaultValues: {
      name: "",
      code: "",
      companyType: "erp",
      baseCurrency: "USD",
      displayCurrency: "none",
      active: true,
    },
  });

  useEffect(() => {
    if (editingCompany) {
      form.reset(editingCompany);
    } else {
      form.reset({
        name: "",
        code: "",
        companyType: "erp",
        baseCurrency: "USD",
        displayCurrency: "none",
        active: true,
      });
    }
  }, [editingCompany, form]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingCompany ? "Edit Company" : "Add Company"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company Code</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="companyType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="erp">ERP (Accounting)</SelectItem>
                      <SelectItem value="factory">Factory (Production)</SelectItem>
                      <SelectItem value="properties">Properties</SelectItem>
                      <SelectItem value="supplier_partner">Supplier Partner</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="baseCurrency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Base Currency</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="displayCurrency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display Currency</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <FormLabel>Active</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={isPending}>
                {editingCompany ? "Update" : "Create"} Company
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
