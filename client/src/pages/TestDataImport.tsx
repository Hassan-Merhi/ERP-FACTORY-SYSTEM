import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { formatNumber } from "@/lib/formatNumber";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Plus, Trash2, FlaskConical, AlertTriangle, Play, Pause } from "lucide-react";
import { DatePickerInput } from "@/components/ui/date-picker-input";

interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
  subType?: string;
}

interface Voucher {
  id: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  description: string | null;
  totalAmount: string;
  optional: boolean;
}

const TEST_DATA_PREFIX = "TEST-";

const entryFormSchema = z.object({
  date: z.string().min(1, "Date is required"),
  debitAccountId: z.string().min(1, "Debit account is required"),
  creditAccountId: z.string().min(1, "Credit account is required"),
  amount: z
    .string()
    .min(1, "Amount is required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, "Amount must be a positive number"),
  description: z.string().optional(),
});

type EntryFormValues = z.infer<typeof entryFormSchema>;

export default function TestDataImport() {
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const [isApplyingAll, setIsApplyingAll] = useState(false);
  const [isRemovingAll, setIsRemovingAll] = useState(false);
  const [isDeletingAll, setIsDeletingAll] = useState(false);

  const form = useForm<EntryFormValues>({
    resolver: zodResolver(entryFormSchema),
    defaultValues: {
      date: format(new Date(), "yyyy-MM-dd"),
      debitAccountId: "",
      creditAccountId: "",
      amount: "",
      description: "",
    },
  });

  // Fetch ledger accounts
  const { data: accounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts"],
  });

  // Fetch all vouchers to find test data vouchers
  const { data: allVouchers = [], refetch: _refetchVouchers } = useQuery<Voucher[]>({
    queryKey: ["/api/vouchers"],
  });

  // Filter to only test data vouchers
  const testVouchers = useMemo(() => {
    return allVouchers.filter((v) => v.voucherNumber.startsWith(TEST_DATA_PREFIX));
  }, [allVouchers]);

  // Group accounts by type for easier selection
  const accountsByType = useMemo(() => {
    const grouped: Record<string, LedgerAccount[]> = {};
    accounts.forEach((acc) => {
      const key = acc.accountType;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(acc);
    });
    return grouped;
  }, [accounts]);

  // Stats
  const stats = useMemo(() => {
    const applied = testVouchers.filter((v) => !v.optional).length;
    const draft = testVouchers.filter((v) => v.optional).length;
    const total = testVouchers.reduce((sum, v) => sum + parseFloat(v.totalAmount || "0"), 0);
    return { applied, draft, total, count: testVouchers.length };
  }, [testVouchers]);

  // Create test voucher mutation
  const createMutation = useMutation({
    mutationFn: async (data: EntryFormValues) => {
      const res = await apiRequest("POST", "/api/test-data/vouchers", {
        date: data.date,
        debitAccountId: parseInt(data.debitAccountId),
        creditAccountId: parseInt(data.creditAccountId),
        amount: data.amount,
        description: data.description || `Test data entry`,
      });
      return await res.json();
    },
    onSuccess: () => {
      toast({
        title: "Test Entry Created",
        description: "Entry created as optional (draft). Toggle to apply to calculations.",
      });
      form.reset({
        date: format(new Date(), "yyyy-MM-dd"),
        debitAccountId: "",
        creditAccountId: "",
        amount: "",
        description: "",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Toggle single voucher
  const toggleMutation = useMutation({
    mutationFn: async ({ id, optional }: { id: number; optional: boolean }) => {
      const res = await apiRequest("PATCH", `/api/vouchers/${id}/optional`, { optional });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Delete single voucher
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vouchers/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Test entry removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  // Apply all test vouchers (set optional = false)
  const handleApplyAll = async () => {
    setIsApplyingAll(true);
    try {
      const drafts = testVouchers.filter((v) => v.optional);
      for (const v of drafts) {
        await apiRequest("PATCH", `/api/vouchers/${v.id}/optional`, { optional: false });
      }
      toast({ title: "Applied", description: `${drafts.length} test entries applied to calculations` });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    } catch (error) {
      toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsApplyingAll(false);
    }
  };

  // Remove all test vouchers from calculations (set optional = true)
  const handleRemoveAll = async () => {
    setIsRemovingAll(true);
    try {
      const applied = testVouchers.filter((v) => !v.optional);
      for (const v of applied) {
        await apiRequest("PATCH", `/api/vouchers/${v.id}/optional`, { optional: true });
      }
      toast({ title: "Removed", description: `${applied.length} test entries removed from calculations` });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    } catch (error) {
      toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsRemovingAll(false);
    }
  };

  // Delete all test vouchers
  const handleDeleteAll = async () => {
    setIsDeletingAll(true);
    try {
      for (const v of testVouchers) {
        await apiRequest("DELETE", `/api/vouchers/${v.id}`);
      }
      toast({ title: "Deleted", description: `${testVouchers.length} test entries permanently deleted` });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    } catch (error) {
      toast({ title: "Error", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsDeletingAll(false);
    }
  };

  const onSubmit = (data: EntryFormValues) => {
    createMutation.mutate(data);
  };

  const _getAccountName = (id: number | string) => {
    const acc = accounts.find((a) => a.id === (typeof id === "string" ? parseInt(id) : id));
    return acc ? `${acc.name} (${acc.code})` : "Unknown";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Test Data Import"
        subtitle="Add historical data to test Net Profit calculations - easily removable"
        icon={<FlaskConical className="h-5 w-5" />}
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.count}</div>
            <p className="text-sm text-muted-foreground">Total Test Entries</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-green-600">{stats.applied}</div>
            <p className="text-sm text-muted-foreground">Applied (In Calculations)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-amber-600">{stats.draft}</div>
            <p className="text-sm text-muted-foreground">Draft (Not Applied)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatNumber(stats.total)}</div>
            <p className="text-sm text-muted-foreground">Total Amount</p>
          </CardContent>
        </Card>
      </div>

      {/* Bulk Actions */}
      {testVouchers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Bulk Actions</CardTitle>
            <CardDescription>Apply or remove all test data from calculations at once</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-4">
            <Button
              onClick={handleApplyAll}
              disabled={isApplyingAll || stats.draft === 0}
              className="gap-2"
              data-testid="button-apply-all"
            >
              {isApplyingAll ? (
                "Applying..."
              ) : (
                <>
                  <Play className="h-4 w-4" /> Apply All ({stats.draft})
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleRemoveAll}
              disabled={isRemovingAll || stats.applied === 0}
              className="gap-2"
              data-testid="button-remove-all"
            >
              {isRemovingAll ? (
                "Removing..."
              ) : (
                <>
                  <Pause className="h-4 w-4" /> Remove All ({stats.applied})
                </>
              )}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  className="gap-2"
                  disabled={isDeletingAll || testVouchers.length === 0}
                  data-testid="button-delete-all"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete All Test Data
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete All Test Data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete {testVouchers.length} test entries. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDeleteAll}>
                    {isDeletingAll ? "Deleting..." : "Delete All"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Entry Form */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Add Test Entry</CardTitle>
            <CardDescription>Create a journal entry as a draft. Toggle to include in calculations.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
                <FormField
                  control={form.control}
                  name="date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <DatePickerInput
                          value={field.value}
                          onChange={field.onChange}
                          placeholder="Select date"
                          data-testid="input-test-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="debitAccountId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Debit Account (Expense/Asset)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-debit-account">
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(accountsByType).map(([type, accs]) => (
                            <div key={type}>
                              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{type}</div>
                              {accs.map((acc) => (
                                <SelectItem key={acc.id} value={acc.id.toString()}>
                                  {acc.name} ({acc.code})
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="creditAccountId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Credit Account (Cash/Bank/Liability)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-credit-account">
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(accountsByType).map(([type, accs]) => (
                            <div key={type}>
                              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{type}</div>
                              {accs.map((acc) => (
                                <SelectItem key={acc.id} value={acc.id.toString()}>
                                  {acc.name} ({acc.code})
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          {...field}
                          data-testid="input-test-amount"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description (Optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="e.g., Electricity Jan 2025"
                          {...field}
                          data-testid="input-test-description"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  className="w-full gap-2"
                  disabled={createMutation.isPending}
                  data-testid="button-add-test-entry"
                >
                  <Plus className="h-4 w-4" />
                  {createMutation.isPending ? "Creating..." : "Add Test Entry"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {/* Test Entries Table */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Test Entries</CardTitle>
            <CardDescription>
              All entries prefixed with TEST- are test data. Green = applied to calculations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {testVouchers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No test entries yet. Add one using the form.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Voucher #</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {testVouchers.map((voucher) => (
                    <TableRow key={voucher.id} data-testid={`row-test-voucher-${voucher.id}`}>
                      <TableCell>{formatDisplayDate(voucher.voucherDate)}</TableCell>
                      <TableCell className="font-mono text-sm">{voucher.voucherNumber}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{voucher.description}</TableCell>
                      <TableCell className="text-right">{formatNumber(parseFloat(voucher.totalAmount))}</TableCell>
                      <TableCell>
                        {voucher.optional ? (
                          <Badge variant="secondary">Draft</Badge>
                        ) : (
                          <Badge className="bg-green-600">Applied</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant={voucher.optional ? "default" : "outline"}
                            onClick={() => toggleMutation.mutate({ id: voucher.id, optional: !voucher.optional })}
                            disabled={toggleMutation.isPending}
                            data-testid={`button-toggle-${voucher.id}`}
                          >
                            {voucher.optional ? "Apply" : "Remove"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteMutation.mutate(voucher.id)}
                            disabled={deleteMutation.isPending}
                            data-testid={`button-delete-${voucher.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Info Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5" />
            <div>
              <h3 className="font-medium mb-1">How Test Data Works</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>Test entries are created as "optional" journal vouchers with a TEST- prefix</li>
                <li>
                  Optional vouchers are <strong>excluded</strong> from all financial calculations (Net Profit, Balance
                  Sheet, etc.)
                </li>
                <li>
                  Click "Apply" to include an entry in calculations - this helps you test if your totals match Tally
                </li>
                <li>Click "Remove" to exclude an entry from calculations without deleting it</li>
                <li>Use "Delete All Test Data" to permanently remove all test entries when you're done testing</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
