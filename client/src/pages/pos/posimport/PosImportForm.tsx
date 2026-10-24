/**
 * Upload card for the POS Import page: credit-sale toggle, file picker, sale
 * date, optional currency selector, location + cash-account/customer targets
 * and the parse/validate/import actions.
 *
 * Split out of POSImport.tsx unchanged — toggling credit sale still clears the
 * cash account, customer and any previous validation result, and the action
 * buttons keep their exact disabled conditions.
 */
import { CheckCircle, CreditCard, FileSpreadsheet, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatNumber } from "@/lib/formatNumber";
import type { PosImportModel } from "./usePosImportModel";

export function PosImportForm({ model }: { model: PosImportModel }) {
  const { isCreditSale, saleCurrency, displayCurrency, exchangeRate, isValidated, hasValidationErrors } = model;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Sales Data</CardTitle>
        <CardDescription>Upload an Excel file with columns: Barcode, Quantity, Rate</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-4 p-3 rounded-lg bg-muted/50">
          <div className="flex items-center gap-2">
            <Switch
              id="creditSale"
              checked={isCreditSale}
              onCheckedChange={model.toggleCreditSale}
              data-testid="switch-credit-sale"
            />
            <Label htmlFor="creditSale" className="cursor-pointer">
              Credit Sale
            </Label>
          </div>
          {isCreditSale && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <CreditCard className="h-4 w-4" />
              Sale will be recorded as receivable from customer
            </span>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="file">Excel File</Label>
            <Input
              id="file"
              type="file"
              accept=".xlsx,.xls"
              onChange={model.handleFileChange}
              data-testid="input-file"
            />
            {model.file && <p className="text-sm text-muted-foreground">Selected: {model.file.name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="saleDate">Sale Date</Label>
            <Input
              id="saleDate"
              type="date"
              value={model.saleDate}
              onChange={(e) => model.setSaleDate(e.target.value)}
              data-testid="input-sale-date"
            />
          </div>
        </div>

        {model.showCurrencySelector && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="currency">Currency (Excel rates are in)</Label>
              <Select value={saleCurrency} onValueChange={(v) => model.setSaleCurrency(v as "USD" | "CFA" | "ZMW")}>
                <SelectTrigger id="currency" data-testid="select-currency">
                  <SelectValue placeholder="Select currency" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  {displayCurrency === "CFA" && <SelectItem value="CFA">CFA</SelectItem>}
                  {displayCurrency === "ZMW" && <SelectItem value="ZMW">ZMW — Kwacha</SelectItem>}
                </SelectContent>
              </Select>
              {saleCurrency !== "USD" && exchangeRate && (
                <p className="text-sm text-muted-foreground">
                  Rate: 1 USD = {formatNumber(exchangeRate, 6)} {saleCurrency}. Amounts will be posted in USD with the
                  original {saleCurrency} and locked rate recorded.
                </p>
              )}
              {saleCurrency !== "USD" && !exchangeRate && (
                <p className="text-sm text-destructive">
                  No applicable USD/{saleCurrency} rate for this sale date. Set a rate in Settings before importing.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="location">Location</Label>
            <Select value={model.selectedLocation} onValueChange={model.setSelectedLocation}>
              <SelectTrigger id="location" data-testid="select-location">
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                {model.locations.map((location) => (
                  <SelectItem key={location.id} value={location.id.toString()}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isCreditSale ? (
            <div className="space-y-2">
              <Label htmlFor="customer">Customer</Label>
              <Select value={model.selectedCustomer} onValueChange={model.setSelectedCustomer}>
                <SelectTrigger id="customer" data-testid="select-customer">
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {model.customers.map((customer) => (
                    <SelectItem key={customer.id} value={customer.id.toString()}>
                      {customer.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="cashAccount">Cash Account</Label>
              <Select value={model.selectedCashAccount} onValueChange={model.setSelectedCashAccount}>
                <SelectTrigger id="cashAccount" data-testid="select-cash-account">
                  <SelectValue placeholder="Select cash account" />
                </SelectTrigger>
                <SelectContent>
                  {model.ledgerAccounts
                    .filter((account) => account.accountType === "Cash")
                    .map((account) => (
                      <SelectItem key={account.id} value={account.id.toString()}>
                        {account.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={model.handleParse}
            disabled={!model.file || model.parseMutation.isPending}
            data-testid="button-parse"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            {model.parseMutation.isPending ? "Parsing..." : "Parse File"}
          </Button>

          <Button
            onClick={model.handleValidate}
            disabled={
              !model.preview ||
              !model.selectedLocation ||
              (!isCreditSale && !model.selectedCashAccount) ||
              (isCreditSale && !model.selectedCustomer) ||
              model.validateMutation.isPending
            }
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
            {model.validateMutation.isPending ? "Validating..." : "Validate"}
          </Button>

          <Button
            onClick={model.handleImport}
            disabled={
              !isValidated ||
              hasValidationErrors ||
              model.importMutation.isPending ||
              model.creditImportMutation.isPending
            }
            data-testid="button-import"
          >
            <Upload className="h-4 w-4 mr-2" />
            {model.importMutation.isPending || model.creditImportMutation.isPending ? "Importing..." : "Import"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
