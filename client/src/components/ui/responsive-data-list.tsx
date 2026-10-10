import * as React from "react";

import { cn } from "@/lib/utils";

const ResponsiveDataList = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
  ({ className, ...props }, ref) => (
    <ul ref={ref} data-mobile-data-list="true" className={cn("grid min-w-0 gap-3", className)} {...props} />
  )
);
ResponsiveDataList.displayName = "ResponsiveDataList";

const ResponsiveDataListItem = React.forwardRef<HTMLLIElement, React.HTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li
      ref={ref}
      className={cn("min-w-0 rounded-lg border bg-card p-3 text-card-foreground shadow-xs sm:p-4", className)}
      {...props}
    />
  )
);
ResponsiveDataListItem.displayName = "ResponsiveDataListItem";

const ResponsiveDataListHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between", className)}
      {...props}
    />
  )
);
ResponsiveDataListHeader.displayName = "ResponsiveDataListHeader";

const ResponsiveDataListTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("min-w-0 wrap-break-word text-sm font-semibold leading-snug", className)} {...props} />
  )
);
ResponsiveDataListTitle.displayName = "ResponsiveDataListTitle";

const ResponsiveDataListDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("min-w-0 wrap-break-word text-xs leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
ResponsiveDataListDescription.displayName = "ResponsiveDataListDescription";

const ResponsiveDataListFields = React.forwardRef<HTMLDListElement, React.HTMLAttributes<HTMLDListElement>>(
  ({ className, ...props }, ref) => (
    <dl
      ref={ref}
      className={cn(
        "mt-3 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 border-t pt-3 min-[420px]:grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]",
        className
      )}
      {...props}
    />
  )
);
ResponsiveDataListFields.displayName = "ResponsiveDataListFields";

type ResponsiveDataListFieldProps = React.HTMLAttributes<HTMLDivElement> & {
  label: React.ReactNode;
  value?: React.ReactNode;
};

const ResponsiveDataListField = React.forwardRef<HTMLDivElement, ResponsiveDataListFieldProps>(
  ({ className, label, value, children, ...props }, ref) => (
    <div ref={ref} className={cn("min-w-0", className)} {...props}>
      <dt className="wrap-break-word text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 wrap-break-word text-sm text-foreground">{children ?? value ?? "—"}</dd>
    </div>
  )
);
ResponsiveDataListField.displayName = "ResponsiveDataListField";

const ResponsiveDataListActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="group"
      aria-label="Row actions"
      className={cn(
        "mt-3 grid grid-cols-1 gap-2 border-t pt-3 min-[360px]:grid-cols-2 sm:flex sm:flex-wrap sm:justify-end *:min-h-11 *:w-full sm:*:min-h-9 sm:*:w-auto",
        className
      )}
      {...props}
    />
  )
);
ResponsiveDataListActions.displayName = "ResponsiveDataListActions";

const ResponsiveDataListEmpty = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="status"
      className={cn(
        "rounded-lg border border-dashed p-6 text-center text-sm leading-relaxed text-muted-foreground",
        className
      )}
      {...props}
    />
  )
);
ResponsiveDataListEmpty.displayName = "ResponsiveDataListEmpty";

export {
  ResponsiveDataList,
  ResponsiveDataListActions,
  ResponsiveDataListDescription,
  ResponsiveDataListEmpty,
  ResponsiveDataListField,
  ResponsiveDataListFields,
  ResponsiveDataListHeader,
  ResponsiveDataListItem,
  ResponsiveDataListTitle,
};
