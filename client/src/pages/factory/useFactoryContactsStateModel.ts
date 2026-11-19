// Extracted from ./useFactoryContactsState.tsx
import type { TableColumnOption } from "@/components/TableViewOptions";

interface PhoneEntry {
  label: string;
  number: string;
}

export interface Contact {
  id: number;
  companyId: number;
  name: string;
  role: string | null;
  numbers: PhoneEntry[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export const EMPTY_FORM = {
  name: "",
  role: "",
  numbers: [{ label: "Mobile", number: "" }] as PhoneEntry[],
  notes: "",
};

export const CONTACT_COLUMNS: TableColumnOption[] = [
  { key: "name", label: "Name", required: true },
  { key: "role", label: "Role" },
  { key: "phones", label: "Phone Numbers", required: true },
  { key: "notes", label: "Notes" },
  { key: "actions", label: "Actions", required: true },
];

export type ContactFilter = "all" | "has-phone" | "has-notes" | "missing-phone" | "missing-notes";
