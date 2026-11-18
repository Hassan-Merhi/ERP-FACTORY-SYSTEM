// Extracted from ./TicketManagement.tsx to keep that module under the source-size cap.
import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { uploadInitialTicketEvidence } from "@/pages/tickets/TicketConversation";

export type Ticket = {
  id: number;
  ticketNumber: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  sourceMode: string;
  assignedTo: string;
  createdBy: string;
  createdAt: string;
  dueAt: string;
  description: string;
};

export type User = { id: string; username: string };

type Voucher = { id: number; reference: string; type: string };

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok)
    throw new Error(response.status === 403 ? "You do not have ticket access." : "Unable to load ticket information.");
  return response.json() as Promise<T>;
}

export const ticketKey = (companyId: number | undefined) => ["tickets", companyId];

export const priorities = ["low", "normal", "high", "urgent"] as const;

export const categories = [
  "Voucher Error",
  "Stock Discrepancy",
  "Production Error",
  "Attendance Issue",
  "Invoice / Loading Error",
  "Other",
];

export const inputStyle = "w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm";

export function useTicketFormState({
  onCreated,
  onCancel,
  sourceMode,
}: {
  onCreated: (id: number, warning?: string) => void;
  onCancel: () => void;
  sourceMode: "erp" | "factory";
}) {
  const { selectedCompany } = useCompany();
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(categories[0]);
  const [priority, setPriority] = useState<(typeof priorities)[number]>("normal");
  const [assignedTo, setAssignedTo] = useState("");
  const [reportedUserId, setReportedUserId] = useState("");
  const [voucherQ, setVoucherQ] = useState("");
  const [voucherId, setVoucherId] = useState<number | undefined>();
  const [voucherLabel, setVoucherLabel] = useState("");
  const [error, setError] = useState("");
  const [initialEvidence, setInitialEvidence] = useState<File | null>(null);
  const users = useQuery({
    queryKey: ["ticket-users", selectedCompany?.id],
    queryFn: () => fetchJson<{ users: User[] }>("/api/tickets/users"),
    enabled: !!selectedCompany?.id,
  });
  const vouchers = useQuery({
    queryKey: ["ticket-voucher-search", selectedCompany?.id, voucherQ],
    queryFn: () => fetchJson<{ records: Voucher[] }>(`/api/tickets/voucher-search?q=${encodeURIComponent(voucherQ)}`),
    enabled: !!selectedCompany?.id && voucherQ.trim().length >= 2 && !voucherId,
  });
  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/tickets", {
        title,
        description,
        category,
        priority,
        assignedTo,
        sourceMode,
        ...(reportedUserId ? { reportedUserId } : {}),
        ...(voucherId ? { voucherId } : {}),
      });
      return res.json() as Promise<{ ticket: Ticket }>;
    },
    onSuccess: async ({ ticket }) => {
      let warning: string | undefined;
      if (initialEvidence) {
        try {
          await uploadInitialTicketEvidence(ticket.id, initialEvidence);
        } catch (err) {
          warning = "Ticket saved, but photo upload failed: " + (err instanceof Error ? err.message : "Unknown error");
        }
      }
      await client.invalidateQueries({ queryKey: ticketKey(selectedCompany?.id) });
      onCreated(ticket.id, warning);
    },
    onError: (err: Error) => setError(err.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!assignedTo) return setError("Select an employee.");
    create.mutate();
  };
  return {
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
  };
}
