import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pencil } from "lucide-react";

interface VoucherListPanelProps {
  onEdit: (id: number) => void;
  formatAmount: (amount: number) => string;
}

export function VoucherListPanel({ onEdit, formatAmount }: VoucherListPanelProps) {
  const { data: vouchers = [], isLoading } = useQuery<
    {
      id: number;
      voucherDate: string;
      optional?: boolean;
      voucherType?: string;
      description?: string | null;
      totalAmount?: string | number | null;
    }[]
  >({
    queryKey: ["/api/vouchers"],
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">Loading vouchers...</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Recent Vouchers</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vouchers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No vouchers found
                </TableCell>
              </TableRow>
            ) : (
              vouchers.map((voucher) => (
                <TableRow key={voucher.id}>
                  <TableCell className="font-medium">{format(new Date(voucher.voucherDate), "dd MMM yyyy")}</TableCell>
                  <TableCell>
                    <Badge variant={voucher.optional ? "outline" : "default"}>{voucher.voucherType}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate">{voucher.description}</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatAmount(parseFloat(String(voucher.totalAmount ?? "0")))}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(voucher.id)}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
