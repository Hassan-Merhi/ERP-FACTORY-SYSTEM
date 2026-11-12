import { Link2, Link2Off } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Per-cell link menu. Read-only viewers only get "Jump to source page"; the
 * link/unlink/copy actions only change the local sheet (saved by the page).
 */
export function StatusCellLinkMenu({
  rowIdx,
  colIdx,
  isLinked,
  isBroken,
  linkInfo,
  canEdit,
  sourceSheetIdx,
  onJumpToSource,
  onOpenLinkDialog,
  onUnlink,
  onCopyAsManual,
}: {
  rowIdx: number;
  colIdx: number;
  isLinked: boolean;
  /** True when the link is broken or circular. */
  isBroken: boolean;
  linkInfo: string | null;
  canEdit: boolean;
  sourceSheetIdx: number;
  onJumpToSource: (sheetIdx: number) => void;
  onOpenLinkDialog: () => void;
  onUnlink: () => void;
  onCopyAsManual: () => void;
}) {
  return (
    <div
      className={`absolute top-0.5 right-0.5 z-10 transition-opacity ${isLinked ? "opacity-100" : "opacity-0 group-hover/cell:opacity-100"}`}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="p-0.5 rounded-sm hover:bg-muted/60"
            onClick={(e) => e.stopPropagation()}
            data-testid={`sb-button-cell-menu-${rowIdx}-${colIdx}`}
            title={isLinked ? `Linked from: ${linkInfo ?? "…"}` : "Link this cell"}
          >
            {isBroken ? (
              <Link2Off className="h-2.5 w-2.5 text-red-400" />
            ) : isLinked ? (
              <Link2 className="h-2.5 w-2.5 text-blue-400" />
            ) : (
              <Link2 className="h-2.5 w-2.5 text-muted-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs min-w-[160px]">
          {isLinked && linkInfo && (
            <>
              <div className="px-2 py-1.5 text-xs text-muted-foreground max-w-[200px] leading-tight">{linkInfo}</div>
              <DropdownMenuSeparator />
            </>
          )}
          {!canEdit ? (
            sourceSheetIdx !== -1 && (
              <DropdownMenuItem onClick={() => onJumpToSource(sourceSheetIdx)} className="text-xs gap-2">
                Jump to source page
              </DropdownMenuItem>
            )
          ) : !isLinked ? (
            <DropdownMenuItem onClick={onOpenLinkDialog} className="text-xs gap-2">
              <Link2 className="h-3 w-3" />
              Link cell
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={onOpenLinkDialog} className="text-xs gap-2">
                <Link2 className="h-3 w-3" />
                Change link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onUnlink} className="text-xs gap-2">
                <Link2Off className="h-3 w-3" />
                Remove link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCopyAsManual} className="text-xs gap-2">
                Copy value as manual
              </DropdownMenuItem>
              {sourceSheetIdx !== -1 && (
                <DropdownMenuItem onClick={() => onJumpToSource(sourceSheetIdx)} className="text-xs gap-2">
                  Jump to source page
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
