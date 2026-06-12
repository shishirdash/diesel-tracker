# 🐾 Diesel Tracker

A phone-friendly app for logging Diesel's behavior **in the moment**, which then
syncs entries to the shared [Google Sheet tracker](https://docs.google.com/spreadsheets/d/1-N3LGuho6oWl9yF77j5CRe_no-DxaMINI4y90mafHzM/edit)
so external viewers (trainer, family) can review whenever they like.

## How it works

```
Phone (PWA) ──logs──▶ local storage (works offline)
     │
     └──auto-sync (on save / on open / every N min)──▶ Google Apps Script ──▶ "App Log" tab in the sheet
                                                              │
                                                  weekly trigger (optional)
                                                              ▼
                                                    "Weekly Summary" tab
```

- **Log tab** — all behaviors from the tracker (Touch sensitivity, Guarding,
  Leash pulling, Reactivity, Jumping, "Aggressive" play), grouped by category.
  Tap a behavior → pick a severity (Good / Watch / Issue / Incident, matching the
  sheet's green/yellow/orange/red) → optionally add a note → Save. Two taps total.
- **Offline-first** — entries are stored on the phone and queued; they sync
  automatically when you're back online. A badge in the header shows unsynced count.
- **History tab** — review/delete entries, export everything as CSV.
- **Sheet output** — entries land in a new **App Log** tab (color-coded rows),
  leaving your main tracker grid untouched. An optional weekly Apps Script trigger
  builds a **Weekly Summary** tab (per behavior: entry count, worst severity,
  combined notes) so the weekly check-in column is quick to fill in.

## Setup (one time, ~10 minutes)

### 1. Deploy the sheet endpoint

1. Open the tracker spreadsheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Change `TOKEN = "CHANGE-ME"` to any secret string of your choosing.
4. **Deploy → New deployment → Web app** with:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone** (the token is what gates writes)
5. Authorize when prompted, then copy the **Web app URL** (ends in `/exec`).

> Optional weekly summary: in the Apps Script editor go to **Triggers → Add
> trigger**, choose function `buildWeeklySummary`, event source *Time-driven*,
> *Week timer*, and pick a day/time (e.g. Sunday evening).

### 2. Host the app

The app is plain static files, so any static host works. With GitHub Pages:

1. In the repo: **Settings → Pages → Source: GitHub Actions**.
2. Push to `main` — the included workflow (`.github/workflows/pages.yml`) deploys it.
3. The app will be at `https://<user>.github.io/<repo>/`.

### 3. Set up your phone

1. Open the app URL on your phone.
2. Go to **Settings** in the app, paste the Apps Script URL and your token,
   pick an auto-sync cadence, hit **Save**, then **Test connection**.
3. Add to home screen (iOS: Share → *Add to Home Screen*; Android: browser menu →
   *Install app*). It then opens full-screen like a native app and works offline.

## Privacy note

The sync endpoint URL + token live only in your phone's local storage — nothing
is stored in this repo. Anyone with both the URL *and* the token could append
rows to the log tab (they can't read or edit anything else), so treat the token
like a password.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` / `app.css` / `app.js` | The app (vanilla JS, no build step) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA bits: offline cache + installability |
| `apps-script/Code.gs` | Google Apps Script: receives entries, writes the sheet tabs |
| `.github/workflows/pages.yml` | GitHub Pages deploy |
