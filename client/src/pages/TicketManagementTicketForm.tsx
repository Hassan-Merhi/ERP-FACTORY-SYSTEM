// Extracted from ./TicketManagement.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { categories, priorities, useTicketFormState } from "./useTicketFormState";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function TicketForm(props: {
  onCreated: (id: number, warning?: string) => void;
  onCancel: () => void;
  sourceMode: "erp" | "factory";
}) {
  const {
    assignedTo,
    category,
    create,
    description,
    error,
    initialEvidence,
    onCancel,
    priority,
    reportedUserId,
    setAssignedTo,
    setCategory,
    setDescription,
    setInitialEvidence,
    setPriority,
    setReportedUserId,
    setTitle,
    setVoucherId,
    setVoucherLabel,
    setVoucherQ,
    submit,
    title,
    users,
    voucherId,
    voucherLabel,
    voucherQ,
    vouchers,
  } = useTicketFormState(props);
  return (
    <Card className="mx-auto w-full max-w-3xl">
      <CardHeader>
        <CardTitle>Create Ticket</CardTitle>
        <p className="text-sm text-muted-foreground">
          Assign a problem to a user and optionally link an exact voucher.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-1 text-sm font-medium">
            Ticket title
            <Input
              required
              minLength={3}
              maxLength={240}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be fixed?"
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm font-medium">
              Issue type
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-full min-w-0 text-sm" aria-label="Issue type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Priority
              <Select value={priority} onValueChange={(value) => setPriority(value as typeof priority)}>
                <SelectTrigger className="w-full min-w-0 text-sm" aria-label="Priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorities.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p[0].toUpperCase() + p.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <label className="block space-y-1 text-sm font-medium">
            Assign to employee
            <Select
              value={assignedTo || "__none__"}
              onValueChange={(value) => setAssignedTo(value === "__none__" ? "" : value)}
              required
            >
              <SelectTrigger className="w-full min-w-0 text-sm" aria-label="Assign to employee">
                <SelectValue placeholder="Select employee..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select employee...</SelectItem>
                {users.data?.users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Employee associated with reported error (optional)
            <Select
              value={reportedUserId || "__none__"}
              onValueChange={(value) => setReportedUserId(value === "__none__" ? "" : value)}
            >
              <SelectTrigger className="w-full min-w-0 text-sm" aria-label="Employee associated with reported error">
                <SelectValue placeholder="Not specified / system issue" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not specified / system issue</SelectItem>
                {users.data?.users.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.username}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {users.isError && (
            <p role="alert" className="text-sm text-destructive">
              Unable to load employees.
            </p>
          )}
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="ticket-voucher-search">
              Linked voucher (optional)
            </label>
            {voucherId ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                <span className="min-w-0 flex-1 break-all">{voucherLabel}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setVoucherId(undefined);
                    setVoucherLabel("");
                    setVoucherQ("");
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id="ticket-voucher-search"
                  placeholder="Search voucher number (minimum 2 characters)"
                  value={voucherQ}
                  onChange={(e) => setVoucherQ(e.target.value)}
                />
                {voucherQ.length >= 2 && (
                  <div
                    className="max-h-44 space-y-1 overflow-auto rounded-md border p-1"
                    aria-label="Matching vouchers"
                  >
                    {vouchers.isLoading && <p className="p-2 text-sm">Searching...</p>}
                    {vouchers.isError && (
                      <p className="p-2 text-sm text-muted-foreground">Voucher search unavailable or restricted.</p>
                    )}
                    {vouchers.data?.records.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className="block w-full rounded p-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setVoucherId(v.id);
                          setVoucherLabel(`${v.reference} — ${v.type}`);
                        }}
                      >
                        {v.reference} — {v.type}
                      </button>
                    ))}
                    {vouchers.data?.records.length === 0 && (
                      <p className="p-2 text-sm text-muted-foreground">No matching vouchers.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="space-y-2">
            <span className="block text-sm font-medium">Photo or evidence (optional)</span>
            <p className="text-xs text-muted-foreground">
              Select a photo now, or add evidence from inside the ticket later. Maximum 5 MB.
            </p>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm">
                Take photo
                <input
                  aria-label="Take initial ticket photo"
                  type="file"
                  capture="environment"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => setInitialEvidence(e.target.files?.[0] ?? null)}
                />
              </label>
              <label className="inline-flex min-h-10 cursor-pointer items-center rounded-md border px-3 py-2 text-sm">
                Choose file
                <input
                  aria-label="Select initial ticket evidence"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="sr-only"
                  onChange={(e) => setInitialEvidence(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            {initialEvidence && (
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 break-all">{initialEvidence.name}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => setInitialEvidence(null)}>
                  Remove
                </Button>
              </div>
            )}
          </div>
          <label className="block space-y-1 text-sm font-medium">
            Describe the issue
            <Textarea
              required
              minLength={3}
              maxLength={10000}
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explain the mistake and the correction needed."
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !assignedTo}>
              {create.isPending ? "Creating..." : "Create ticket"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
