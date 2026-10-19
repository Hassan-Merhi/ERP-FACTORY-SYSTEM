/**
 * Edit factory customer-order shipping metadata directly from an Invoicing cell.
 * Saving uses the same canonical customer_orders write as the loading form.
 */
import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { EditableShippingField } from "./InvoiceOrderRow";

interface Props {
  orderId: number;
  field: EditableShippingField;
  value: string | null | undefined;
  multiline?: boolean;
  maxLength: number;
  onSave: (orderId: number, field: EditableShippingField, value: string) => Promise<void>;
}

export function EditableShippingCell({ orderId, field, value, multiline = false, maxLength, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDraft(value ?? "");
    setEditing(true);
  }

  function cancel() {
    if (!saving) setEditing(false);
  }

  async function save() {
    if (saving) return;
    const updated = draft.trim();
    if (updated === (value ?? "").trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(orderId, field, updated);
      setEditing(false);
    } catch {
      // The page displays the server error; keep draft open for correction.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="min-w-[100px] max-w-[220px]"
      onClick={(event) => event.stopPropagation()}
      onDragStart={(event) => event.stopPropagation()}
    >
      {editing ? (
        <div className="flex min-w-[180px] flex-col gap-1.5">
          {multiline ? (
            <Textarea
              autoFocus
              rows={3}
              value={draft}
              maxLength={maxLength}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  cancel();
                }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void save();
                }
              }}
              disabled={saving}
              className="min-h-[65px] text-xs"
              data-testid={`input-inline-${field}-${orderId}`}
            />
          ) : (
            <Input
              autoFocus
              value={draft}
              maxLength={maxLength}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                } else if (event.key === "Escape") {
                  event.stopPropagation();
                  cancel();
                }
              }}
              disabled={saving}
              className="h-8 text-xs"
              data-testid={`input-inline-${field}-${orderId}`}
            />
          )}
          <div className="flex justify-end gap-1">
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={saving}
              onClick={cancel} aria-label="Cancel edit" data-testid={`cancel-inline-${field}-${orderId}`}>
              <X className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon" className="h-7 w-7" disabled={saving}
              onClick={() => void save()} aria-label="Save changes" data-testid={`save-inline-${field}-${orderId}`}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          title={value || "Click to edit"}
          onClick={startEdit}
          className="group flex w-full min-h-7 items-center gap-1 text-left hover:text-foreground"
          aria-label={`Edit ${field}`}
          data-testid={`edit-inline-${field}-${orderId}`}
        >
          <span className="min-w-0 flex-1 truncate">
            {value || <span className="text-muted-foreground/50">—</span>}
          </span>
          <Pencil className="h-3 w-3 shrink-0 opacity-40 group-hover:opacity-100" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
