import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];

function requireText(relativePath, text) {
  const contents = read(relativePath);
  if (!contents.includes(text)) failures.push(`${relativePath}: missing ${text}`);
  return contents;
}

const layout = read("client/src/components/ui/workspace-layout.tsx");
for (const primitive of [
  "WorkspacePage",
  "WorkspaceSection",
  "WorkspaceSectionHeader",
  "WorkspaceToolbar",
  "WorkspaceToolbarGroup",
  "WorkspaceActions",
  "ResponsiveTableFrame",
  "FormActionBar",
]) {
  if (!layout.includes(`function ${primitive}`)) {
    failures.push(`client/src/components/ui/workspace-layout.tsx: missing ${primitive}`);
  }
}
for (const invariant of [
  'role="region"',
  "tabIndex={0}",
  "overflow-x-auto",
  "overscroll-x-contain",
  "flex-col-reverse",
  "sticky bottom-0",
]) {
  if (!layout.includes(invariant)) failures.push(`workspace layout missing ${invariant}`);
}

const header = read("client/src/components/PageHeader.tsx");
for (const invariant of [
  "<header",
  '<nav className=',
  'aria-label="Page navigation"',
  'aria-label="Previous record"',
  'aria-label="Next record"',
  "WorkspaceActions",
  "wrap-break-word",
  "leading-5",
]) {
  if (!header.includes(invariant)) failures.push(`PageHeader missing ${invariant}`);
}
if (header.includes('data-testid="text-page-subtitle" className="mt-1 text-muted-foreground text-sm truncate"')) {
  failures.push("PageHeader still truncates subtitles");
}

const states = read("client/src/components/ui/page-state.tsx");
for (const invariant of [
  "actionPending?: boolean",
  "actionDisabled?: boolean",
  "secondaryActionLabel?: string",
  "onSecondaryAction?: () => void",
  'aria-busy={actionPending}',
  "WorkspaceActions",
  "motion-reduce:animate-none",
  "leading-5",
]) {
  if (!states.includes(invariant)) failures.push(`page-state missing ${invariant}`);
}

requireText("tests/ui/phase10-ui-consistency.test.ts", "Phase 10 UI consistency contracts");

const docs = read("docs/archive/engineering/phase10-ui-consistency.md").toLowerCase();
for (const phrase of [
  "workspace layout primitives",
  "page header consistency",
  "page state consistency",
  "responsive table behavior",
  "form action behavior",
  "compatibility boundary",
  "verification boundary",
  "merge boundary",
]) {
  if (!docs.includes(phrase)) failures.push(`phase10 documentation missing ${phrase}`);
}

if (failures.length) {
  console.error("Phase 10 UI consistency verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Phase 10 UI consistency contracts verified.");
