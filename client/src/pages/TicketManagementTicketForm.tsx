// Extracted from ./TicketManagement.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { categories, inputStyle, priorities, useTicketFormState } from "./useTicketFormState";

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
              <select className={inputStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Priority
              <select
                className={inputStyle}
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
              >
                {priorities.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm font-medium">
            Assign to employee
            <select className={inputStyle} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} required>
              <option value="">Select employee...</option>
              {users.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Employee associated with reported error (optional)
            <select className={inputStyle} value={reportedUserId} onChange={(e) => setReportedUserId(e.target.value)}>
              <option value="">Not specified / system issue</option>
              {users.data?.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
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
