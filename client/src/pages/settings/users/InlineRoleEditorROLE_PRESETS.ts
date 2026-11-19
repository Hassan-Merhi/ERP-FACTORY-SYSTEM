// Extracted from ./InlineRoleEditor.tsx to keep that module under the source-size cap.
import type { Company, UserCompanyRole } from "@shared/schema";

export const ROLE_OPTIONS = ["Admin", "Owner", "Manager", "POS", "Normal User", "View Only", "ERP Tester"];

/**
 * Create Only is offered only when the server reports it is activated for
 * assignment (or the assignment already holds it). The server refuses the
 * role while it is not activated, whatever this picker shows.
 */
export const CREATE_ONLY_ROLE = "Create Only";

export interface RolePreset {
  label: string;
  values: { daybookEditDays?: number; canSellNegativeStock?: boolean; canDeleteRecords?: boolean };
}

export const ROLE_PRESETS: Record<string, RolePreset[]> = {
  Manager: [
    { label: "No backdating", values: { daybookEditDays: 0, canSellNegativeStock: false, canDeleteRecords: false } },
    { label: "Standard", values: { daybookEditDays: 3, canSellNegativeStock: false, canDeleteRecords: true } },
    { label: "Power", values: { daybookEditDays: 30, canSellNegativeStock: true, canDeleteRecords: true } },
  ],
  Owner: [
    { label: "Standard", values: { daybookEditDays: 7 } },
    { label: "Unrestricted", values: { daybookEditDays: 365 } },
  ],
  "Normal User": [
    { label: "Today only", values: { daybookEditDays: 0 } },
    { label: "Standard", values: { daybookEditDays: 3 } },
  ],
  POS: [
    { label: "Standard Cashier", values: { daybookEditDays: 0, canSellNegativeStock: false } },
    { label: "Senior Cashier", values: { daybookEditDays: 1, canSellNegativeStock: true } },
  ],
};

export interface InlineRoleEditorProps {
  userId: string;
  companies: Company[];
  editingRole: UserCompanyRole | null;
  onClose: () => void;
  onSaved: () => void;
}
