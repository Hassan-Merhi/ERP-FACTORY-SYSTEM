/**
 * Types for the FactoryShippingContainers page.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */

import {SHIPPING_COLS} from "./utils";

export interface ShippingRow {
  id: number;
  companyId: number;
  customerOrderId: number;
  orderDate: string;
  eta: string | null;
  containerArrivedDate: string | null;
  note: string | null;
  ciNumber: string | null;
  isDone: boolean;
  doneAt: string | null;
  doneBy: string | null;
  whatsappSentAt: string | null;
  createdAt: string;
  // Live from customer_orders join
  invoiceNumber: string;
  customerId: number | null;
  clientName: string | null;
  customerPhone: string | null;
  status: string;
  loadingDate: string | null;
  finalizedDate: string | null;
  containerNumber: string | null;
  shippingCompany: string | null;
  destination: string | null;
  documentCount: number;
  shippingInvoiceFileUrl: string | null;
  shippingInvoiceOriginalName: string | null;
  shippingInvoiceFileType: string | null;
  trackingLink: string | null;
  grandTotal: string | null;
}

export interface TrackingRow {
  containerNumber: string | null;
  eta: string | null;
  grandTotal: string | null;
}

export type DisplayRow = ShippingRow & { _isGhost: boolean; _trackedEta: string | null };

export interface ShippingDocument {
  isGhost?: boolean;
  id: number;
  scrId: number;
  displayName: string;
  fileName: string;
  originalName: string;
  fileUrl: string;
  fileType: string | null;
  fileSize: number | null;
  uploadedBy: string | null;
  uploadedAt: string;
}

export interface WaFile {
  id: string;
  name: string;
  fileType: string;
  source: string;
  available: boolean;
  unavailableReason?: string;
  fileUrl?: string;
}

export interface WhatsAppPreview {
  row: {
    id: number;
    customerOrderId: number;
    invoiceNumber: string | null;
    customerId: number | null;
    clientName: string | null;
    customerPhone: string | null;
    containerNumber: string | null;
    shippingCompany: string | null;
    destination: string | null;
  };
  files: WaFile[];
  defaultMessage: string;
  whatsappContact: string | null;
}

export type ShippingColId = (typeof SHIPPING_COLS)[number]["id"];

export interface WaFileWithChecked extends WaFile {
  checked: boolean;
}

export interface AvailRow {
  id: number;
  date: string;
  shippingCompany: string;
  availableContainers: number;
  note: string | null;
  isArchived: boolean;
  archivedAt: string | null;
}

export interface EditingAvail {
  id: number;
  date: string;
  shippingCompany: string;
  availableContainers: string;
  note: string;
}
