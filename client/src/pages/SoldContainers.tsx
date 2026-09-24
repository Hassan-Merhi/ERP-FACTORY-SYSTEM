import { searchAny } from "@shared/searchNormalization";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatNumber } from "@/lib/formatNumber";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HandCoins, Search, Eye } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { PageHeader } from "@/components/PageHeader";

interface SoldContainer {
  containerId: number;
  containerNumber: string;
  supplierId: number;
  status: string;
  importDate: string;
  itemsTotal: string;
  chargesTotal: string;
  grandTotal: string;
  saleId: number;
  customerId: number;
  customerName: string;
  saleDate: string;
  containerCost: string;
  commission: string;
  commissionAccountId: number | null;
  totalAmount: string;
  notes: string | null;
}

export default function SoldContainers() {
  const [searchTerm, setSearchTerm] = useState("");
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();

  const { data: soldContainers = [], isLoading } = useQuery<SoldContainer[]>({
    queryKey: ["/api/containers/sold", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });

  // Filter based on search term
  const filteredSales = soldContainers.filter((sale) => {
    if (!searchTerm) return true;

    return searchAny(searchTerm, sale.containerNumber, sale.customerName);
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <PageHeader title="Sold Containers" subtitle="View all containers that have been sold to customers" />
        </div>
        <HandCoins className="h-8 w-8 text-muted-foreground" />
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by container number or customer..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
          data-testid="input-search-sold-containers"
        />
      </div>

      {filteredSales.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <HandCoins className="w-16 h-16 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">No sold containers found</h2>
            <p className="text-muted-foreground">
              {soldContainers.length === 0 ? "No containers have been sold yet" : "Try adjusting your search"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Container Number</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Sale Date</TableHead>
                  <TableHead className="text-right">Container Cost</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Commission</TableHead>
                  <TableHead className="text-right">Total Amount</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSales.map((sale) => (
                  <TableRow key={sale.saleId} data-testid={`row-sale-${sale.saleId}`}>
                    <TableCell className="font-mono font-medium">{sale.containerNumber}</TableCell>
                    <TableCell data-testid={`text-customer-${sale.saleId}`}>{sale.customerName}</TableCell>
                    <TableCell className="font-mono" data-testid={`text-sale-date-${sale.saleId}`}>
                      {formatDisplayDate(sale.saleDate)}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-sale-price-${sale.saleId}`}>
                      ${formatNumber(parseFloat(sale.containerCost))}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono hidden sm:table-cell"
                      data-testid={`text-commission-${sale.saleId}`}
                    >
                      ${formatNumber(parseFloat(sale.commission))}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold" data-testid={`text-total-${sale.saleId}`}>
                      ${formatNumber(parseFloat(sale.totalAmount))}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/containers/${sale.containerId}`}>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`button-view-${sale.saleId}`}
                          data-remote-control-safe="true"
                          data-remote-control-action="view"
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
