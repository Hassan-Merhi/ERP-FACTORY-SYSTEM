"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { VisuallyHidden } from "@/components/ui/responsive-accessibility";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const ARROW_SCROLL_PX = 80;

function findScrollTarget(el: HTMLElement): HTMLElement | null {
  const ov = getComputedStyle(el).overflowY;
  if ((ov === "auto" || ov === "scroll") && el.scrollHeight > el.clientHeight) return el;
  for (const child of Array.from(el.children)) {
    const found = findScrollTarget(child as HTMLElement);
    if (found) return found;
  }
  return null;
}

const SKIP_ROLES = new Set(["option", "listbox", "combobox", "slider", "spinbutton", "textbox"]);

function shouldSkipArrow(active: Element | null): boolean {
  if (!active) return false;
  const tag = (active as HTMLElement).tagName.toLowerCase();
  if (["input", "textarea", "select"].includes(tag)) return true;
  if ((active as HTMLElement).getAttribute("contenteditable")) return true;
  return SKIP_ROLES.has(active.getAttribute("role") || "");
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onKeyDown, ...props }, ref) => {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !shouldSkipArrow(document.activeElement)) {
      const scrollEl = findScrollTarget(e.currentTarget);
      if (scrollEl) {
        e.preventDefault();
        e.stopPropagation();
        scrollEl.scrollBy({
          top: e.key === "ArrowDown" ? ARROW_SCROLL_PX : -ARROW_SCROLL_PX,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
      }
    }
    onKeyDown?.(e);
  };

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="dialog-content"
        onKeyDown={handleKeyDown}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(var(--app-viewport-height)-1rem)] w-[calc(100vw-1rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain border bg-background p-4 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-h-[calc(var(--app-viewport-height)-2rem)] sm:w-[calc(100vw-2rem)] sm:rounded-lg sm:p-6 motion-reduce:animate-none motion-reduce:transition-none",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          data-slot="dialog-close"
          aria-label="Close dialog"
          className="absolute right-2 top-2 flex min-h-10 min-w-10 items-center justify-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none motion-reduce:transition-none sm:right-4 sm:top-4"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          <VisuallyHidden>Close dialog</VisuallyHidden>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-header"
    className={cn("flex min-w-0 flex-col space-y-1.5 pr-8 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-body"
    data-dialog-body="true"
    className={cn("min-h-0 min-w-0 overflow-y-auto overscroll-contain", className)}
    {...props}
  />
);
DialogBody.displayName = "DialogBody";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="dialog-footer"
    className={cn(
      "flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end sm:border-t-0 sm:pt-0 *:min-h-11 *:w-full sm:*:w-auto",
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn("wrap-break-word text-lg font-semibold leading-snug tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn("wrap-break-word text-sm leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
