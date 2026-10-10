import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  User,
  Phone,
  Building,
  CreditCard,
  FileText,
  DollarSign,
  Upload,
  Trash2,
  Download,
  Eye,
  Pencil,
  Banknote,
  Plus,
  UserX,
} from "lucide-react";
import type { Props } from "./erpworkerdetail/types";
import { formatBytes } from "./erpworkerdetail/utils";
import { useERPWorkerDetailModel } from "./erpworkerdetail/useERPWorkerDetailModel";
export function ERPWorkerDetail({ worker, onBack, onEdit }: Props) {
  const erpWorkerDetail = useERPWorkerDetailModel({ worker, onBack });
  const {
    activeTab,
    advanceAmount,
    advanceDate,
    advanceDialogOpen,
    advanceNotes,
    advances,
    advancesLoading,
    advancesOutstanding,
    createAdvanceMutation,
    currentBalance,
    deleteAdvanceMutation,
    deleteDocMutation,
    docs,
    docsLoading,
    editAdvance,
    editDocDesc,
    editDocDialog,
    editDocMutation,
    editDocName,
    endContractDialogOpen,
    endContractMutation,
    fileInputRef,
    fmt,
    fmtDate,
    fullName,
    getFileIcon,
    handleDownload,
    handleFileSelect,
    handleUploadConfirm,
    handleView,
    infoRow,
    initials,
    monthlySalary,
    netBalance,
    openingBalance,
    pendingFile,
    setActiveTab,
    setAdvanceAmount,
    setAdvanceDate,
    setAdvanceDialogOpen,
    setAdvanceNotes,
    setEditAdvance,
    setEditDocDesc,
    setEditDocDialog,
    setEditDocName,
    setEndContractDialogOpen,
    setPendingFile,
    setUploadDesc,
    setUploadDialogOpen,
    statementRows,
    totalAdvancesGiven,
    totalDeposits,
    totalWithdrawals,
    txLoading,
    uploadDesc,
    uploadDialogOpen,
    uploadDocMutation,
  } = erpWorkerDetail;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button size="icon" variant="ghost" onClick={onBack} data-testid="button-back-worker-detail">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-lg font-semibold" data-testid="text-worker-detail-name">
            {fullName}
          </h2>
          <p className="text-sm text-muted-foreground">
            {worker.code} · {worker.department || "—"}
          </p>
        </div>
      </div>

      {/* Main layout: left card + right tabs */}
      <div className="flex flex-col lg:flex-row gap-4 items-start">
        {/* Left summary card */}
        <div className="w-full lg:w-72 shrink-0 space-y-3">
          <Card>
            <CardContent className="p-5 flex flex-col items-center gap-3">
              <Avatar className="h-16 w-16">
                <AvatarFallback className="text-xl font-semibold">{initials}</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="font-semibold text-base" data-testid="text-card-worker-name">
                  {fullName}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-card-worker-code">
                  {worker.code}
                </p>
              </div>
              <Badge
                variant={worker.active === false ? "secondary" : "outline"}
                className="text-xs"
                data-testid="badge-worker-status"
              >
                {worker.active === false ? "Inactive" : "Active"}
              </Badge>
              {onEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => onEdit(worker)}
                  data-testid="button-edit-worker-profile"
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Worker
                </Button>
              )}
              {worker.active !== false && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full"
                  onClick={() => setEndContractDialogOpen(true)}
                  data-testid="button-end-contract"
                >
                  <UserX className="h-3.5 w-3.5 mr-1.5" /> End Contract
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-0">
              <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Salary Summary</p>
              {infoRow("Monthly Salary", fmt(monthlySalary), "text-card-monthly-salary")}
              {infoRow("Current Balance", fmt(currentBalance), "text-card-current-balance")}
              {infoRow("Total Earned", fmt(totalDeposits), "text-card-total-earned")}
              {infoRow("Total Paid Out", fmt(totalWithdrawals), "text-card-total-paid")}
              {infoRow("Advances Given", fmt(totalAdvancesGiven), "text-card-advances")}
              {infoRow("Joined", fmtDate(worker.joinDate), "text-card-joined")}
            </CardContent>
          </Card>
        </div>

        {/* Right tabs */}
        <div className="flex-1 min-w-0">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4 flex-wrap">
              <TabsTrigger value="profile" data-testid="tab-erp-profile">
                Profile
              </TabsTrigger>
              <TabsTrigger value="statement" data-testid="tab-erp-statement">
                Statement
              </TabsTrigger>
              <TabsTrigger value="advances" data-testid="tab-erp-advances">
                Advances
              </TabsTrigger>
              <TabsTrigger value="docs" data-testid="tab-erp-docs">
                Docs
              </TabsTrigger>
            </TabsList>

            {/* ── Profile ── */}
            <TabsContent value="profile" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <User className="h-3.5 w-3.5" /> Personal
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Full Name", fullName, "text-profile-fullname")}
                    {infoRow("Father Name", undefined)}
                    {infoRow("National ID", undefined)}
                    {infoRow("Date of Birth", undefined)}
                    {infoRow("Gender", undefined)}
                    {infoRow("Nationality", undefined)}
                    {infoRow("Marital Status", undefined)}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Phone className="h-3.5 w-3.5" /> Contact
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Phone", worker.phone, "text-profile-phone")}
                    {infoRow("Email", worker.email, "text-profile-email")}
                    {infoRow("Emergency Contact", undefined)}
                    {infoRow("Address", undefined)}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building className="h-3.5 w-3.5" /> Employment
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Employee Code", worker.code, "text-profile-code")}
                    {infoRow("Department", worker.department, "text-profile-department")}
                    {infoRow("Employee Type", worker.employeeType, "text-profile-type")}
                    {infoRow("Date Joined", fmtDate(worker.joinDate), "text-profile-joined")}
                    {infoRow("Status", worker.active === false ? "Inactive" : "Active", "text-profile-status")}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CreditCard className="h-3.5 w-3.5" /> Compensation
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    {infoRow("Monthly Salary", fmt(monthlySalary), "text-profile-salary")}
                    {infoRow("Opening Balance", fmt(openingBalance), "text-profile-opening")}
                    {infoRow("Current Balance", fmt(currentBalance), "text-profile-balance")}
                    {infoRow("Salary Type", "Monthly")}
                    {infoRow("Payment Method", undefined)}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* ── Statement ── */}
            <TabsContent value="statement" className="space-y-4">
              {/* KPI summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Current Balance</p>
                    <p
                      className={`text-xl font-bold ${netBalance >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                      data-testid="stat-erp-net-balance"
                    >
                      {fmt(netBalance)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Owed to worker</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total Earned</p>
                    <p
                      className="text-xl font-bold text-green-700 dark:text-green-400"
                      data-testid="stat-erp-total-earned"
                    >
                      {fmt(totalDeposits)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Accrued salary</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total Paid</p>
                    <p className="text-xl font-bold text-blue-700 dark:text-blue-400" data-testid="stat-erp-total-paid">
                      {fmt(totalWithdrawals)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Paid out</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Advances Left</p>
                    <p
                      className={`text-xl font-bold ${advancesOutstanding > 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}
                      data-testid="stat-erp-advances-left"
                    >
                      {fmt(advancesOutstanding)}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Outstanding</p>
                  </CardContent>
                </Card>
              </div>

              {/* Ledger table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Running Ledger</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {txLoading || advancesLoading ? (
                    <div className="p-4 space-y-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-9 w-full" />
                      ))}
                    </div>
                  ) : statementRows.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <DollarSign className="mx-auto h-8 w-8 mb-3 opacity-30" />
                      <p className="text-sm">No entries yet</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Reference</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead className="text-right">Earned</TableHead>
                            <TableHead className="text-right">Paid/Deducted</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {statementRows.map((row, i) => (
                            <TableRow key={i} data-testid={`row-statement-${i}`}>
                              <TableCell className="text-xs whitespace-nowrap">{row.date}</TableCell>
                              <TableCell className="text-xs whitespace-nowrap">{row.type}</TableCell>
                              <TableCell className="text-xs font-mono whitespace-nowrap">{row.ref}</TableCell>
                              <TableCell className="text-xs max-w-[140px] truncate">{row.description || "—"}</TableCell>
                              <TableCell className="text-right font-mono text-xs text-green-700 dark:text-green-400">
                                {row.debit > 0 ? fmt(row.debit) : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs text-red-700 dark:text-red-400">
                                {row.credit > 0 ? fmt(row.credit) : "—"}
                              </TableCell>
                              <TableCell
                                className={`text-right font-mono text-xs font-semibold ${row.balance >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
                              >
                                {fmt(row.balance)}
                              </TableCell>
                              <TableCell>
                                {row.status && (
                                  <Badge variant="outline" className="text-xs">
                                    {row.status}
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Advances ── */}
            <TabsContent value="advances" className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Salary Advances</h3>
                  <p className="text-xs text-muted-foreground">ERP advances for this worker only</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditAdvance(null);
                    setAdvanceAmount("");
                    setAdvanceDate(new Date().toLocaleDateString("en-CA"));
                    setAdvanceNotes("");
                    setAdvanceDialogOpen(true);
                  }}
                  data-testid="button-add-advance"
                >
                  <Plus className="h-4 w-4 mr-1" /> Add Advance
                </Button>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total Given</p>
                    <p className="text-lg font-bold" data-testid="stat-adv-total">
                      {fmt(totalAdvancesGiven)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Outstanding</p>
                    <p
                      className={`text-lg font-bold ${advancesOutstanding > 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}
                      data-testid="stat-adv-outstanding"
                    >
                      {fmt(advancesOutstanding)}
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Unpaid Count</p>
                    <p className="text-lg font-bold" data-testid="stat-adv-count">
                      {advances.filter((a) => !a.fullyPaid).length}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardContent className="p-0">
                  {advancesLoading ? (
                    <div className="p-4 space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : advances.length === 0 ? (
                    <div className="text-center py-10 text-muted-foreground">
                      <Banknote className="mx-auto h-8 w-8 mb-3 opacity-30" />
                      <p className="text-sm">No advances recorded</p>
                    </div>
                  ) : (
                    <div className="table-responsive">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead className="text-right">Remaining</TableHead>
                            <TableHead>Notes</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {advances.map((adv) => (
                            <TableRow key={adv.id} data-testid={`row-advance-${adv.id}`}>
                              <TableCell className="text-xs whitespace-nowrap">
                                {adv.advanceDate?.slice(0, 10)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">{fmt(adv.amount)}</TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {fmt(adv.remainingBalance)}
                              </TableCell>
                              <TableCell className="text-xs max-w-[120px] truncate">{adv.notes || "—"}</TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={`text-xs ${adv.fullyPaid ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}
                                >
                                  {adv.fullyPaid ? "Repaid" : "Outstanding"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => {
                                      setEditAdvance(adv);
                                      setAdvanceAmount(adv.amount);
                                      setAdvanceDate(adv.advanceDate?.slice(0, 10) || "");
                                      setAdvanceNotes(adv.notes || "");
                                      setAdvanceDialogOpen(true);
                                    }}
                                    data-testid={`button-edit-advance-${adv.id}`}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => deleteAdvanceMutation.mutate(adv.id)}
                                    data-testid={`button-delete-advance-${adv.id}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Docs ── */}
            <TabsContent value="docs" className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Worker Documents</h3>
                  <p className="text-xs text-muted-foreground">ERP-only document storage for this worker</p>
                </div>
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.txt"
                    onChange={handleFileSelect}
                    data-testid="input-upload-doc"
                  />
                  <Button size="sm" onClick={() => fileInputRef.current?.click()} data-testid="button-upload-doc">
                    <Upload className="h-4 w-4 mr-1" /> Upload
                  </Button>
                </div>
              </div>

              {docsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : docs.length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center text-muted-foreground">
                    <FileText className="mx-auto h-8 w-8 mb-3 opacity-30" />
                    <p className="text-sm">No documents uploaded</p>
                    <p className="text-xs mt-1">PDF, JPG, PNG, WEBP, DOC, DOCX, XLS, XLSX, TXT</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {docs.map((doc) => (
                    <Card key={doc.id} data-testid={`card-doc-${doc.id}`}>
                      <CardContent className="p-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {getFileIcon(doc.fileType)}
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate" data-testid={`text-doc-name-${doc.id}`}>
                              {doc.fileName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatBytes(doc.fileSize)} · {doc.uploadedAt?.slice(0, 10)}
                            </p>
                            {doc.description && (
                              <p className="text-xs text-muted-foreground truncate">{doc.description}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleView(doc)}
                            data-testid={`button-view-doc-${doc.id}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleDownload(doc)}
                            data-testid={`button-download-doc-${doc.id}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              setEditDocDialog(doc);
                              setEditDocName(doc.fileName);
                              setEditDocDesc(doc.description || "");
                            }}
                            data-testid={`button-edit-doc-${doc.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => deleteDocMutation.mutate(doc.id)}
                            data-testid={`button-delete-doc-${doc.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* ── Upload dialog ── */}
      <Dialog
        open={uploadDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setUploadDialogOpen(false);
            setPendingFile(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {pendingFile && (
              <div className="p-3 rounded-md bg-muted text-sm">
                <p className="font-medium">{pendingFile.name}</p>
                <p className="text-muted-foreground text-xs">{formatBytes(pendingFile.size)}</p>
              </div>
            )}
            <div>
              <Label>Description (optional)</Label>
              <Textarea
                className="mt-1"
                placeholder="Describe the document..."
                value={uploadDesc}
                onChange={(e) => setUploadDesc(e.target.value)}
                data-testid="input-upload-desc"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setUploadDialogOpen(false);
                setPendingFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUploadConfirm}
              disabled={!pendingFile || uploadDocMutation.isPending}
              data-testid="button-confirm-upload"
            >
              {uploadDocMutation.isPending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit doc dialog ── */}
      <Dialog
        open={!!editDocDialog}
        onOpenChange={(open) => {
          if (!open) setEditDocDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>File Name</Label>
              <Input
                className="mt-1"
                value={editDocName}
                onChange={(e) => setEditDocName(e.target.value)}
                data-testid="input-edit-doc-name"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                className="mt-1"
                value={editDocDesc}
                onChange={(e) => setEditDocDesc(e.target.value)}
                data-testid="input-edit-doc-desc"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDocDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (editDocDialog)
                  editDocMutation.mutate({ id: editDocDialog.id, fileName: editDocName, description: editDocDesc });
              }}
              disabled={editDocMutation.isPending}
              data-testid="button-confirm-edit-doc"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── End Contract dialog ── */}
      <Dialog open={endContractDialogOpen} onOpenChange={setEndContractDialogOpen}>
        <DialogContent data-testid="dialog-end-contract">
          <DialogHeader>
            <DialogTitle>
              End Contract — {worker.firstName} {worker.lastName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <p className="text-sm text-muted-foreground">
              This will mark the worker as <span className="font-semibold text-foreground">Inactive</span> and hide them
              from all active worker lists and payroll calculations.
            </p>
            <p className="text-sm text-muted-foreground">
              Their history, statement, and documents will remain accessible by filtering for Inactive workers.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEndContractDialogOpen(false)}
              data-testid="button-cancel-end-contract"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => endContractMutation.mutate()}
              disabled={endContractMutation.isPending}
              data-testid="button-confirm-end-contract"
            >
              <UserX className="h-3.5 w-3.5 mr-1.5" />
              {endContractMutation.isPending ? "Ending…" : "End Contract"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Advance dialog ── */}
      <Dialog open={advanceDialogOpen} onOpenChange={setAdvanceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editAdvance ? "Edit Advance" : "Add Advance"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                className="mt-1"
                value={advanceDate}
                onChange={(e) => setAdvanceDate(e.target.value)}
                data-testid="input-advance-date"
              />
            </div>
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                className="mt-1"
                placeholder="0.00"
                value={advanceAmount}
                onChange={(e) => setAdvanceAmount(e.target.value)}
                data-testid="input-advance-amount"
              />
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                className="mt-1"
                placeholder="Reason for advance..."
                value={advanceNotes}
                onChange={(e) => setAdvanceNotes(e.target.value)}
                data-testid="input-advance-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdvanceDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!advanceAmount || isNaN(parseFloat(advanceAmount))) return;
                createAdvanceMutation.mutate({
                  employeeId: worker.id,
                  companyId: selectedCompany?.id ?? 0,
                  advanceDate,
                  amount: advanceAmount,
                  notes: advanceNotes || undefined,
                });
              }}
              disabled={createAdvanceMutation.isPending}
              data-testid="button-confirm-advance"
            >
              {createAdvanceMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
