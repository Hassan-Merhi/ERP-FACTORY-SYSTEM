// Extracted from ./erp-mobile-records.tsx
import * as React from "react";
import { type LucideIcon } from "lucide-react";

export interface ErpMobileRecordField {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Spans both columns (long text such as descriptions and notes). */
  wide?: boolean;
  /** Keeps numbers left-to-right inside RTL cards. */
  numeric?: boolean;
  className?: string;
}

export interface ErpMobileRecordCardProps {
  title: React.ReactNode;
  /** Secondary line under the title (code, date, party). */
  subtitle?: React.ReactNode;
  /** Badges beside the subtitle (status, type). */
  badges?: React.ReactNode;
  /** Headline figure on the trailing side (amount, balance, quantity). */
  value?: React.ReactNode;
  valueClassName?: string;
  /** Primary fields, two per row. */
  fields?: ErpMobileRecordField[];
  /** Secondary fields behind a "More details" toggle. */
  details?: ErpMobileRecordField[];
  /** Editable controls or extra content rendered inside the card body. */
  children?: React.ReactNode;
  /** Row actions, shown in a footer row. */
  actions?: React.ReactNode;
  /** Opens the record (detail sheet, statement, voucher). Makes the card a button. */
  onOpen?: () => void;
  openLabel?: string;
  selected?: boolean;
  className?: string;
  "data-testid"?: string;
}

export interface ErpMobileRecordListProps extends React.HTMLAttributes<HTMLUListElement> {
  /** Shown instead of the list when there are no records. */
  empty?: React.ReactNode;
  isEmpty?: boolean;
}

export interface ErpMobileSummaryItem {
  label: React.ReactNode;
  value: React.ReactNode;
  valueClassName?: string;
  /** Spans both columns. */
  wide?: boolean;
}

export interface ErpMobileAction {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Starts a new group (separator above). */
  separated?: boolean;
  testId?: string;
}
