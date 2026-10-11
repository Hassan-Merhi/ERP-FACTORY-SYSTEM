#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const workflowDialog = await read("client/src/components/ui/workflow-dialog.tsx");
const confirmDialog = await read("client/src/components/ConfirmDialog.tsx");
const confirmationShim = await read("client/src/components/ConfirmationDialog.tsx");
const dialog = await read("client/src/components/ui/dialog.tsx");
const alertDialog = await read("client/src/components/ui/alert-dialog.tsx");
const sheet = await read("client/src/components/ui/sheet.tsx");
const form = await read("client/src/components/ui/form.tsx");
const select = await read("client/src/components/ui/select.tsx");
const failures = [];

for (const token of [
  "WorkflowDialog",
  "WorkflowDialogTone",
  "DialogHeader",
  "DialogTitle",
  "DialogDescription",
  "DialogBody",
  "DialogFooter",
  'tone === "destructive" ? "destructive"',
  "max-h-[calc(var(--app-viewport-height)-1rem)]",
  "wrap-break-word",
  'aria-busy={isPending ? "true"',
  "motion-reduce:animate-none",
  "disableConfirm || isPending",
  'type="button"',
]) {
  if (!workflowDialog.includes(token)) failures.push(`Workflow dialog contract missing: ${token}`);
}

for (const token of [
  "ConfirmDialog",
  "doubleConfirm",
  "requirePhrase",
  "confirmDisabled",
  "max-h-[calc(100dvh-1rem)]",
  "overflow-y-auto",
  "wrap-break-word",
  'aria-busy={isLoading ? "true"',
  "motion-reduce:animate-none",
  "w-full sm:w-auto",
  "bg-destructive",
  "bg-warning",
  "disabled={isLoading}",
]) {
  if (!confirmDialog.includes(token)) failures.push(`Canonical confirmation contract missing: ${token}`);
}

for (const token of ["ConfirmDialog", "DeleteConfirmDialog", 'tone="destructive"']) {
  if (!confirmationShim.includes(token)) failures.push(`Confirmation compatibility contract missing: ${token}`);
}

for (const token of [
  "DialogContent",
  "DialogBody",
  "data-dialog-body",
  "var(--app-viewport-height)",
  "focus-visible",
  "*:min-h-11",
]) {
  if (!dialog.includes(token)) failures.push(`Base dialog contract missing: ${token}`);
}

for (const token of [
  "w-[calc(100vw-1rem)]",
  "var(--app-viewport-height)",
  "overflow-y-auto overscroll-contain",
  "*:min-h-11",
  "motion-reduce:animate-none",
]) {
  if (!alertDialog.includes(token)) failures.push(`Alert dialog contract missing: ${token}`);
}

for (const token of [
  "h-(--app-viewport-height)",
  "w-[calc(100vw-0.75rem)]",
  'aria-label="Close panel"',
  "min-h-11 min-w-11",
  "*:min-h-11",
  "motion-reduce:animate-none",
]) {
  if (!sheet.includes(token)) failures.push(`Sheet contract missing: ${token}`);
}

for (const token of [
  "FormField",
  "FormGrid",
  "FormSection",
  "FormSectionLegend",
  "FormLabel",
  "FormControl",
  "FormMessage",
  "repeat(auto-fit, minmax(min(100%",
  "scroll-mt-24",
  "aria-errormessage",
]) {
  if (!form.includes(token)) failures.push(`Form consistency contract missing: ${token}`);
}

for (const token of [
  "h-11",
  "sm:h-9",
  "max-w-[calc(100vw-1rem)]",
  "min-h-11",
  "overscroll-contain",
]) {
  if (!select.includes(token)) failures.push(`Select consistency contract missing: ${token}`);
}

for (const source of [workflowDialog, confirmDialog, dialog, alertDialog, sheet, form, select]) {
  for (const forbidden of [
    "/api/",
    "useMutation(",
    "useQuery(",
    "queryClient",
    "stockQuantity",
    "saleTotal",
    "costPerKg",
    "ledgerAccount",
  ]) {
    if (source.includes(forbidden)) failures.push(`Dialog or form primitive contains business logic: ${forbidden}`);
  }
}

if (failures.length) {
  console.error("Phase 10 dialog and form consistency verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({ phase: 10, status: "complete", protectedContracts: 65 }, null, 2));
