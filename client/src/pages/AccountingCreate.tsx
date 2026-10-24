import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MapPin, BookOpen, Users, Truck, FolderTree, Package } from "lucide-react";

import type { EntityType, SidebarGroup } from "./accountingcreate/types";
import { entityConfig } from "./accountingcreate/utils";
import { EntityFormWrapper } from "./accountingcreate/components/EntityFormWrapper";
export default function AccountingCreate() {
  const [selectedEntity, setSelectedEntity] = useState<EntityType>("location");
  const config = entityConfig[selectedEntity];

  const sidebarGroups: SidebarGroup[] = [
    {
      label: "Accounts",
      items: [
        { key: "location", label: "Location", icon: MapPin },
        { key: "ledger", label: "Ledger", icon: BookOpen },
        { key: "employee", label: "Employee", icon: Users },
        { key: "supplier", label: "Supplier", icon: Truck },
      ],
    },
    {
      label: "Inventory",
      items: [
        { key: "stockGroup", label: "Stock Group", icon: FolderTree },
        { key: "stockItem", label: "Stock Item", icon: Package },
      ],
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <PageHeader title="Create Master Data" />
      <p className="text-sm text-muted-foreground">Set up accounts, people, locations, and inventory for your selected company. Choose what to create below.</p>

      {/* Mobile entity selector */}
      <div className="md:hidden">
        <Select value={selectedEntity} onValueChange={(v) => setSelectedEntity(v as EntityType)}>
          <SelectTrigger className="w-full" data-testid="select-entity-mobile">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sidebarGroups.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SelectItem key={item.key} value={item.key}>
                      <span className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        {item.label}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <nav className="hidden md:block w-56 shrink-0 space-y-6 rounded-2xl border border-border/70 bg-card/70 p-3" aria-label="Master data types">
          {sidebarGroups.map((group) => (
            <div key={group.label}>
              <h3 className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </h3>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = selectedEntity === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => setSelectedEntity(item.key)}
                      data-testid={`tab-${item.key === "stockGroup" ? "stock-group" : item.key === "stockItem" ? "stock-item" : item.key}`}
                      className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                        isActive
                          ? "border-primary/30 bg-primary/10 font-semibold text-primary shadow-sm"
                          : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
          <EntityFormWrapper
            key={selectedEntity}
            entityType={selectedEntity}
            config={config}
          />
        </div>
      </div>
    </div>
  );
}
