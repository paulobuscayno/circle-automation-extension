# Circle Outreach Assistant

A Chrome extension to semi-automate sending a prepared message to members of
**one specific Circle community**, by clicking each member's Message/Connect
button in turn, controlled from the browser's side panel.

Use only on a community you have been authorized by its admins/community
manager to message in bulk. Automated outreach against a community's terms
of service, or without consent, is out of scope for this tool.

## How it works

For each member card in the members directory:

- If a **Message** button is available → click it, type the template message
  into the DM composer, send it, go back to the list.
- If a **Connect** button is available → click it, type the message into the
  "Add a note" field of the connect modal, click **Send request**.
- If neither is available (e.g. "Pending" already sent, or it's your own
  profile) → skip.

Then it scrolls down to load more members and repeats, until everyone in the
directory has been processed. Progress is saved continuously, so
stopping/reloading never double-messages someone.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's icon — it opens as a **side panel** (stays open
   while you browse, unlike a popup).

## Setup

1. In the browser tab, go to your community's **Members** page (the page
   listing all members with Connect/Message buttons).
2. In the side panel: write your message template (`{{first_name}}` /
   `{{full_name}}` tokens supported), set delay range, max sends per
   session, and max sends per day.
3. Leave **Test mode** checked for your first run.
4. Click **Activate on this tab** — Chrome will ask you to grant the
   extension access to this one site only.

## Calibrate before sending anything for real

- **Preview next message** shows the exact rendered text for the next
  unprocessed member, so you can sanity-check the template/personalization
  before running anything.
- **Highlight detected member cards** outlines in red every card the
  extension can act on. If nothing highlights, or the wrong things
  highlight, open **Advanced selectors** and adjust the button text /
  placeholder text to match what's actually on your community's page
  (right-click a button → Inspect, read its visible label or placeholder).
  These match on visible text, not CSS classes, so small UI tweaks on
  Circle's end usually won't break it — different wording will.

## Running it

- **Start / Pause / Stop** live in the side panel, along with **Success /
  Skipped / Failed** counters and a progress count. Pause takes effect
  between members (it finishes whatever message is currently mid-send
  before stopping, rather than aborting partway through).
- Clicking **Start** with Test mode off asks for a confirmation before
  sending anything live.
- **Retry failed only** re-queues just the members that errored out
  (network hiccup, unexpected page state, etc.) without touching everyone
  else's progress.
- **Export results (CSV)** downloads a log of every member processed, what
  action was taken, and the outcome — useful for reporting back to whoever
  authorized this.
- **Reset progress** clears the sent/skipped/failed history so everyone
  becomes eligible again — only use this if you intend to re-message
  everyone.
- If the tab reloads mid-run, reopen the side panel and click **Start**
  again — already-processed members are automatically skipped.

## Rate limiting

Two independent caps protect the account: **max per session** (this run)
and **max per day** (persisted across runs/days, resets at midnight local
time). Keep both conservative — this clicks the same UI a human would, so
it's exactly as subject to Circle's own rate limits and anti-spam detection
as manual use, just hands-free.

## Notes / limitations

- This clicks real UI elements the same way a person would; it does not
  call any private API.
- If Circle changes their page layout significantly, re-run **Highlight
  detected member cards** and adjust Advanced Selectors as needed.
