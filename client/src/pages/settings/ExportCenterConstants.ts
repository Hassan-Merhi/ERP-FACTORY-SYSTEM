export const TIMEZONES: { value: string; label: string }[] = [
  { value: "Africa/Lubumbashi", label: "Lubumbashi (CAT, UTC+2)" },
  { value: "Africa/Nairobi", label: "Nairobi (EAT, UTC+3)" },
  { value: "Africa/Lagos", label: "Lagos (WAT, UTC+1)" },
  { value: "Africa/Cairo", label: "Cairo (EET, UTC+2)" },
  { value: "Africa/Johannesburg", label: "Johannesburg (SAST, UTC+2)" },
  { value: "UTC", label: "UTC (GMT+0)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Paris (CET, UTC+1/+2)" },
  { value: "Europe/Istanbul", label: "Istanbul (TRT, UTC+3)" },
  { value: "Asia/Dubai", label: "Dubai (GST, UTC+4)" },
  { value: "Asia/Karachi", label: "Karachi (PKT, UTC+5)" },
  { value: "Asia/Kolkata", label: "Kolkata (IST, UTC+5:30)" },
  { value: "Asia/Riyadh", label: "Riyadh (AST, UTC+3)" },
  { value: "America/New_York", label: "New York (EST/EDT)" },
  { value: "America/Chicago", label: "Chicago (CST/CDT)" },
  { value: "America/Denver", label: "Denver (MST/MDT)" },
  { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)" },
];

export const DAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

export function formatHour(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}
