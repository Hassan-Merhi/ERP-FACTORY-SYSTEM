import type { ElementType, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** A titled card of label/value rows on the Profile tab of the worker and employee detail pages. */
export function PersonInfoCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: ElementType;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {Icon && <Icon className="h-3.5 w-3.5" />}
          <span>{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">{children}</CardContent>
    </Card>
  );
}

export function PersonInfoRow({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="flex justify-between border-b py-1.5 text-sm last:border-0">
      <span className="mr-3 shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium" data-testid={testId}>
        {value === null || value === undefined || value === "" ? "—" : value}
      </span>
    </div>
  );
}
