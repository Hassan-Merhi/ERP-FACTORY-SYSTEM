import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Download, Plus, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ContainerToolbarProps {
  onExportExcel: () => void;
  onExportAllFull: () => void;
  propertiesMode?: boolean;
}

export function ContainerToolbar({ onExportExcel, onExportAllFull, propertiesMode = false }: ContainerToolbarProps) {
  return (
    <div className="flex w-full flex-wrap gap-2 *:flex-auto sm:w-auto sm:*:flex-none">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2" data-testid="button-export-dropdown">
            <Download className="h-4 w-4" />
            Export
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onExportExcel} data-testid="button-export-excel">
            <Download className="h-4 w-4 mr-2" />
            Export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onExportAllFull} data-testid="button-export-all-full">
            <Download className="h-4 w-4 mr-2" />
            Export All (Full)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {propertiesMode && (
        <Link href="/properties/po-import">
          <Button className="gap-2" data-testid="button-add-container">
            <Plus className="h-4 w-4" />
            Import PO
          </Button>
        </Link>
      )}

      {!propertiesMode && (
        <>
          <Link href="/po-import">
            <Button className="gap-2" data-testid="button-add-container">
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </Link>
        </>
      )}
    </div>
  );
}
