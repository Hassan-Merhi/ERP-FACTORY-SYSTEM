import { Search, HandCoins } from "lucide-react";
import { Eye } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SoldContainer } from "./types";

interface SoldContainersTableProps {
  isSoldLoading: boolean;
  soldContainers: SoldContainer[];
  filteredSoldContainers: SoldContainer[];
  soldSearchTerm: string;
  setSoldSearchTerm: (v: string) => void;
  formatDisplayDate: (d: string) => string;
  formatAmount: (n: number) => string;
}

export function SoldContainersTable({
  isSoldLoading,
  soldContainers,
  filteredSoldContainers,
  soldSearchTerm,
  setSoldSearchTerm,
  formatDisplayDate,
  formatAmount,
}: SoldContainersTableProps) {
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by container number or customer..."
          value={soldSearchTerm}
          onChange={(e) => setSoldSearchTerm(e.target.value)}
          className="pl-10"
          data-testid="input-search-sold-containers"
        />
      </div>

      {isSoldLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : filteredSoldContainers.length === 0 ? (
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
          <CardContent className="p-0 hidden md:block">
            <Table stickyFirstColumn>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Container Number</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Sale Date</TableHead>
                  <TableHead className="text-right">Container Cost</TableHead>
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead className="text-right">Total Amount</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSoldContainers.map((sale) => (
                  <TableRow key={sale.saleId} data-testid={`row-sale-${sale.saleId}`}>
                    <TableCell className="font-mono font-medium">{sale.containerNumber}</TableCell>
                    <TableCell data-testid={`text-customer-${sale.saleId}`}>{sale.customerName}</TableCell>
                    <TableCell className="font-mono" data-testid={`text-sale-date-${sale.saleId}`}>
                      {formatDisplayDate(sale.saleDate)}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-sale-price-${sale.saleId}`}>
                      {formatAmount(parseFloat(sale.containerCost))}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatAmount(parseFloat(sale.commission || "0"))}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      {formatAmount(parseFloat(sale.totalAmount))}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/containers/${sale.containerId}`}>
                        <Button size="sm" variant="outline" data-testid={`button-view-sale-${sale.saleId}`}>
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
          <div className="md:hidden p-3 space-y-2">
            {filteredSoldContainers.map((sale) => (
              <Link key={sale.saleId} href={`/containers/${sale.containerId}`}>
                <div
                  className="p-3 rounded-md border cursor-pointer hover-elevate"
                  data-testid={`row-sale-${sale.saleId}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono font-medium text-sm">{sale.containerNumber}</span>
                    <span className="text-xs text-muted-foreground" data-testid={`text-sale-date-${sale.saleId}`}>
                      {formatDisplayDate(sale.saleDate)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mb-1" data-testid={`text-customer-${sale.saleId}`}>
                    {sale.customerName}
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="font-mono font-semibold" data-testid={`text-sale-price-${sale.saleId}`}>
                      {formatAmount(parseFloat(sale.totalAmount))}
                    </span>
                    {parseFloat(sale.commission || "0") > 0 && (
                      <span className="text-xs text-muted-foreground">
                        Commission: {formatAmount(parseFloat(sale.commission || "0"))}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
