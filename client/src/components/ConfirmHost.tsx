/**
 * App-wide replacement for the browser's blocking window.confirm/prompt.
 *
 * Mount <ConfirmHost /> once (App.tsx). Anywhere in the client:
 *
 *   if (await confirmAction({ title: "Delete this link?", tone: "destructive" })) ...
 *   const reason = await promptText({ title: "Reason", minLength: 5 });
 *
 * Requests are queued and shown one at a time in the app's own dialog, so they
 * follow the theme, RTL layout and translations, and do not freeze the page.
 * When no host is mounted (isolated component tests), confirmAction resolves
 * false and promptText resolves null, the same as cancelling.
 */
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmDialogTone } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ConfirmActionOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmDialogTone;
  /** The user must type this phrase exactly before confirming. */
  requirePhrase?: string;
}

export interface PromptTextOptions {
  title: string;
  description?: string;
  label: string;
  confirmText?: string;
  cancelText?: string;
  /** Minimum length of the trimmed answer. */
  minLength?: number;
}

type HostRequest =
  | { id: number; kind: "confirm"; options: ConfirmActionOptions; resolve: (value: boolean) => void }
  | { id: number; kind: "prompt"; options: PromptTextOptions; resolve: (value: string | null) => void };

let enqueue: ((request: HostRequest) => void) | null = null;
let nextRequestId = 1;

export function confirmAction(options: ConfirmActionOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(false);
      return;
    }
    enqueue({ id: nextRequestId++, kind: "confirm", options, resolve });
  });
}

export function promptText(options: PromptTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(null);
      return;
    }
    enqueue({ id: nextRequestId++, kind: "prompt", options, resolve });
  });
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<HostRequest[]>([]);
  const [answer, setAnswer] = useState("");
  // ConfirmDialog closes itself after onConfirm, which also fires onOpenChange;
  // settle each request once so that close does not dismiss the next one.
  const settled = useRef<HostRequest | null>(null);

  useEffect(() => {
    const push = (request: HostRequest) => setQueue((current) => [...current, request]);
    enqueue = push;
    return () => {
      if (enqueue === push) enqueue = null;
    };
  }, []);

  const current = queue[0];
  useEffect(() => setAnswer(""), [current]);

  if (!current) return null;

  const finish = (confirmed: boolean) => {
    if (settled.current === current) return;
    settled.current = current;
    if (current.kind === "confirm") current.resolve(confirmed);
    else current.resolve(confirmed ? answer.trim() : null);
    setQueue((pending) => pending.slice(1));
  };

  if (current.kind === "confirm") {
    const { options } = current;
    return (
      <ConfirmDialog
        key={current.id}
        open
        onOpenChange={(open) => !open && finish(false)}
        title={options.title}
        description={options.description}
        confirmText={options.confirmText}
        cancelText={options.cancelText}
        tone={options.tone}
        requirePhrase={options.requirePhrase}
        onConfirm={() => finish(true)}
        data-testid="dialog-confirm-action"
      />
    );
  }

  const { options } = current;
  const tooShort = answer.trim().length < (options.minLength ?? 1);
  return (
    <ConfirmDialog
      key={current.id}
      open
      onOpenChange={(open) => !open && finish(false)}
      title={options.title}
      description={options.description}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      confirmDisabled={tooShort}
      onConfirm={() => finish(true)}
      data-testid="dialog-prompt-text"
    >
      <div className="space-y-2">
        <Label htmlFor="prompt-text-input">{options.label}</Label>
        <Input
          id="prompt-text-input"
          autoFocus
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          data-testid="input-prompt-text"
        />
      </div>
    </ConfirmDialog>
  );
}
