/** Read-only navigation hub; individual destinations retain their original authorization and behavior. */
import { Link, useLocation } from "wouter";
import { ArrowUpRight, ClipboardList, FileText, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccountingToolLinks, getDeveloperMaintenanceLinks, type AccountingToolboxMode, type AccountingToolCategory } from "@/lib/accountingToolboxNavigation";

const groups: Array<{ title: AccountingToolCategory; icon: typeof ClipboardList }> = [
  { title: "Reconciliation", icon: ClipboardList },
  { title: "Reporting & history", icon: FileText },
  { title: "Release & audit", icon: ShieldCheck },
  { title: "Diagnostics & maintenance", icon: ClipboardList },
];

export default function AccountingToolbox() {
  const [path] = useLocation();
  const mode: AccountingToolboxMode = path.startsWith("/factory/") ? "factory" :
    path.startsWith("/properties/") ? "properties" : "erp";
  const links = [...getAccountingToolLinks(mode), ...getDeveloperMaintenanceLinks(mode)];
  return (
    <main className="container mx-auto max-w-6xl space-y-6 p-4 md:p-6" data-testid="accounting-toolbox">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Accounting Toolbox</h1>
        <p className="text-sm text-muted-foreground">
          Developer reconciliation, financial reporting, and release review tools.
          These links open the existing pages; no records or calculations are changed here.
          Some maintenance destinations can modify records if actions are explicitly submitted.
        </p>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map(({ title, icon: Icon }) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Icon className="h-4 w-4" />{title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {links.filter((item) => item.category === title).map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  className="flex items-center justify-between gap-3 rounded-md border p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`accounting-tool-${item.path.replace(/[^a-z0-9]/gi, "-")}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className="block text-xs text-muted-foreground">{item.description}</span>
                  </span>
                  <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                </Link>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
