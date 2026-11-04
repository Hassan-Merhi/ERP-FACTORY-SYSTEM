/**
 * Deterministic narration for the training recorder.
 *
 * Every sentence spoken in a training video is produced here from the real,
 * visible UI control (its label, role, state and position). There is no
 * generative model: the same screen always yields the same script, which keeps
 * the recordings reviewable and keeps the recorder from "inventing" features.
 *
 * Also contains the small WAV helpers used to pad and join the per-sentence
 * narration clips into one continuous track that lines up with the frames.
 */

const PAGE_HINTS = Object.freeze({
  "overview": "the production overview with today's output, costs and bale lifecycle",
  "agent ledger": "the ledger of agents and the balances owed to or by each agent",
  "accounts": "the chart of accounts with balances and account statements",
  "daybook": "the day-by-day list of every transaction recorded for the company",
  "all daybook": "the combined transaction journal across all companies you can access",
  "vouchers": "payment, receipt, journal, transfer and adjustment vouchers",
  "tracking": "container and goods-in-transit tracking, including transporter statements",
  "dashboard": "the financial dashboard with revenue, cost and cash summaries",
  "create": "the quick-create screen for new records such as items, parties and vouchers",
  "spreadsheet": "the built-in spreadsheet for working with exported figures",
  "live sheets": "live spreadsheets that stay connected to system data",
  "help & training": "this help and training center with written guides and videos",
  "chat": "the internal chat used to message colleagues inside the system",
  "ic requests": "intercompany requests exchanged between your companies",
  "ic links": "intercompany links that connect related companies",
  "settings": "company settings, users, permissions and preferences",
  "intel settings": "settings for the intelligence and analytics features",
  "accounting toolbox": "accounting utilities such as reconciliations and corrections",
  "payroll & benefits": "workers, employees, attendance, payroll, advances and bonuses",
  "stock entry": "where new production is recorded as bales with weights and products",
  "raw materials": "raw material stock, purchases and consumption",
  "containers": "container loading, verification and dispatch",
  "invoices": "factory sales invoices and their verification",
  "stock allocation": "allocation of produced stock to customers and proformas",
  "analytics": "charts and trend analysis built from recorded data",
  "inventory": "stock items, quantities, locations and movements",
  "point of sale": "the point of sale for retail transactions",
  "pos": "the point of sale for retail transactions",
  "sales report": "sales totals by period, category and item",
  "reports": "reports built from the recorded transactions",
  "suppliers": "supplier records, balances and purchase history",
  "customers": "customer records, balances and sales history",
  "parties": "customers, suppliers and other business parties",
  "stock": "stock items and their quantities",
  "stock in & sales": "stock received versus stock sold over a period",
  "profit check": "profit verification against supplier costs",
  "cost centers": "cost center allocation and reporting",
  "shops": "retail shops and their inventory",
  "bale explorer": "search and trace individual bales through their lifecycle",
});

const SECTION_HINTS = Object.freeze({
  "production": "production entry, bale stock, raw materials and production reports",
  "inventory": "stock levels, locations, transfers and inventory reports",
  "sales & loading": "proformas, invoices, container loading and dispatch",
  "sales & pos": "point of sale, sales reports and sales tools",
  "finance": "accounts, vouchers, payroll and financial statements",
  "accounting": "accounts, vouchers, journals and financial statements",
  "accounting tools": "reconciliations, corrections and accounting utilities",
  "rentals": "property rentals, tenants and rental income",
  "intelligence": "analytics, forecasts and AI-assisted reviews",
  "analytics": "charts, trends and performance analysis",
  "ai tools": "AI-assisted validation and command tools",
});

const ACTION_RULES = [
  [/^(previous|prev)\b.*\bpage\b/, (l) => `The "${l}" button moves to the previous page of the table.`],
  [/^next\b.*\bpage\b/, (l) => `The "${l}" button moves to the next page of the table.`],
  [/^(previous|prev)\b/, (l) => `The "${l}" button moves one period back, so you can review earlier records.`],
  [/^next\b/, (l) => `The "${l}" button moves one period forward.`],
  [/\bvs\b/, (l) => `The "${l}" option compares the two periods named in it, ${l.replace(/\s+vs\s+/i, " against ")}, so you can see what changed.`],
  [/^custom\b/, (l) => `The "${l}" option lets you pick your own date range instead of a preset period.`],
  [/^(daily|monthly|yearly|weekly)$/, (l) => `The "${l}" option groups the figures by ${l.toLowerCase().replace(/ly$/, "")} so trends are easier to compare.`],
  [/^(today|yesterday|this week|this month|last month|this year|last year)$/, (l) => `The "${l}" option limits the figures to ${l.toLowerCase()}.`],
  [/\b(date range|period|preset)\b/, (l) => `The "${l}" period selector chooses which dates the figures cover, for example today, this week, this month or a custom range.`],
  [/\b(selling price|cost price)\b/, (l) => `The "${l}" switch changes how values are calculated. "${l}" is the valuation shown now; the figures update immediately without changing any record.`],
  [/\bfilters?\b/, (l) => `The "${l}" button opens filter options that narrow the list to what you need. Filters only change what is displayed; they never change the data.`],
  [/\bcolumns?\b/, (l) => `The "${l}" button lets you choose which table columns are visible.`],
  [/\bactions?\b/, (l) => `The "${l}" menu groups the operations available for the selected records. Every action still asks for confirmation before anything is changed.`],
  [/\bexport\b/, (l) => `The "${l}" button downloads the current view as a file, usually Excel, for sharing or checking outside the system.`],
  [/\btemplate\b/, (l) => `The "${l}" button downloads a blank file in the correct layout, which you fill in and import later.`],
  [/\bprint\b/, (l) => `The "${l}" button prepares a printable document of the current record or list.`],
  [/\bhistory\b/, (l) => `The "${l}" button shows previous entries so you can review what was recorded earlier.`],
  [/\bscan\b/, (l) => `The "${l}" button opens barcode scanning so a bale or product code can be read instead of typed.`],
  [/\b(quick create|add row|add line|add page)\b/, (l) => `The "${l}" button adds another line, record or sheet. Nothing is saved until the form is confirmed.`],
  [/^(add|new|create)\b/, (l) => `The "${l}" button starts a new record. A form opens, and nothing is stored until it is completed and saved.`],
  [/\b(save|confirm|submit|post)\b/, (l) => `The "${l}" button is the final step: it saves the entry and updates the related records. Check every field before pressing it, because saved transactions affect stock and accounts.`],
  [/\b(delete|remove)\b/, (l) => `The "${l}" button removes the selected record. It asks for confirmation first; use it carefully.`],
  [/\bedit\b/, (l) => `The "${l}" button opens that record for changes.`],
  [/^copy\b/, (l) => `The "${l}" button copies that value to the clipboard so you can paste it elsewhere.`],
  [/\b(refresh|reload)\b/, (l) => `The "${l}" button reloads the latest data from the server.`],
  [/\b(close|cancel)\b/, (l) => `The "${l}" button closes the current form without saving.`],
  [/\b(reset|clear)\b/, (l) => `The "${l}" button clears the current selections and filters.`],
  [/\bapply\b/, (l) => `The "${l}" button applies the chosen filters or options to the list.`],
  [/^(show |hide |toggle )?notes?$/, (l) => `The "${l}" button shows or hides a notes field for extra remarks.`],
  [/\bimport\b/, (l) => `The "${l}" button loads records from a file. Imported rows are reviewed before they are saved.`],
  [/\bupload\b/, (l) => `The "${l}" button attaches a file to the record.`],
  [/\bdownload\b/, (l) => `The "${l}" button downloads the related file.`],
  [/\beffective date\b/, (l) => `The "${l}" button reveals an additional effective-date field, used when the accounting date differs from the entry date.`],
  [/\bsettings?\b/, (l) => `The "${l}" button opens the settings for this screen.`],
  [/\bmy company\b/, (l) => `The "${l}" option limits the list to records of the company you are working in.`],
  [/\ball (accessible )?companies\b/, (l) => `The "${l}" option widens the list to every company you have access to.`],
  [/\b(detailed|compact|summary|card|table|list|grid)\s*view\b|\bview$/, (l) => `The "${l}" button switches the layout to the ${l.replace(/\s*view$/i, "")} view of the same records.`],
  [/\bsheet\b/, (l) => `The "${l}" button opens the records in the spreadsheet view.`],
  [/\b(search|find|lookup)\b/, (l) => `The "${l}" button runs the search with the text you entered.`],
  [/\bback\b/, (l) => `The "${l}" button returns to the previous screen.`],
  [/^select\b/, (l) => `The "${l}" control opens a list so you can pick one or more entries.`],
  [/^(all|any)\b/, (l) => `The "${l}" option shows every record without filtering.`],
];

function clean(text) {
  return String(text || "")
    .replace(/[…]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speakable(text) {
  return clean(text)
    .replace(/&/g, " and ")
    .replace(/\s*\/\s*/g, " or ")
    .replace(/#/g, "number ")
    .replace(/%/g, " percent")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[^\p{L}\p{N}\s.,;:'"()$+\-?!]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hint(map, label) {
  const key = clean(label).toLowerCase();
  if (map[key]) return map[key];
  const found = Object.keys(map).find((name) => key.includes(name));
  return found ? map[found] : "";
}

const DISABLED_NOTE = " It is greyed out right now, which means it cannot be used until its conditions are met, for example when required fields are filled or more records exist.";

function trailing(control) {
  const notes = [];
  if (control.description) notes.push(clean(control.description).replace(/[.]?$/, "."));
  if (control.count !== undefined && control.count !== "" && control.count !== null) notes.push(`The number next to it, ${control.count}, is how many records it holds.`);
  if (control.disabled) notes.push(DISABLED_NOTE.trim());
  return notes.length ? " " + notes.join(" ") : "";
}

function groupNote(control) {
  if (!control.group || !control.group.length) return "";
  const others = control.group.slice(0, 5).map((name) => `"${name}"`).join(", ");
  return ` It sits in a group of choices next to ${others}; only one of them is active at a time.` + (control.pressed || control.selected ? " It is the active choice right now." : "");
}

/**
 * Produce one spoken sentence for a visible control.
 * @param {{region:string, tag:string, role:string, type:string, label:string,
 *   testid:string, disabled:boolean, selected:boolean, pressed:boolean,
 *   expanded:string|null, group:string[], count:string, description:string,
 *   value:string, placeholder:string, href:string, haspopup?:string}} control
 */
export function describeControl(control) {
  const testid = clean(control.testid);
  const noun = testid.replace(/^(input|select|button|checkbox|tab|link|card|toggle)-/, "").replace(/-\d+$/, "").replace(/-/g, " ").trim();
  let label = clean(control.label) || clean(control.placeholder) || noun;
  // Placeholders such as "0.00" or "Type to search..." name nothing; the test id does.
  if (noun && (/^[\d.,\s-]*$/.test(label) || /^(type to search|search|select|choose)(\.\.\.)?$/i.test(label))) label = noun;
  const lower = label.toLowerCase();
  const role = control.role || "";
  const tag = control.tag || "";
  const type = control.type || "";
  const isTab = role === "tab" || testid.startsWith("tab-");

  if (testid === "button-sidebar-toggle") return "At the top left, the sidebar toggle collapses or expands the navigation menu so the page gets more room.";
  if (testid === "button-open-palette") return "The search button opens the command palette. You can also press Control and forward slash to jump to any page or action by typing its name.";
  if (testid === "button-notifications-bell") return "The bell icon opens your notifications: approvals, alerts and messages that need your attention.";
  if (testid === "button-user-menu") return "The account menu shows who is signed in and their role. From here you open your own settings or sign out.";
  if (testid === "button-company-selector") {
    const company = label.match(/current company:\s*([^.]+)/i)?.[1]?.trim();
    return (company ? `The company selector shows that you are working in ${company}. ` : "The company selector shows the company you are working in. ") +
      "Open it to switch companies if you have access to more than one. Every figure on the screen belongs to the selected company only.";
  }
  if (testid === "button-theme-toggle") return "The theme toggle switches the screen between light and dark mode.";
  if (testid === "button-sidebar-logout") return "The log out button at the bottom of the sidebar ends your session. Always sign out on shared computers.";
  if (testid === "button-open-user-notes") return "The floating notes button opens your personal notes. They are private to your account and are not part of any transaction.";
  if (testid.startsWith("button-section-")) {
    const section = hint(SECTION_HINTS, label);
    return `The "${label}" section in the sidebar expands to list ${section || `all ${label} pages`}.`;
  }
  if (testid.includes("recent-")) return `Under Recent, the sidebar keeps a shortcut to "${label}", a page you opened lately.`;

  if (control.region === "sidebar") {
    const page = hint(PAGE_HINTS, label);
    return `"${label}" opens ${page || `the ${label} page`}.` + (control.selected ? " It is the page you are looking at now." : "");
  }

  if (role === "option") {
    return `"${label}" is one of the choices in this list.` + (control.selected ? " It is the one currently selected." : " Choosing it fills the field with that value and closes the list.");
  }
  if (/^menuitem/.test(role)) {
    return `"${label}" is an item in this menu; choosing it runs that action for the record you opened the menu from.${trailing(control)}`;
  }
  if (isTab) {
    return `The "${label}" tab switches this screen to the ${label} view.` + (control.selected ? " It is the view currently shown." : " Tabs only change what is displayed.") + trailing(control);
  }

  if (tag === "input" || tag === "textarea") {
    if (type === "date") return `The "${label}" date field sets the date used for this entry or report.`;
    if (type === "month") return `The "${label}" field picks the month used for this view.`;
    if (type === "time") return `The "${label}" field sets a time.`;
    if (type === "number") return `The "${label}" field takes a numeric value such as a quantity or an amount.`;
    if (type === "checkbox") return `The "${label}" checkbox turns this option on or off.`;
    if (type === "file") return `The "${label}" field chooses a file from your computer to attach or import.`;
    if (role === "combobox") return `The "${label}" box is a searchable selector: start typing and choose a match from the list that appears.`;
    if (noun && label === noun) return `The "${label}" box is where you type or search for the ${lower}; matching entries appear as you type.`;
    if (/search|find|filter/.test(lower)) return `Typing in the "${label}" box filters the records as you type; clear it to see everything again.`;
    const subject = lower.replace(/\.\.\.$/, "").replace(/^(type|enter|add|write)\s+(the\s+)?/, "").trim();
    return `The "${label}" field is where you type the ${subject || "required"} value.`;
  }
  if (tag === "select" || role === "combobox" || testid.startsWith("select-")) {
    if (/^(all|any)\b/.test(lower)) return `The dropdown currently set to "${label}" narrows the list to one ${lower.replace(/^(all|any)\s+/, "").replace(/s$/, "")} at a time. "${label}" means no filter is applied.${trailing(control)}`;
    if (/\b(today|yesterday|week|month|year|period|range|preset)\b/.test(lower)) return `The dropdown currently set to "${label}" chooses the reporting period, for example today, this week, this month or a custom range.${trailing(control)}`;
    if (/\b(rows|per page)\b/.test(lower)) return `The "${label}" dropdown sets how many rows the table shows on each page.${trailing(control)}`;
    const current = clean(control.value) && clean(control.value) !== label ? ` The current choice is "${clean(control.value)}".` : "";
    return `The dropdown showing "${label}" opens a list of options to choose from; the choice changes what is shown or how the entry is recorded.${current}${trailing(control)}`;
  }
  if (role === "switch") return `The "${label}" switch turns this option on or off.` + (control.pressed ? " It is on right now." : " It is off right now.");
  if (role === "checkbox" || testid.startsWith("checkbox-")) return `The "${label}" checkbox turns this option on or off.${trailing(control)}`;
  if (/^\d{1,2}\s+\w+,?\s+\d{4}$|^\w{3}\s+\d{1,2},\s+\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return `The date button showing "${label}" opens a calendar so you can pick another date.${trailing(control)}`;
  }
  const popup = control.haspopup && control.haspopup !== "false";
  const panelNote = control.expanded !== null && control.expanded !== undefined && !popup
    ? ` It is ${control.expanded === "true" ? "open" : "collapsed"} at the moment.` : "";
  for (const [pattern, sentence] of ACTION_RULES) {
    if (pattern.test(lower)) return sentence(label) + panelNote + groupNote(control) + trailing(control);
  }
  if (popup) return `The "${label}" button opens a menu of related options; nothing happens until you pick one.${trailing(control)}`;
  if (panelNote) {
    return `The "${label}" panel header expands or collapses that panel.${panelNote}${trailing(control)}`;
  }
  if (tag === "a") {
    const page = hint(PAGE_HINTS, label);
    return `The "${label}" link opens ${page || label}.${trailing(control)}`;
  }
  if (testid.startsWith("card-")) return `The "${label}" card selects ${label}. Choose a card to continue with that location.`;
  if (testid.startsWith("account-") || /ledger/.test(lower)) return `"${label.replace(/Ledger\$?/i, " ledger, balance ")}" is an account you can pick for this entry.`;

  if (control.group && control.group.length) {
    return `The "${label}" option changes which records or figures are shown.` + groupNote(control) + trailing(control);
  }
  return `The "${label}" button opens the ${label} function of this page; the screen explains what it needs before anything is saved.${trailing(control)}`;
}

export function describeHeading(text, level) {
  const label = clean(text);
  if (level === "h1") return `The page title reads "${label}".`;
  const page = hint(PAGE_HINTS, label);
  return `Next is the "${label}" section` + (page ? `, which covers ${page}.` : ".");
}

export function introNarration(tour, mode, heading, subtitle) {
  const where = mode === "factory" ? "Factory mode" : "ERP mode";
  const parts = [
    `Welcome to the ${tour.title} training video. This page is in ${where} of the Business OS system.`,
    heading ? `The screen heading reads "${clean(heading)}"${subtitle ? `, ${clean(subtitle)}` : ""}.` : "",
    tour.explainsSharedChrome
      ? "We will go through every control on this screen: the top bar, the sidebar, and then each tab, button, field and hidden menu in the main area. The recording uses a disposable training company, so nothing here is a real transaction."
      : "We will go through every tab, button and field of this page, and open each menu, dropdown and dialog to show what is inside. The recording uses a disposable training company, so nothing here is a real transaction.",
  ];
  return parts.filter(Boolean).join(" ");
}

/** One sentence that points to the video where the shared top bar and sidebar are explained. */
export function sharedChromeNarration(mode, overviewTitle) {
  const where = mode === "factory" ? "Factory" : "ERP";
  return `The top bar and the sidebar are the same on every ${where} screen, so they are not repeated here. They are explained control by control in the ${overviewTitle} video.`;
}

/** Lead-in spoken when a control is clicked to reveal its hidden contents. */
export function layerIntro(parentLabel, layerType, count, heading) {
  const what = layerType === "dialog" ? "a dialog" : layerType === "menu" ? "a menu" : layerType === "list" ? "a list of choices" : "a panel";
  const named = heading && clean(heading) !== clean(parentLabel) ? ` titled "${clean(heading)}"` : "";
  if (!count) return `Clicking "${clean(parentLabel)}" opens ${what}${named}. It has no further controls, so press Escape or click outside it to close it again.`;
  return `Clicking "${clean(parentLabel)}" opens ${what}${named} with ${count} control${count === 1 ? "" : "s"} that are hidden until you open it. Let me go through ${count === 1 ? "it" : "each of them"}.`;
}

/** Sentence spoken while a safe demonstration is performed on the control. */
export function demoNarration(demo, label, text) {
  if (demo === "type") return ` Watch: typing ${text.split("").join(" ")} narrows the list to the matching rows, and clearing the box brings everything back.`;
  if (demo === "open") return " Let me open it so you can see what is inside.";
  if (demo === "pick") return ` Watch what happens when I choose "${clean(label)}".`;
  return "";
}

export function closingNarration(tour) {
  return `That completes the ${tour.title} tour. ${tour.steps[tour.steps.length - 1]} If you need to see a control again, use the chapter captions, or open Help and Training for the written guide.`;
}

// ---------------------------------------------------------------- WAV utils

/** Parse a 16-bit PCM WAV file and return its format and raw sample data. */
export function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Narration clip is not a RIFF WAVE file");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error("Narration clip must be 16-bit PCM WAV");
  }
  const bytesPerSecond = format.sampleRate * format.channels * 2;
  return { ...format, data, durationSeconds: data.length / bytesPerSecond };
}

/**
 * Join clips into one 16-bit PCM WAV. Each clip is padded (or cut) to exactly
 * `targetSeconds` so the audio stays aligned with the captured frame count.
 */
export function joinWavClips(clips) {
  if (!clips.length) throw new Error("No narration clips to join");
  const { sampleRate, channels } = clips[0].wav;
  const chunks = [];
  for (const clip of clips) {
    if (clip.wav.sampleRate !== sampleRate || clip.wav.channels !== channels) {
      throw new Error("Narration clips must share one sample rate and channel count");
    }
    const bytes = Math.round(clip.targetSeconds * sampleRate) * channels * 2;
    const padded = Buffer.alloc(bytes);
    clip.wav.data.copy(padded, 0, 0, Math.min(bytes, clip.wav.data.length));
    chunks.push(padded);
  }
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function vttTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60_000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, "0")}`;
}
