// Extracted from ./ScheduledWhatsAppMessagesTab.tsx

type WeeklyTimes = Record<string, string>;

export type Schedule = {
  id: string;
  title: string;
  message: string;
  timezone: string;
  weeklyTimes: WeeklyTimes;
  startDate: string | null;
  endDate: string | null;
  enabled: boolean;
  recipientIds: number[];
  updatedAt: string;
};

export type Group = {
  id: number;
  name: string;
  chatId: string;
  active: boolean;
  isGroup: boolean;
};

export type Delivery = {
  id: string;
  title: string;
  recipientName: string;
  localDate: string;
  status: "sending" | "sent" | "failed";
  error: string | null;
  createdAt: string;
};

export type Form = Omit<Schedule, "id" | "updatedAt">;

export const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function blankForm(): Form {
  return {
    title: "",
    message: "",
    timezone: "Asia/Beirut",
    weeklyTimes: { "1": "09:00", "2": "09:00", "3": "09:00", "4": "09:00", "5": "09:00" },
    startDate: null,
    endDate: null,
    enabled: true,
    recipientIds: [],
  };
}

export function formatDays(times: WeeklyTimes): string {
  return days
    .flatMap((day, index) => (times?.[String(index)] ? [day.slice(0, 3) + " " + times[String(index)]] : []))
    .join(" · ");
}
