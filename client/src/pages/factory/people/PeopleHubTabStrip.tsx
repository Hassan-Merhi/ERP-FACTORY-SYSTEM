import type { ElementType } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface PeopleHubTab<T extends string> {
  value: T;
  label: string;
  icon: ElementType;
}

/**
 * The tab strip of the Workers and Employees sections of the Payroll hub.
 * Default tab styling, scrolls sideways on phones. Access filtering stays in
 * each hub.
 */
export function PeopleHubTabStrip<T extends string>({
  tabs,
  ariaLabel,
  testIdPrefix,
}: {
  tabs: readonly PeopleHubTab<T>[];
  ariaLabel: string;
  /** "workers" → `tabs-workers-section`, `tab-workers-<value>`. */
  testIdPrefix: string;
}) {
  return (
    <div className="erp-mobile-scroll-tabs mb-4 pb-1">
      <TabsList
        className="w-max min-w-full sm:min-w-0 sm:w-fit"
        aria-label={ariaLabel}
        data-testid={`tabs-${testIdPrefix}-section`}
      >
        {tabs.map(({ value, label, icon: ItemIcon }) => (
          <TabsTrigger key={value} value={value} data-testid={`tab-${testIdPrefix}-${value}`}>
            <ItemIcon className="h-4 w-4 shrink-0" />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
