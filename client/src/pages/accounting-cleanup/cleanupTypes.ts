import type { ComponentType } from "react";

import type { PlanRecord } from "./cleanupPlanView";

export type CleanupMode = "erp" | "factory";
export type ToolOptions = Record<string, unknown>;

export interface ToolOptionsProps {
  options: ToolOptions;
  setOption: (key: string, value: unknown) => void;
  plan: PlanRecord | null;
  disabled: boolean;
}

/** One reviewed Owner tool: preview (GET plan) → Apply ({ confirm: true, planHash, … }). */
export interface CleanupTool {
  key: string;
  title: string;
  description: string;
  /** Roles the plan route admits (Developer passes every role check on the server). */
  previewRoles: readonly string[];
  applyRoles: readonly string[];
  /** The plan URL for these options, or null while a required input is missing. */
  planUrl: (options: ToolOptions) => string | null;
  /** Omitted for a read-only plan (the card only previews). */
  applyUrl?: string;
  /** Extra apply body fields (merged after { confirm: true, planHash }). */
  applyBody?: (plan: PlanRecord, options: ToolOptions) => ToolOptions;
  /** False for the one tool whose route takes no plan hash (system accounts). */
  sendsPlanHash?: boolean;
  /** A confirmed action with no plan: Apply posts only { confirm: true }. */
  actionOnly?: boolean;
  isEmpty?: (plan: PlanRecord) => boolean;
  isApplied?: (plan: PlanRecord) => boolean;
  /** Blockers the page knows before the server does (a choice still to make). */
  clientBlockers?: (plan: PlanRecord, options: ToolOptions) => string[];
  defaultOptions?: ToolOptions;
  Options?: ComponentType<ToolOptionsProps>;
  /** Plan fields not rendered (large internals). */
  omit?: string[];
  /** Shown under the buttons when planUrl returns null. */
  inputHint?: string;
  /** Shown under the buttons for roles that can preview but not apply. */
  applyRoleHint?: string;
  modes?: readonly CleanupMode[];
  /** Plain words for this tool's blocker codes (the server's own messages). */
  blockerText?: Record<string, string>;
}

export interface StepExtraProps {
  mode: CleanupMode;
  role: string;
  modePrefix: string;
}

export interface CleanupStep {
  step: number;
  key: string;
  title: string;
  explanation: string;
  never: string;
  perCompany: boolean;
  tools: CleanupTool[];
  modes?: readonly CleanupMode[];
  /** Content shown before the tools (a link, an embedded card). */
  Extra?: ComponentType<StepExtraProps>;
}
