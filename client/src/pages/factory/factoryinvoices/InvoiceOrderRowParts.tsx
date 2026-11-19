// Extracted from ./InvoiceOrderRow.tsx
import type { DragEvent, ReactNode } from "react";
import type { CustomerOrder } from "./types";

export type EditableShippingField = "containerNumber" | "bookingInfo" | "destination" | "containerNotes";

export type InvoiceColumnKey =
  | "loading"
  | "proforma"
  | "container"
  | "bookingInfo"
  | "destination"
  | "notes"
  | "date"
  | "status"
  | "bales"
  | "weight"
  | "remaining"
  | "extras"
  | "total";

/** Weight cell formatting shared by the order row and the customer group row. */
export function fmtKg(val: string | number | null | undefined) {
  const n = parseFloat(String(val ?? "0"));
  if (!n) return <span className="text-muted-foreground/40">—</span>;
  return <>{n.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</>;
}

/** Page-level callbacks shared by every order row (and the group rows). */
export interface InvoiceOrderRowContext {
  isColumnVisible: (key: InvoiceColumnKey) => boolean;
  formatDisplayDate: (date: string) => string;
  getStatusBadge: (status: string) => ReactNode;
  onRowClick: (order: CustomerOrder) => void;
  onToggleHideOrder: (order: CustomerOrder) => void;
  onDownload: (url: string, fallbackName: string) => void;
  isAdmin: boolean;
  unfinalizePending: boolean;
  onRevertOrder: (orderId: number) => void;
  onDeleteOrder: (orderId: number) => void;
  onChangeCustomer: (orderId: number) => void;
  onSaveShippingField: (orderId: number, field: EditableShippingField, value: string) => Promise<void>;
}

export interface InvoiceOrderRowProps extends InvoiceOrderRowContext {
  order: CustomerOrder;
  indented: boolean;
  isDropTarget: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}
