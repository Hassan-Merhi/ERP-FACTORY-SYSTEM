import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeControl, describeHeading, introNarration, closingNarration,
  speakable, parseWav, joinWavClips, vttTimestamp,
} from "./training-narration.mjs";

const control = (overrides) => ({
  region: "main", tag: "button", role: "", type: "button", label: "", testid: "",
  disabled: false, selected: false, pressed: false, expanded: null, group: [],
  count: "", description: "", value: "", placeholder: "", href: "", ...overrides,
});

test("header controls get purpose-built explanations", () => {
  assert.match(describeControl(control({ region: "header", testid: "button-company-selector", label: "Current company: Phase 7 Browser Factory. Open company switcher" })), /working in Phase 7 Browser Factory/);
  assert.match(describeControl(control({ region: "header", testid: "button-open-palette", label: "Open search" })), /command palette/);
  assert.match(describeControl(control({ region: "sidebar", testid: "button-sidebar-logout", label: "Log out" })), /ends your session/);
});

test("sidebar links explain where they lead and sections explain what they expand", () => {
  assert.equal(describeControl(control({ region: "sidebar", tag: "a", label: "Vouchers", testid: "link-/vouchers" })),
    '"Vouchers" opens payment, receipt, journal, transfer and adjustment vouchers.');
  assert.match(describeControl(control({ region: "sidebar", testid: "button-section-finance", label: "Finance" })), /expands to list accounts, vouchers, payroll/);
  assert.match(describeControl(control({ region: "sidebar", tag: "a", label: "Unknown Page", testid: "link-x" })), /opens the Unknown Page page/);
});

test("tabs, fields, dropdowns and action buttons each get a specific sentence", () => {
  assert.match(describeControl(control({ role: "tab", label: "Shipping", testid: "tab-shipping" })), /"Shipping" tab switches this screen/);
  assert.match(describeControl(control({ role: "tab", label: "Production", selected: true })), /currently shown/);
  assert.match(describeControl(control({ tag: "input", type: "date", label: "Stock entry date" })), /date field sets the date/);
  assert.match(describeControl(control({ tag: "input", type: "text", placeholder: "Search container #, company…" })), /filters the records as you type/);
  assert.match(describeControl(control({ testid: "select-status-filter", label: "All statuses" })), /means no filter is applied/);
  assert.match(describeControl(control({ testid: "select-preset", label: "Today" })), /reporting period/);
  assert.match(describeControl(control({ label: "Export Excel" })), /downloads the current view/);
  assert.match(describeControl(control({ label: "Save Voucher", disabled: true })), /final step.*greyed out/);
  assert.match(describeControl(control({ label: "Next shipping page" })), /next page of the table/);
  assert.match(describeControl(control({ label: "This Month vs Last Month" })), /This Month against Last Month/);
  assert.match(describeControl(control({ label: "Scheduled Containers", count: "3", expanded: "true" })), /panel header.*open.*3, is how many/);
  assert.match(describeControl(control({ label: "Nov 04, 2026", expanded: "false", haspopup: "dialog" })), /date button.*opens a calendar/);
  assert.match(describeControl(control({ tag: "input", type: "text", placeholder: "Type location..." })), /where you type the location value/);
  assert.match(describeControl(control({ tag: "input", type: "number", placeholder: "0.00", testid: "input-amount-0" })), /"amount" field takes a numeric value/);
});

test("grouped choices mention their siblings and the fallback never claims a feature it cannot see", () => {
  const sentence = describeControl(control({ label: "Verified", group: ["All", "Loading", "Finalized"], pressed: true }));
  assert.match(sentence, /"All", "Loading", "Finalized"/);
  assert.match(sentence, /active choice right now/);
  assert.match(describeControl(control({ label: "Sheet" })), /spreadsheet view/);
  assert.match(describeControl(control({ label: "Frobnicate" })), /opens the Frobnicate function/);
});

test("headings, intro and closing read naturally", () => {
  assert.equal(describeHeading("Overview", "h1"), 'The page title reads "Overview".');
  assert.match(describeHeading("Production Overview", "h3"), /^Next is the "Production Overview" section, which covers/);
  const tour = { title: "ERP vouchers", steps: ["a", "b", "c", "d", "Review debit and credit details before posting."] };
  assert.match(introNarration(tour, "erp", "Vouchers", "Payment, receipt and journal"), /Welcome to the ERP vouchers training video.*ERP mode.*"Vouchers", Payment, receipt and journal/);
  assert.match(closingNarration(tour), /That completes the ERP vouchers tour\. Review debit and credit details before posting\./);
});

test("spoken text replaces symbols a voice cannot read", () => {
  assert.equal(speakable("Search container # or supplier… & more / less 50%"), "Search container number or supplier and more or less 50 percent");
});

test("narration clips are padded to the frame boundary and joined into one PCM track", () => {
  const sampleRate = 22050;
  const clip = (seconds) => {
    const data = Buffer.alloc(Math.round(seconds * sampleRate) * 2, 7);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
    return parseWav(Buffer.concat([header, data]));
  };
  const first = clip(1.3);
  assert.ok(Math.abs(first.durationSeconds - 1.3) < 0.001);
  const joined = parseWav(joinWavClips([{ wav: first, targetSeconds: 2 }, { wav: clip(0.4), targetSeconds: 1.5 }]));
  assert.equal(joined.sampleRate, sampleRate);
  assert.ok(Math.abs(joined.durationSeconds - 3.5) < 0.001);
  assert.equal(joined.data[0], 7);
  assert.equal(joined.data[joined.data.length - 1], 0, "padding after the clip is silence");
  assert.throws(() => parseWav(Buffer.from("not a wav file at all, definitely not")), /RIFF/);
});

test("VTT timestamps are zero-padded and millisecond precise", () => {
  assert.equal(vttTimestamp(0), "00:00:00.000");
  assert.equal(vttTimestamp(754.5), "00:12:34.500");
});
