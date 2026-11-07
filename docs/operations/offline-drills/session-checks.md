# Session checks: read-only laptops, old queues, operator buttons

These need no approval switch, but every drill session runs them once so they
are proven on real laptops before rollout. Record each result in that day's
drill record. Do them after the batch's handover, with both staging sides back
online.

## Operator buttons

- [ ] **Pause:** on the staging factory server, `drill_admin` opens the Offline
  panel, presses **Pause delivery**, enters a reason of 10+ characters and the
  password. Create one record offline-capable for the day's batch; run the
  relay: it sends nothing.
- [ ] **Resume:** press **Resume delivery** the same way; run the relay: the
  record is sent once.
- [ ] **Hidden for others:** signed in as `drill_manager`, the Pause/Resume
  buttons are not shown.
- [ ] **Wrong password:** a decision on the cloud console with a wrong password
  is refused and nothing is recorded.
- [ ] **Log:** both pause rows and every conflict decision show the user's name
  and reason (runbook §4.4 status command, or the Offline panel).

## Read-only laptop (decision 10)

Use laptop A.

1. [ ] Online, signed in to the staging factory server as `drill_admin`,
   prepare the encrypted read cache (Offline panel → prepare, with a
   passphrase of 12+ characters).
2. [ ] Disconnect laptop A from both the cloud and the factory server (Wi-Fi
   off, cable out). Close and reopen the browser.
3. [ ] The unlock screen appears. A wrong passphrase does not open it.
4. [ ] The right passphrase opens it read-only. The banner reads "Not
   connected to the factory server: view only". Prepared pages show data.
5. [ ] Try to save anything (for example a stock adjustment). It is refused
   with the banner text; nothing is queued.
6. [ ] Set laptop A's clock 25 hours ahead and reopen the browser: the cache
   no longer opens. Set the clock back.
7. [ ] Prepare the cache again as `drill_leaver`, reconnect, have the DBA
   disable `drill_leaver` in the cloud, reload: the read-only access is gone.
8. [ ] Sign out on a prepared laptop: the read-only access is gone.

## Old browser queues

Use laptop B, which must still hold entries in the old browser offline queue.
If it has none, the developer on duty seeds one Payment and one POS sale entry
with the browser developer tools before the session (written into the
record).

- [ ] Sign in as `drill_admin`. The **Entries saved by the old offline queue** window lists each
  entry with date, type and amount; notes and other details are hidden.
- [ ] Discard one entry. It disappears from the list.
- [ ] Mark the other re-entered after typing it again through the normal form.
- [ ] Both choices appear in the audit log (table `offline_legacy_queue_entries`)
  with `drill_admin`'s name. Neither entry was sent to the server by itself.
- [ ] Signed in as `drill_manager`, the window is not shown.
