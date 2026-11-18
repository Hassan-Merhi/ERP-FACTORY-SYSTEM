import type { usePOSCustomersState } from "./usePOSCustomersState";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type FormControlType = ReturnType<typeof usePOSCustomersState>["form"]["control"];

export function POSCustomerOpeningFields({ control }: { control: FormControlType }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <FormField
        control={control}
        name="openingBalance"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Opening Balance</FormLabel>
            <FormControl>
              <Input
                {...field}
                value={field.value || "0"}
                type="number"
                step="0.01"
                placeholder="0.00"
                data-testid="input-opening-balance"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="openingBalanceSide"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Balance Side</FormLabel>
            <Select onValueChange={field.onChange} value={field.value || "Dr"}>
              <FormControl>
                <SelectTrigger data-testid="select-balance-side">
                  <SelectValue placeholder="Select side" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="Dr">Dr (Debit)</SelectItem>
                <SelectItem value="Cr">Cr (Credit)</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
