import type { RowsExportColumn } from "@/components/export/RowsExportMenu";
import type { PressingUiTranslationKey } from "@/i18n/pressingUiTranslations";
import type { PressingHourlySnapshot } from "./pressing-scanner/pressingHourlyKpi";
import { hourLabel, resultStatus, verdictStyle } from "./usePressingHourlyTargetsState";

/** Export: one row per hour, the hour target and each worker's KG / target / result as shown. */
export function pressingHourlyExportColumns({
  data,
  configured,
  now,
  t,
}: {
  data: PressingHourlySnapshot | undefined;
  configured: (hour: string) => number | undefined;
  now: number;
  t: (key: PressingUiTranslationKey) => string;
}): RowsExportColumn<string>[] {
  const workerCell = (hour: string, userId: string, targetKgPerHour: number) => {
    const row = data?.hours.find((item) => item.hourStart === hour && item.userId === userId);
    const kg = Number(row?.kg || 0);
    const hourTarget = configured(hour);
    const scheduled = data?.scheduledWorkday !== false || hourTarget !== undefined;
    const target = scheduled ? (hourTarget ?? targetKgPerHour) : 0;
    const started = new Date(hour).getTime() <= now;
    const complete = new Date(hour).getTime() + 3600000 <= now;
    const verdict = scheduled ? resultStatus(kg, target, Number(row?.bales || 0), started, complete) : "off";
    const label = verdictStyle[verdict].label;
    const result =
      verdict === "upcoming" || verdict === "above" || verdict === "below"
        ? t(label as "upcoming" | "aboveTarget" | "belowTarget")
        : label;
    return { kg, target: scheduled ? target : null, result };
  };
  return [
    { header: "Hour (Beirut)", value: (hour) => hourLabel(hour) },
    { header: t("hourTargetHeader"), value: (hour) => configured(hour) ?? null, type: "number" },
    ...(data?.workers ?? []).flatMap((worker): RowsExportColumn<string>[] => [
      {
        header: `${worker.name} KG`,
        value: (hour) => workerCell(hour, worker.userId, worker.targetKgPerHour).kg,
        type: "number",
      },
      {
        header: `${worker.name} Target KG`,
        value: (hour) => workerCell(hour, worker.userId, worker.targetKgPerHour).target,
        type: "number",
      },
      {
        header: `${worker.name} Result`,
        value: (hour) => workerCell(hour, worker.userId, worker.targetKgPerHour).result,
      },
    ]),
  ];
}
