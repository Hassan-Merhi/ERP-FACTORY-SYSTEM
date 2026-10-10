import { useState } from "react";
import { useLocation } from "wouter";
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
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { MapPin, BookOpen, Users, Truck, FolderTree, Package } from "lucide-react";
import {} from "@shared/schema";

import type { EntityType, SidebarGroup } from "./accountingcreate/types";
import { entityConfig } from "./accountingcreate/utils";
import { EntityFormWrapper } from "./accountingcreate/components/EntityFormWrapper";
export default function AccountingCreate() {
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);
  const [, navigate] = useLocation();
  const [selectedEntity, setSelectedEntity] = useState<EntityType>("location");
  const isFactory = appMode === "factory";
  const handleCreated = () => navigate(isFactory ? "/factory/accounts" : "/accounting");
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
    <div className="space-y-4">
      <PageHeader title="Create Master Data" />

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

      <div className="flex gap-6">
        <nav className="hidden md:block w-56 shrink-0 space-y-4">
          {sidebarGroups.map((group) => (
            <div key={group.label}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-3">
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
                      className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
                        isActive
                          ? "bg-background shadow-xs font-medium"
                          : "text-muted-foreground hover:text-foreground hover:bg-background/50"
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
            onCreated={handleCreated}
          />
        </div>
      </div>
    </div>
  );
}
