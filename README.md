# claude-hist

> Interactive terminal session browser — search, preview, and jump back into any past session instantly.

![npm](https://img.shields.io/npm/v/claude-hist)
![license](https://img.shields.io/npm/l/claude-hist)
![node](https://img.shields.io/node/v/claude-hist)

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

## Usage

```bash
chist
```

Launches an interactive TUI to browse all your sessions.

### Flags

```bash
chist --list        # plain text output, no TUI
chist --list --ids  # include session UUIDs in output
```

---

## Keys

| Key | Action |
|-----|--------|
| `↑ / ↓` | Navigate sessions |
| `PgUp / PgDn` | Jump 8 rows |
| `Enter` | Open selected session |
| `p` | Toggle preview pane |
| `g` | Toggle flat / grouped by project |
| `t` | Tag / rename a session |
| `d` | Delete a session |
| `Esc / Ctrl+C` | Quit |
| Type anything | Filter sessions live |

---

## Features

- **Live search** — filter sessions by title, project path, or tag
- **Preview pane** — press `p` to peek at the first few messages
- **Color-coded dates** — green = today, yellow = recent, gray = old
- **Group by project** — press `g` to group sessions by directory
- **Tags** — press `t` to label any session; tags persist across restarts
- **Delete** — press `d` to remove a session with confirmation
- **Sliding window** — htop-style 8-row view, no full-screen flicker
- **Instant resume** — Enter opens the session in the correct directory

---

## Requirements

- Node.js >= 16
- macOS / Linux (requires TTY)

---

## License

MIT
