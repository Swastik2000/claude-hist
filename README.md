# claude-hist

> Interactive terminal session browser — search, preview, and jump back into any past session instantly.

![npm](https://img.shields.io/npm/v/claude-hist)
![license](https://img.shields.io/npm/l/claude-hist)
![node](https://img.shields.io/node/v/claude-hist)

---

## The Problem

If you've ever tried to resume a past session, you've hit these walls:

- **You must be in the right directory.** `--resume` only works if you `cd` into the exact project folder first. If you're somewhere else, it either fails or starts fresh.
- **Sessions are just UUIDs.** The list shows raw IDs like `3f9a1b2c-...` — no titles, no hints, no context about what you were working on.
- **No preview.** You have no idea what was discussed in a session until you're already inside it.
- **Sessions feel like they disappear.** You worked on something yesterday, but you can't find it because there's no search, no filter, no way to tell sessions apart.
- **No timestamps or recency.** You can't tell which session was from today vs last week.
- **No project context.** When you have sessions across multiple projects, there's no way to see which session belongs to which folder.
- **Tagging is impossible.** There's no way to label or name a session for later reference.

`claude-hist` solves all of this from a single command.

---

## What It Does

```bash
chist
```

Launches a full terminal UI that shows all your sessions across every project — with titles, timestamps, project paths, and a live search filter. Press `Enter` to jump straight in, regardless of which directory you're currently in.

---

## Install

```bash
npm install -g claude-hist
```

Or run without installing:

```bash
npx claude-hist
```

---

## Keys

| Key | Action |
|-----|--------|
| `↑ / ↓` | Navigate sessions |
| `PgUp / PgDn` | Jump 8 rows |
| `Enter` | Open selected session (auto `cd` to correct directory) |
| `p` | Toggle preview pane — see the first few messages + message count |
| `f` | Star / unstar a session (persisted across restarts) |
| `*` | Toggle favorites filter — show only starred sessions |
| `c` | Copy session ID to clipboard |
| `o` | Toggle sort: by date (default) ↔ by project |
| `g` | Toggle flat / grouped by project |
| `t` | Tag / rename a session |
| `d` | Delete a session |
| `D` | Bulk delete — remove all sessions from this project |
| `s` | Toggle `--dangerously-skip-permissions` mode |
| `Esc / Ctrl+C` | Quit |
| Type anything | Filter sessions live by title, path, or tag |

---

## Features

- **Titles instead of UUIDs** — shows the first message as the session title
- **Live search** — filter by title, project path, or tag instantly
- **Preview pane** — press `p` to see the first few message exchanges before opening
- **Auto `cd`** — opens the session in its original directory, no manual `cd` needed
- **Color-coded dates** — green = today, yellow = 2–3 days, orange = 2 weeks, gray = older
- **Group by project** — press `g` to group sessions by directory
- **Tags** — press `t` to label any session; tags persist in `~/.claude/cresume-meta.json`
- **Stars** — press `f` to star any session; press `*` to filter to starred only
- **Copy ID** — press `c` to copy the session UUID to clipboard
- **Sort toggle** — press `o` to switch between date sort and project sort
- **Size indicator** — `S` / `M` / `L` per row based on session file size
- **Message count** — visible in preview pane header
- **Delete** — press `d` to remove a session, `D` to bulk-delete all sessions from a project
- **Skip permissions** — press `s` to toggle `--dangerously-skip-permissions`; shown as a red warning when active
- **Auto-update notification** — footer shows a hint when a newer version is available on npm
- **Sliding window** — htop-style 8-row scrolling view
- **`--list` flag** — plain text output, scriptable and pipeable

---

## Flags

```bash
chist --list               # plain text, no TUI — good for scripting
chist --list --ids         # include session UUIDs in output
chist --here               # show only sessions from the current directory
chist --project ~/my/app   # show only sessions from a specific directory
```

---

## Requirements

- Node.js >= 16
- macOS / Linux (requires TTY)

---

## License

MIT
