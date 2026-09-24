/**
 * Filter card for the All Daybook page: period, company multi-select, voucher
 * type, currency, status, the factory include toggle and search.
 *
 * Split out of TransactionJournal.tsx unchanged — every control still resets
 * pagination to page 1 exactly where it did before.
 */
import { Building2, Factory, Filter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import type { TransactionJournalModel } from "../useTransactionJournalModel";

export function JournalFilters({ model }: { model: TransactionJournalModel }) {
  const activeFilterCount = [
    model.selectedCos.length > 0,
    model.voucherType !== "all",
    model.currency !== "all",
    model.optionalFilter !== "all",
    model.includeFactory,
  ].filter(Boolean).length;

  const periodControl = (
    <div className="w-full space-y-2 sm:w-auto">
      <Label>Period</Label>
      <PeriodFilter value={model.periodFilter} onChange={model.applyPeriodFilter} data-testid="period-filter" />
    </div>
  );

  const advancedControls = (
    <>
      {/* Company multi-select */}
      <div className="w-full min-w-0 space-y-2 sm:w-auto">
        <Label>Companies</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-9 w-full min-w-0 justify-between gap-1.5 px-2.5 sm:w-[138px]"
              data-testid="button-company-filter"
            >
              <Building2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left text-xs">
                {model.selectedCos.length === 0 ? "All Companies" : `${model.selectedCos.length} selected`}
              </span>
              <Filter className="h-3 w-3 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[220px] max-w-[calc(100vw-2rem)]">
            <DropdownMenuLabel>Select Companies</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={model.selectedCos.length === 0}
              onCheckedChange={() => model.setSelectedCos([])}
              data-testid="checkbox-all-companies"
            >
              All Companies
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {model.availableCompanies.map((c) => (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={model.selectedCos.includes(c.id)}
                onCheckedChange={(checked) => {
                  model.setSelectedCos((prev) => (checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)));
                }}
                data-testid={`checkbox-company-${c.id}`}
              >
                <span className="truncate">{c.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Voucher type */}
      <div className="w-full space-y-2 sm:w-auto">
        <Label htmlFor="voucher-type-tj">Voucher Type</Label>
        <Select value={model.voucherType} onValueChange={model.applyVoucherType}>
          <SelectTrigger id="voucher-type-tj" className="w-full sm:w-[150px]" data-testid="select-voucher-type">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {(model.voucherTypes || []).map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Currency */}
      <div className="w-full space-y-2 sm:w-auto">
        <Label htmlFor="currency-tj">Currency</Label>
        <Select value={model.currency} onValueChange={model.applyCurrency}>
          <SelectTrigger id="currency-tj" className="w-full sm:w-[110px]" data-testid="select-currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="USD">USD</SelectItem>
            <SelectItem value="CFA">CFA</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Status */}
      <div className="w-full space-y-2 sm:w-auto">
        <Label htmlFor="status-tj">Status</Label>
        <Select value={model.optionalFilter} onValueChange={model.applyOptionalFilter}>
          <SelectTrigger id="status-tj" className="w-full sm:w-[130px]" data-testid="select-optional">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active Only</SelectItem>
            <SelectItem value="optional">Optional Only</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Factory toggle */}
      <div className="w-full space-y-2 sm:w-auto">
        <Label>Factory</Label>
        <div>
          <Button
            variant={model.includeFactory ? "default" : "outline"}
            className="w-full gap-2 sm:w-auto"
            onClick={model.toggleIncludeFactory}
            data-testid="button-toggle-factory"
          >
            <Factory className="h-4 w-4" />
            {model.includeFactory ? "Included" : "Excluded"}
          </Button>
        </div>
      </div>
    </>
  );

  const searchControl = (
    <div className="space-y-2 flex-1 min-w-0 w-full md:min-w-[200px] md:w-auto">
      <Label htmlFor="search-tj">Search</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="search-tj"
            value={model.searchInput}
            onChange={(e) => model.setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && model.handleSearch()}
            placeholder="Voucher # or narration…"
            className="pl-8"
            data-testid="input-search"
          />
        </div>
        <Button
          variant="default"
          className="w-full shrink-0 sm:w-auto"
          onClick={model.handleSearch}
          data-testid="button-search"
        >
          Search
        </Button>
        {model.search && (
          <Button variant="ghost" size="icon" onClick={model.clearSearch} data-testid="button-clear-search">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <ErpMobileFilters
      label="All Daybook filters"
      primary={
        <PeriodFilter value={model.periodFilter} onChange={model.applyPeriodFilter} data-testid="period-filter" />
      }
      quick={<JournalPhoneSearch model={model} />}
      activeCount={activeFilterCount}
      onClear={model.resetFilters}
      canClear={model.hasActiveFilters}
      data-testid="journal-filters"
    >
      {(layout) =>
        layout === "sheet" ? (
          <div className="grid gap-3">{advancedControls}</div>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Filter className="w-5 h-5" />
                  <CardTitle>Filters</CardTitle>
                </div>
                {model.hasActiveFilters && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={model.resetFilters}
                    data-testid="button-reset-filters"
                  >
                    <X className="h-4 w-4" />
                    Reset Filters
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-4">
                {periodControl}
                {advancedControls}
                {searchControl}
              </div>
            </CardContent>
          </Card>
        )
      }
    </ErpMobileFilters>
  );
}

/** Phone quick search; rendered only inside the phone filter row. */
function JournalPhoneSearch({ model }: { model: TransactionJournalModel }) {
  const { t } = useApplicationLanguage();
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          id="search-tj"
          value={model.searchInput}
          onChange={(e) => model.setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && model.handleSearch()}
          placeholder="Voucher # or narration…"
          aria-label={t("mobileFilters.search")}
          enterKeyHint="search"
          className="pl-8"
          data-testid="input-search"
        />
      </div>
      <Button
        variant="default"
        size="icon"
        className="shrink-0"
        onClick={model.handleSearch}
        aria-label={t("mobileFilters.search")}
        data-testid="button-search"
      >
        <Search className="h-4 w-4" />
      </Button>
      {model.search && (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={model.clearSearch}
          aria-label={t("mobileFilters.clearSearch")}
          data-testid="button-clear-search"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
