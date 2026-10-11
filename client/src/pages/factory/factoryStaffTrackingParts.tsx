import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FACTORY_TRACKING_STATUSES } from "@/i18n/factoryStaffTrackingTranslations";

export type TrackingMode = "production" | "attendance";
export type PeriodType = "daily" | "weekly" | "monthly";
export type TrackingStatus = (typeof FACTORY_TRACKING_STATUSES)[keyof typeof FACTORY_TRACKING_STATUSES];
export type PersonType = "worker" | "employee";

export interface TrackingRow {
  personType: PersonType;
  personId: number;
  name: string;
  code: string | null;
  groupName?: string;
  category: string;
  targetBales: number | null;
  producedBales: number | null;
  status: TrackingStatus;
  notes: string;
  active: boolean;
}

export interface TrackingResponse {
  page: TrackingMode;
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  rows: TrackingRow[];
}

export interface TrackingCategoryGroup {
  label: string;
  rows: TrackingRow[];
}

export interface AttendanceWhatsappSettings {
  attendanceWhatsappGroupId?: string | null;
}

export interface WhatsappChat {
  id: string;
  name: string;
  type: string;
}

export function statusClass(status: TrackingStatus) {
  if (status === FACTORY_TRACKING_STATUSES.absent)
    return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  if (status === FACTORY_TRACKING_STATUSES.new)
    return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
}

export function SummaryTile({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <Card className="shadow-none">
      <CardContent className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className="text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

export function CategoryInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      placeholder={placeholder}
      className="h-8 w-full min-w-0"
    />
  );
}
