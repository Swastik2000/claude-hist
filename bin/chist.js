#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
// Added spawnSync (clipboard) and execFile (update check) alongside existing spawn
const { spawn, spawnSync, execFile } = require('child_process');
const readline = require('readline');

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';
const BG_SEL = '\x1b[48;5;17m';

const c = {
  green:   s => `\x1b[92m${s}${R}`,
  yellow:  s => `\x1b[33m${s}${R}`,
  orange:  s => `\x1b[38;5;208m${s}${R}`,
  red:     s => `\x1b[91m${s}${R}`,
  gray:    s => `\x1b[90m${s}${R}`,
  cyan:    s => `\x1b[96m${s}${R}`,
  magenta: s => `\x1b[95m${s}${R}`,
  purple:  s => `\x1b[38;5;141m${s}${R}`,
  white:   s => `\x1b[97m${s}${R}`,
  bold:    s => `${B}${s}${R}`,
  dim:     s => `${D}${s}${R}`,
  sel:     s => `${BG_SEL}\x1b[97m${B}${s}${R}`,
};

// ─── Security ─────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID  = s => UUID_RE.test(s);
const safePath = (p, base) => {
  const r = path.resolve(p), b = path.resolve(base);
  return r === b || r.startsWith(b + path.sep);
};

// ─── Metadata / Tags ──────────────────────────────────────────────────────────
const META_FILE = path.join(os.homedir(), '.claude', 'chist-meta.json');
const loadMeta  = () => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; } };
const saveMeta  = m  => fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2), 'utf8');

// ─── Session Loading ──────────────────────────────────────────────────────────
// Removed early `break` after cwd+title found so we can count all user messages
// for msgCount. The full file is already in memory from readFileSync so removing
// the break adds CPU parse time only — acceptable for typical session sizes.
// fsize comes from statSync (one call covers both mtime and size).
// starred is loaded from meta so it persists across restarts.
function loadSessions(meta) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const sessions = [];
  if (!fs.existsSync(base)) return sessions;

  for (const proj of fs.readdirSync(base)) {
    const projPath = path.join(base, proj);
    if (!safePath(projPath, base)) continue;
    try { if (!fs.statSync(projPath).isDirectory()) continue; } catch { continue; }

    for (const fname of fs.readdirSync(projPath)) {
      if (!fname.endsWith('.jsonl')) continue;
      const id = fname.slice(0, -6);
      if (!isUUID(id)) continue;
      const fpath = path.join(projPath, fname);
      if (!safePath(fpath, base)) continue;

      // Single statSync gives us both mtime and fsize — no extra syscall
      let mtime, fsize;
      try { const st = fs.statSync(fpath); mtime = st.mtimeMs; fsize = st.size; } catch { continue; }

      let cwd = null, title = null, msgCount = 0;
      try {
        for (const line of fs.readFileSync(fpath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (!cwd && d.cwd) cwd = d.cwd;
            if (d.type === 'user') {
              msgCount++;  // count every user turn
              if (!title) {
                const ct = d.message?.content;
                if (Array.isArray(ct)) {
                  for (const ch of ct) if (ch.type === 'text' && ch.text?.trim()) { title = ch.text.trim().replace(/\n/g, ' ').slice(0, 80); break; }
                } else if (typeof ct === 'string' && ct.trim()) title = ct.trim().replace(/\n/g, ' ').slice(0, 80);
              }
            }
          } catch {}
        }
      } catch {}

      if (!cwd) continue;
      sessions.push({
        id, cwd, fpath, fsize,
        title:    title || '(no messages)',
        tag:      meta[id]?.tag     || null,
        starred:  meta[id]?.starred || false,  // persisted star state
        msgCount,
        mtime, date: new Date(mtime),
      });
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

// ─── Preview Loading (reads max 64KB — avoids loading full multi-MB files) ───
const previewCache = new Map();
function loadPreview(session) {
  if (previewCache.has(session.id)) return previewCache.get(session.id);
  const msgs = [];
  try {
    const fd  = fs.openSync(session.fpath, 'r');
    let buf, n;
    try { buf = Buffer.alloc(65536); n = fs.readSync(fd, buf, 0, buf.length, 0); }
    finally { fs.closeSync(fd); }
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== 'user' && d.type !== 'assistant') continue;
        const ct = d.message?.content || d.content;
        let text = '';
        if (Array.isArray(ct)) { for (const ch of ct) if (ch.type === 'text' && ch.text?.trim()) { text = ch.text.trim(); break; } }
        else if (typeof ct === 'string') text = ct.trim();
        if (text) msgs.push({ role: d.type, text });
        if (msgs.length >= 6) break;
      } catch {}
    }
  } catch {}
  previewCache.set(session.id, msgs);
  return msgs;
}

// ─── Clipboard ────────────────────────────────────────────────────────────────
// Uses spawnSync with `input` option — pipes text directly to pbcopy/xclip stdin.
// No shell involved so no injection risk even if the UUID contained special chars
// (it can't — UUID_RE enforces hex+hyphens only — but defense-in-depth is good).
function copyToClipboard(text) {
  try {
    if (process.platform === 'darwin') {
      spawnSync('pbcopy', [], { input: text });
    } else {
      const r = spawnSync('xclip', ['-selection', 'clipboard'], { input: text });
      if (r.error) spawnSync('xsel', ['--clipboard', '--input'], { input: text });
    }
    return true;
  } catch { return false; }
}

// ─── Auto-update check ────────────────────────────────────────────────────────
// Runs async in background — never blocks the TUI.
// Only calls back if the latest npm version differs from ours.
// 5s timeout prevents hanging on slow networks.
function checkUpdate(onResult) {
  const current = require('../package.json').version;
  execFile('npm', ['view', 'claude-hist', 'version'], { timeout: 5000 }, (err, stdout) => {
    if (err) return;
    const latest = stdout.trim();
    if (latest && latest !== current) onResult(latest);
  });
}

// ─── Formatting ───────────────────────────────────────────────────────────────
const shortPath  = p  => p.replace(os.homedir(), '~');
const stripAnsi  = s  => s.replace(/\x1b\[[0-9;]*m/g, '');
const truncate   = (s, n) => !s || n <= 0 ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;
const padTo      = (s, n) => s + ' '.repeat(Math.max(0, n - stripAnsi(s).length));
const fillTo     = (s, n) => { const v = stripAnsi(s).length; return s + ' '.repeat(Math.max(0, n - v)); };

// S/M/L indicator based on file size — gives instant sense of session depth
// <50KB = small (few exchanges), <500KB = medium, ≥500KB = large (deep session)
function sizeLabel(fsize) {
  if (fsize < 50000)  return c.dim('S');
  if (fsize < 500000) return c.yellow('M');
  return c.red('L');
}

function dateColor(mtime) {
  const d = (Date.now() - mtime) / 86400000;
  return d < 1 ? c.green : d < 3 ? c.yellow : d < 14 ? c.orange : c.gray;
}
function fmtDate(date) {
  const d = (Date.now() - date) / 86400000;
  if (d < 1)   return 'today ' + date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  if (d < 2)   return 'yesterday';
  if (d < 7)   return `${Math.floor(d)}d ago`;
  if (d < 365) return date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
function wrapText(text, w) {
  if (w <= 0) return [truncate(text, 1)];
  const out = []; let cur = '';
  for (const word of text.split(' ')) {
    const safe = truncate(word, w);
    if (cur.length + safe.length + 1 > w) { if (cur) out.push(cur); cur = safe; }
    else cur = cur ? cur + ' ' + safe : safe;
  }
  if (cur) out.push(cur);
  return out;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ROWS = 8;

// ─── Filter + Sort ────────────────────────────────────────────────────────────
// Replaces the old doFilter — now handles favorites filter and sort mode too.
// filterFavs narrows to starred sessions only.
// sortBy='project' sorts alphabetically by cwd then by mtime within each project.
// sortBy='date' preserves the default mtime-desc order from loadSessions.
function applyFilters(sessions, query, filterFavs, sortBy) {
  let result = filterFavs ? sessions.filter(s => s.starred) : sessions.slice();
  if (query) {
    const ql = query.toLowerCase();
    result = result.filter(s =>
      s.title.toLowerCase().includes(ql) ||
      s.cwd.toLowerCase().includes(ql) ||
      (s.tag && s.tag.toLowerCase().includes(ql))
    );
  }
  // 'date-desc' = default (sessions already in mtime-desc order from loadSessions)
  // 'date-asc'  = reverse: oldest sessions first
  // 'project'   = alphabetical by cwd, then mtime-desc within each project
  if (sortBy === 'date-asc')  result.sort((a, b) => a.mtime - b.mtime);
  if (sortBy === 'project')   result.sort((a, b) => a.cwd.localeCompare(b.cwd) || b.mtime - a.mtime);
  return result;
}

// ─── Display items (flat / grouped) ──────────────────────────────────────────
function buildItems(filtered, grouped) {
  if (!grouped) return filtered.map(s => ({ type: 's', s }));
  const groups = new Map();
  for (const s of filtered) { if (!groups.has(s.cwd)) groups.set(s.cwd, []); groups.get(s.cwd).push(s); }
  const out = [];
  for (const [cwd, ss] of groups) {
    out.push({ type: 'h', cwd, count: ss.length });
    for (const s of ss) out.push({ type: 's', s });
  }
  return out;
}

// ─── Row renderer ─────────────────────────────────────────────────────────────
// Row layout (non-selected):
//   [2sp][star/·][1sp][S/M/L][2sp][date×18][1sp][proj×38 or ''][label]
//   Prefix width: 7 + 18 + 1 + 38 = 64 (flat) or 7 + 18 + 1 = 26 (grouped)
//   Title truncated to W-64 (flat) or less (grouped).
// Selected row is all plain text then wrapped in c.sel() — ANSI codes inside
// get overridden by the selection highlight so we use plain chars for sizing.
function renderRow(s, isSel, grouped, W, skipPerms) {
  const dc      = dateColor(s.mtime);
  const dateStr = fmtDate(s.date);

  if (isSel) {
    // Build as plain text so prefix.length correctly measures visual width.
    // c.sel() wraps the whole thing so inner colors are irrelevant here.
    const starStr = s.starred ? '★ ' : '  ';
    const sizeStr = (s.fsize < 50000 ? 'S' : s.fsize < 500000 ? 'M' : 'L') + ' ';
    const prefix  = `  ▶ ${starStr}${sizeStr}${stripAnsi(dateStr).padEnd(16)} ${grouped ? '' : truncate(shortPath(s.cwd), 28).padEnd(30)}${s.tag ? `[${s.tag}] ` : ''}${skipPerms ? '[dangerously-skip-permissions] ' : ''}`;
    const titleRoom = Math.max(0, W - prefix.length);
    return c.sel((prefix + truncate(s.title, titleRoom)).padEnd(W));
  }

  const star  = s.starred ? c.yellow('★') : c.dim('·');
  const size  = sizeLabel(s.fsize);
  const date  = padTo(dc(dateStr), 18);
  const proj  = grouped ? '' : padTo(c.cyan(truncate(shortPath(s.cwd), 28)), 38);
  // W-64 for flat, less for grouped — constants match the prefix widths above
  const label = s.tag
    ? `${c.magenta(`[${s.tag}]`)} ${c.white(truncate(s.title, W - 72))}`
    : c.white(truncate(s.title, W - 64));
  return `  ${star} ${size}  ${date} ${proj}${label}`;
}

// ─── List pane ────────────────────────────────────────────────────────────────
function renderList(sessions, filtered, sel, offset, query, grouped, W, mode, tagInput,
                    skipPerms, filterFavs, sortBy, statusMsg, updateAvailable, delTarget, searchMode) {
  const hr  = c.gray('─'.repeat(W));
  const out = [];

  out.push('');
  out.push(`  ${c.purple(c.bold('◆  Claude Session Picker'))}  ${c.gray('v' + require('../package.json').version)}`);
  out.push('');
  // Search mode (after pressing /): cursor visible, hint shown
  // Normal mode with query: query shown dimly, '/ to edit' hint
  // Normal mode empty: just the '/ to search' hint
  if (searchMode) {
    out.push(`  ${c.cyan('❯')} ${c.bold(c.cyan('Search'))}  ${c.white(query)}${c.cyan('█')}  ${c.dim('Esc=done')}`);
  } else if (query) {
    out.push(`  ${c.cyan('❯')} ${c.bold('Search')}  ${c.white(query)}  ${c.dim('/ to edit')}`);
  } else {
    out.push(`  ${c.gray('❯')} ${c.dim('Search')}  ${c.dim('press / to search')}`);
  }
  out.push('');

  // Status bar: total · match · group · sort · [favs] · [skip-perms warning]
  const statTotal = c.gray(`${sessions.length} sessions`);
  const statMatch = filtered.length !== sessions.length ? c.yellow(`${filtered.length} match`) : c.gray('all');
  const statGroup = grouped ? c.cyan('[grouped]') : c.dim('[flat]');
  const statSort  = sortBy === 'date-asc' ? c.cyan('[oldest first]') : sortBy === 'project' ? c.cyan('[by project]') : c.dim('[newest first]');
  let statLine = `  ${statTotal}  ${c.gray('·')}  ${statMatch}  ${c.gray('·')}  ${statGroup}  ${c.gray('·')}  ${statSort}`;
  if (filterFavs) statLine += `  ${c.gray('·')}  ${c.yellow('[★ favs only]')}`;
  if (skipPerms)  statLine += `  ${c.gray('·')}  ${c.red('⚠ dangerously-skip-permissions ON')}`;
  out.push(statLine);

  out.push(hr);
  // Column header — 7 chars prefix matches row layout (star + size columns)
  out.push(c.dim(`  ★ #  ${'DATE'.padEnd(16)} ${grouped ? '' : 'PROJECT'.padEnd(30) + ' '}TITLE`));
  out.push(hr);

  if (filtered.length === 0) {
    out.push('');
    out.push(`  ${c.yellow('⚠')}  ${c.dim(filterFavs ? 'No starred sessions.' : 'No sessions match.')}`);
  } else {
    const items = buildItems(filtered, grouped);

    let selVisRow = 0, si = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type === 's') { if (si === sel) { selVisRow = i; break; } si++; }
    }
    let dispOffset = grouped
      ? Math.max(0, Math.min(selVisRow - 1, items.length - ROWS))
      : offset;

    let rendered = 0;
    for (let i = dispOffset; i < items.length && rendered < ROWS; i++) {
      const item = items[i];
      if (item.type === 'h') {
        out.push(`  ${c.cyan(c.bold(truncate(shortPath(item.cwd), W - 12)))}  ${c.gray(`(${item.count})`)}`);
      } else {
        const filtIdx = filtered.indexOf(item.s);
        out.push(renderRow(item.s, filtIdx === sel, grouped, W, skipPerms));
      }
      rendered++;
    }

    if (!grouped && filtered.length > ROWS) {
      const pct    = Math.round(((offset + ROWS) / filtered.length) * 100);
      const filled = Math.round(pct / 10);
      const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
      out.push('');
      out.push(`  ${c.gray(`[${bar}] ${offset + 1}–${Math.min(offset + ROWS, filtered.length)} of ${filtered.length}`)}`);
    }
  }

  out.push('');

  // Footer — mode-aware prompts, two-line key hints in normal mode
  if (mode === 'del') {
    out.push(`  ${c.red('⚠  Delete this session?')}  ${c.bold('[y]')}es  ${c.bold('[n]')}o`);
  } else if (mode === 'bulkdel') {
    // delTarget is a cwd string — count from base sessions so we tell the user
    // exactly how many files will be removed, not just the filtered count
    const count = sessions.filter(s => s.cwd === delTarget).length;
    out.push(`  ${c.red(`⚠  Delete ALL ${count} sessions in this project?`)}  ${c.bold('[y]')}es  ${c.bold('[n]')}o`);
  } else if (mode === 'tag') {
    out.push(`  ${c.cyan('⬧  Tag:')} ${c.white(tagInput)}${c.cyan('█')}  ${c.dim('Enter=save  Esc=cancel')}`);
  } else if (statusMsg) {
    // Transient 1.5s message (copy confirmation, etc.) replaces the key hints
    out.push(`  ${c.green('✓')} ${c.white(statusMsg)}`);
  } else {
    // Two-line footer so all keys fit without overflowing narrow terminals
    out.push(c.dim(`  ${c.bold('↑↓')} nav  ${c.bold('PgUp/Dn')} jump  ${c.bold('Enter')} open  ${c.bold('p')} preview  ${c.bold('f')} star  ${c.bold('*')} favs  ${c.bold('c')} copy-id  ${c.bold('o')} ${sortBy === 'date-asc' ? c.cyan('oldest first') : 'newest↔oldest'}`));
    out.push(c.dim(`  ${c.bold('d')} del  ${c.bold('D')} bulk-del  ${c.bold('t')} tag  ${c.bold('g')} group  ${c.bold('s')} ${skipPerms ? c.red('dangerously-skip-permissions ON') : 'dangerously-skip-permissions'}  ${c.bold('Esc')} quit`));
  }

  // Update notification — shown as an extra line when a newer npm version exists
  if (updateAvailable) {
    out.push(`  ${c.yellow(`✦ Update available: v${updateAvailable}  →  npm install -g claude-hist`)}`);
  }
  out.push('');

  return out.map(l => fillTo(l, W));
}

// ─── Preview pane ─────────────────────────────────────────────────────────────
// Added msgCount to the header so users know how deep the session went before
// deciding to open it. Exact count from loadSessions (full file scan).
function renderPreview(session, W) {
  if (!session) return [];
  const hr  = c.gray('─'.repeat(W));
  const out = [];

  out.push('');
  // Show total message count alongside "Preview" heading
  out.push(` ${c.bold(c.purple('Preview'))}  ${c.gray(`${session.msgCount} msg${session.msgCount !== 1 ? 's' : ''}`)}`);
  out.push('');
  out.push(` ${c.cyan(truncate(shortPath(session.cwd), W - 2))}`);
  if (session.tag) out.push(` ${c.magenta(`[${session.tag}]`)}`);
  if (session.starred) out.push(` ${c.yellow('★ starred')}`);
  out.push(hr);

  const msgs = loadPreview(session);
  if (!msgs.length) {
    out.push('');
    out.push(` ${c.dim('(no messages)')}`);
  } else {
    for (const m of msgs) {
      out.push('');
      out.push(` ${m.role === 'user' ? c.green('You') : c.cyan('Claude')}`);
      const lines = wrapText(m.text.replace(/\n+/g, ' ').trim(), W - 3);
      for (const l of lines.slice(0, 4)) out.push(` ${c.dim(truncate(l, W - 2))}`);
      if (lines.length > 4) out.push(` ${c.gray('…')}`);
    }
  }

  return out.map(l => fillTo(truncate(stripAnsi(l), W), W));
}

// ─── Full frame ───────────────────────────────────────────────────────────────
function render(sessions, filtered, sel, offset, query, grouped, mode, tagInput,
                showPreview, skipPerms, filterFavs, sortBy, statusMsg, updateAvailable, delTarget, searchMode) {
  const W     = process.stdout.columns || 120;
  const preW  = showPreview ? Math.min(48, Math.floor(W * 0.37)) : 0;
  const listW = showPreview ? W - preW - 1 : W;

  const listLines = renderList(sessions, filtered, sel, offset, query, grouped, listW, mode, tagInput,
                               skipPerms, filterFavs, sortBy, statusMsg, updateAvailable, delTarget, searchMode);
  const prevLines = showPreview ? renderPreview(filtered[sel] || null, preW) : [];
  const total     = Math.max(listLines.length, prevLines.length);
  const div       = c.gray('│');

  const out = [];
  for (let i = 0; i < total; i++) {
    const l = listLines[i] || ' '.repeat(listW);
    const p = prevLines[i] || ' '.repeat(preW);
    out.push(showPreview ? l + div + p : l);
  }
  return out.join('\n');
}

// ─── --list mode ──────────────────────────────────────────────────────────────
function listMode(sessions) {
  const tty = process.stdout.isTTY;
  const col = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  console.log('');
  console.log(`  ${col('1', 'DATE'.padEnd(16))} ${col('1', 'PROJECT'.padEnd(30))} ${col('1', 'MSGS'.padEnd(6))} ${col('1', 'TITLE')}`);
  console.log('  ' + '─'.repeat(106));
  for (const s of sessions) {
    const d    = (Date.now() - s.mtime) / 86400000;
    const code = d < 1 ? '92' : d < 3 ? '33' : d < 14 ? '38;5;208' : '90';
    const date  = col(code, fmtDate(s.date).padEnd(16));
    const proj  = col('96', truncate(shortPath(s.cwd), 30).padEnd(30));
    const msgs  = col('90', String(s.msgCount).padEnd(6));
    const star  = s.starred ? col('33', '★ ') : '  ';
    const title = truncate(s.tag ? `[${s.tag}] ${s.title}` : s.title, 50);
    console.log(`  ${date} ${proj} ${msgs} ${star}${title}`);
    if (process.argv.includes('--ids')) console.log(`  ${col('90', s.id)}`);
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const meta    = loadMeta();
  let allSess   = loadSessions(meta);

  // --here: filter to sessions whose cwd matches the current working directory.
  // Useful when you run `chist` from inside a project — shows only that project's sessions.
  if (process.argv.includes('--here')) {
    allSess = allSess.filter(s => s.cwd === process.cwd());
    if (!allSess.length) { console.log(c.yellow(`No sessions found in ${process.cwd()}`)); process.exit(0); }
  }

  // --project <path>: same as --here but explicit path, usable from anywhere.
  const projIdx = process.argv.indexOf('--project');
  if (projIdx !== -1 && process.argv[projIdx + 1]) {
    const projPath = path.resolve(process.argv[projIdx + 1]);
    allSess = allSess.filter(s => s.cwd === projPath);
    if (!allSess.length) { console.log(c.yellow(`No sessions found for ${projPath}`)); process.exit(0); }
  }

  if (process.argv.includes('--list')) { listMode(allSess); process.exit(0); }

  if (!process.stdout.isTTY) {
    console.error('Run in an interactive terminal, or use --list for plain output.');
    process.exit(1);
  }
  if (!allSess.length) { console.log(c.yellow('No sessions found.')); process.exit(0); }

  let sessions       = allSess;
  let query          = '';
  let searchMode     = false;   // true = '/' was pressed, all keys go to search
  let filterFavs     = false;
  let sortBy         = 'date-desc';     // 'date-desc' | 'date-asc' | 'project'
  let filtered       = applyFilters(sessions, query, filterFavs, sortBy);
  let sel            = 0;
  let offset         = 0;
  let grouped        = false;
  let showPreview    = false;
  let skipPerms      = false;
  let mode           = 'normal';        // 'normal' | 'del' | 'bulkdel' | 'tag'
  let tagInput       = '';
  let delTarget      = null;            // session object (del) or cwd string (bulkdel)
  let statusMsg      = '';              // transient feedback (copy confirmation etc.)
  let statusTimer    = null;
  let updateAvailable = null;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H');

  const redraw = () => {
    const out = render(sessions, filtered, sel, offset, query, grouped, mode, tagInput,
                       showPreview, skipPerms, filterFavs, sortBy, statusMsg, updateAvailable, delTarget, searchMode);
    // \x1b[K clears each line to end-of-line, \x1b[J clears everything below
    // the last written line — prevents ghost lines when results shrink
    process.stdout.write('\x1b[H' + out.split('\n').map(l => l + '\x1b[K').join('\n') + '\x1b[J');
  };
  const cleanup = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  function doResume(s) {
    cleanup();
    const args = ['--resume', s.id];
    if (skipPerms) args.push('--dangerously-skip-permissions');
    console.log(`\n${c.green('✓')} ${c.bold('Resuming')}  ${c.white(truncate(s.title, 60))}`);
    console.log(c.dim(`  dir      ${s.cwd}`));
    console.log(c.dim(`  session  ${s.id}`));
    if (skipPerms) console.log(c.red(`  ⚠ --dangerously-skip-permissions enabled`));
    console.log('');
    const child = spawn('claude', args, { cwd: s.cwd, stdio: 'inherit' });
    child.on('error', err => {
      console.error(err.code === 'ENOENT' ? c.yellow('⚠  `claude` not found in PATH.') : 'Error: ' + err.message);
      process.exit(1);
    });
    child.on('exit', code => process.exit(code || 0));
  }

  function doDelete(s) {
    try { fs.unlinkSync(s.fpath); } catch {}
    sessions = sessions.filter(x => x !== s);
    filtered = applyFilters(sessions, query, filterFavs, sortBy);
    sel      = Math.min(sel, Math.max(0, filtered.length - 1));
    offset   = Math.min(offset, Math.max(0, filtered.length - ROWS));
    previewCache.delete(s.id);
    delete meta[s.id]; saveMeta(meta);
    mode = 'normal'; delTarget = null;
  }

  // Bulk delete — removes all sessions from the given cwd.
  // deletes from the base `sessions` array, not just filtered, so the project
  // is fully cleared even if some sessions were hidden by a search filter.
  function doBulkDelete(cwd) {
    const toDelete = sessions.filter(s => s.cwd === cwd);
    for (const s of toDelete) {
      try { fs.unlinkSync(s.fpath); } catch {}
      previewCache.delete(s.id);
      delete meta[s.id];
    }
    saveMeta(meta);
    sessions = sessions.filter(s => s.cwd !== cwd);
    filtered = applyFilters(sessions, query, filterFavs, sortBy);
    sel    = Math.min(sel, Math.max(0, filtered.length - 1));
    offset = Math.min(offset, Math.max(0, filtered.length - ROWS));
    mode = 'normal'; delTarget = null;
  }

  function doSaveTag(s, tag) {
    s.tag = tag.trim() || null;
    if (s.tag) meta[s.id] = { ...(meta[s.id] || {}), tag: s.tag };
    else { if (meta[s.id]) { delete meta[s.id].tag; if (!Object.keys(meta[s.id]).length) delete meta[s.id]; } }
    saveMeta(meta);
    previewCache.delete(s.id);
    mode = 'normal'; tagInput = '';
  }

  // Star toggle — persisted in cresume-meta.json under the same key as tags.
  // Using the existing meta structure avoids a new file.
  function doToggleStar(s) {
    s.starred = !s.starred;
    if (s.starred) meta[s.id] = { ...(meta[s.id] || {}), starred: true };
    else { if (meta[s.id]) { delete meta[s.id].starred; if (!Object.keys(meta[s.id]).length) delete meta[s.id]; } }
    saveMeta(meta);
  }

  // Copy session ID to clipboard and show a 1.5s confirmation in the footer.
  // statusTimer clears the message and redraws after the delay.
  function doCopyId(s) {
    const ok = copyToClipboard(s.id);
    statusMsg = ok ? 'session ID copied to clipboard' : 'copy failed — install pbcopy (mac) or xclip (linux)';
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusMsg = ''; redraw(); }, 1500);
  }

  redraw();

  // Check for updates in the background — non-blocking.
  // If a newer version exists, updateAvailable gets set and the footer shows a hint.
  checkUpdate(v => { updateAvailable = v; redraw(); });

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    // ── delete confirm ──
    if (mode === 'del') {
      if (key.name === 'y') doDelete(delTarget);
      else { mode = 'normal'; delTarget = null; }
      redraw(); return;
    }

    // ── bulk delete confirm ──
    if (mode === 'bulkdel') {
      if (key.name === 'y') doBulkDelete(delTarget);
      else { mode = 'normal'; delTarget = null; }
      redraw(); return;
    }

    // ── tag input ──
    if (mode === 'tag') {
      if (key.name === 'return')      doSaveTag(filtered[sel], tagInput);
      else if (key.name === 'escape') { mode = 'normal'; tagInput = ''; }
      else if (key.name === 'backspace') tagInput = tagInput.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) tagInput += str;
      redraw(); return;
    }

    // ── search mode (press / to enter, Esc to exit) ──
    // All printable keys go to the query — no hotkey conflicts.
    if (searchMode) {
      if (key.name === 'escape' || key.name === 'return') {
        searchMode = false;  // exit search mode, keep query as active filter
      } else if (key.name === 'backspace') {
        query = query.slice(0, -1);
        filtered = applyFilters(sessions, query, filterFavs, sortBy);
        sel = 0; offset = 0;
      } else if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) {
        query += str;
        filtered = applyFilters(sessions, query, filterFavs, sortBy);
        sel = 0; offset = 0;
      }
      redraw(); return;
    }

    // ── normal mode ──
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
    // Esc in normal mode: clear search if active, otherwise quit
    if (key.name === 'escape') {
      if (query) { query = ''; filtered = applyFilters(sessions, query, filterFavs, sortBy); sel = 0; offset = 0; }
      else { cleanup(); process.exit(0); }
      redraw(); return;
    }
    if (key.name === 'return' && filtered.length) { doResume(filtered[sel]); return; }

    if (key.name === 'up') {
      if (sel > 0) { sel--; if (sel < offset) offset--; }
    } else if (key.name === 'down') {
      if (sel < filtered.length - 1) { sel++; if (sel >= offset + ROWS) offset++; }
    } else if (key.name === 'pageup') {
      sel    = Math.max(0, sel - ROWS);
      offset = Math.max(0, offset - ROWS);
    } else if (key.name === 'pagedown') {
      sel    = Math.min(filtered.length - 1, sel + ROWS);
      offset = Math.min(Math.max(0, filtered.length - ROWS), offset + ROWS);
    } else if (str === '/') {
      searchMode = true;  // enter search mode — all subsequent keys go to query
    } else if (str === 'd' && filtered.length) {
      mode = 'del'; delTarget = filtered[sel];
    } else if (str === 'D' && filtered.length) {
      mode = 'bulkdel'; delTarget = filtered[sel].cwd;
    } else if (str === 't' && filtered.length) {
      mode = 'tag'; tagInput = filtered[sel].tag || '';
    } else if (key.name === 'g') {
      grouped = !grouped;
    } else if (key.name === 'p') {
      showPreview = !showPreview;
    } else if (key.name === 's') {
      skipPerms = !skipPerms;
    } else if (key.name === 'f' && filtered.length) {
      doToggleStar(filtered[sel]);
    } else if (str === '*') {
      filterFavs = !filterFavs;
      filtered = applyFilters(sessions, query, filterFavs, sortBy);
      sel = 0; offset = 0;
    } else if (key.name === 'c' && filtered.length) {
      doCopyId(filtered[sel]);
    } else if (key.name === 'o') {
      sortBy = sortBy === 'date-desc' ? 'date-asc' : 'date-desc';
      grouped = false;
      filtered = applyFilters(sessions, query, filterFavs, sortBy);
      sel = 0; offset = 0;
    } else if (key.name === 'backspace') {
      // Allow backspace outside search mode for quick query corrections
      query = query.slice(0, -1);
      filtered = applyFilters(sessions, query, filterFavs, sortBy);
      sel = 0; offset = 0;
    }

    redraw();
  });

  process.stdout.on('resize', redraw);

  for (const sig of ['SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }
}

main();
