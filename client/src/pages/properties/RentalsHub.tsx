import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RentalModule } from "@/properties/config/rentalModulePolicy";
import {
  RENTAL_SECTIONS,
  RENTAL_SECTION_DEFINITIONS,
  rentalSectionHref,
  type RentalSection,
} from "@/properties/config/rentalSections";

type RentalsHubProps = {
  module: RentalModule;
  value: RentalSection;
  /** Sections this user may open; the active one is always shown. */
  sections?: readonly RentalSection[];
  onValueChange: (section: RentalSection) => void;
  /** Extra hub-level links shown at the end of the tab row. */
  tools?: ReactNode;
  children: ReactNode;
};

/**
 * The one Rentals hub frame for Properties, ERP and Factory: pill tabs for
 * Warehouses / Shops / Payments above the active section, which draws its own
 * PageHeader. The tab row is hidden when only one section is open to the user.
 */
export function RentalsHub({
  module,
  value,
  sections = RENTAL_SECTIONS,
  onValueChange,
  tools,
  children,
}: RentalsHubProps) {
  const prefix = module.toLowerCase();
  const visible = RENTAL_SECTIONS.filter((section) => section === value || sections.includes(section));
  const showTabs = visible.length > 1;
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as RentalSection)}
      className="space-y-4"
      data-testid={`${prefix}-rentals-hub`}
    >
      {(showTabs || tools) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {showTabs ? (
            <div className="erp-mobile-scroll-tabs w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain pb-1 sm:w-auto">
              <TabsList className="w-max min-w-full sm:w-fit sm:min-w-0" aria-label="Rental sections">
                {visible.map((section) => {
                  const { label, icon: Icon } = RENTAL_SECTION_DEFINITIONS[section];
                  return (
                    <TabsTrigger key={section} value={section} data-testid={`tab-${prefix}-rentals-${section}`}>
                      <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                      {label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>
          ) : (
            <span />
          )}
          {tools}
        </div>
      )}
      <TabsContent value={value} className="mt-0">
        {children}
      </TabsContent>
    </Tabs>
  );
}

/**
 * ERP and Factory: each section keeps its own route, so a tab click moves to
 * that route (and its existing route guard) instead of writing `?tab=`.
 */
export function RoutedRentalsHub({
  module,
  section,
  sections,
  children,
}: {
  module: Exclude<RentalModule, "PROPERTIES">;
  section: RentalSection;
  sections?: readonly RentalSection[];
  children: ReactNode;
}) {
  const [, navigate] = useLocation();
  return (
    <RentalsHub
      module={module}
      value={section}
      sections={sections}
      onValueChange={(next) => {
        if (next !== section) navigate(rentalSectionHref(module, next));
      }}
    >
      {children}
    </RentalsHub>
  );
}
