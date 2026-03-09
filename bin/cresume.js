#!/usr/bin/env node
'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { spawn } = require('child_process');
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
const META_FILE = path.join(os.homedir(), '.claude', 'cresume-meta.json');
const loadMeta  = () => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; } };
const saveMeta  = m  => fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2), 'utf8');

// ─── Session Loading ──────────────────────────────────────────────────────────
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
      if (!isUUID(id)) continue;                           // skip non-UUID filenames
      const fpath = path.join(projPath, fname);
      if (!safePath(fpath, base)) continue;                // no path traversal

      let mtime; try { mtime = fs.statSync(fpath).mtimeMs; } catch { continue; }

      let cwd = null, title = null;
      try {
        for (const line of fs.readFileSync(fpath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (!cwd && d.cwd) cwd = d.cwd;
            if (!title && d.type === 'user') {
              const ct = d.message?.content;
              if (Array.isArray(ct)) {
                for (const ch of ct) if (ch.type === 'text' && ch.text?.trim()) { title = ch.text.trim().replace(/\n/g, ' ').slice(0, 80); break; }
              } else if (typeof ct === 'string' && ct.trim()) title = ct.trim().replace(/\n/g, ' ').slice(0, 80);
            }
            if (cwd && title) break;
          } catch {}
        }
      } catch {}

      if (!cwd) continue;
      sessions.push({ id, cwd, fpath, title: title || '(no messages)', tag: meta[id]?.tag || null, mtime, date: new Date(mtime) });
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

// ─── Formatting ───────────────────────────────────────────────────────────────
const shortPath  = p  => p.replace(os.homedir(), '~');
const stripAnsi  = s  => s.replace(/\x1b\[[0-9;]*m/g, '');
const truncate   = (s, n) => !s || n <= 0 ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;
const padTo      = (s, n) => s + ' '.repeat(Math.max(0, n - stripAnsi(s).length));
const fillTo     = (s, n) => { const v = stripAnsi(s).length; return s + ' '.repeat(Math.max(0, n - v)); };

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
    const safe = truncate(word, w); // single word longer than width gets truncated
    if (cur.length + safe.length + 1 > w) { if (cur) out.push(cur); cur = safe; }
    else cur = cur ? cur + ' ' + safe : safe;
  }
  if (cur) out.push(cur);
  return out;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ROWS         = 8;
const PREVIEW_MIN  = 110; // min terminal width to show preview pane

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
function renderRow(s, isSel, grouped, W, skipPerms) {
  const dc      = dateColor(s.mtime);
  const dateStr = fmtDate(s.date);
  const label   = s.tag ? `${c.magenta(`[${s.tag}]`)} ${c.white(truncate(s.title, W - 70))}` : c.white(truncate(s.title, W - 62));

  if (isSel) {
    const skipTag = skipPerms ? `${c.red('[dangerously-skip-permissions]')} ` : '';
    const prefix = `  ▶  ${stripAnsi(dateStr).padEnd(16)} ${grouped ? '' : truncate(shortPath(s.cwd), 28).padEnd(30)}${s.tag ? `[${s.tag}] ` : ''}${skipPerms ? '[dangerously-skip-permissions] ' : ''}`;
    const titleRoom = Math.max(0, W - stripAnsi(prefix).length);
    const raw = `  ▶  ${stripAnsi(dateStr).padEnd(16)} ${grouped ? '' : truncate(shortPath(s.cwd), 28).padEnd(30)}${s.tag ? `[${s.tag}] ` : ''}${skipPerms ? '[dangerously-skip-permissions] ' : ''}` + truncate(s.title, titleRoom);
    return c.sel(raw.padEnd(W));
  }
  const date = padTo(dc(dateStr), grouped ? 18 : 18);
  const proj = grouped ? '' : padTo(c.cyan(truncate(shortPath(s.cwd), 28)), 38);
  return `  ${c.gray('·')}  ${date} ${proj}${label}`;
}

// ─── List pane ────────────────────────────────────────────────────────────────
function renderList(sessions, filtered, sel, offset, query, grouped, W, mode, tagInput, skipPerms) {
  const hr  = c.gray('─'.repeat(W));
  const out = [];

  out.push('');
  out.push(`  ${c.purple(c.bold('◆  Claude Session Picker'))}  ${c.gray('v' + require('../package.json').version)}`);
  out.push('');
  out.push(`  ${c.cyan('❯')} ${c.bold('Search')}  ${query ? c.white(query) + c.cyan('█') : c.dim('type to filter…')}`);
  out.push('');

  const statTotal   = c.gray(`${sessions.length} sessions`);
  const statMatch   = filtered.length !== sessions.length ? c.yellow(`${filtered.length} match`) : c.gray('all');
  const statGroup   = grouped ? c.cyan('[grouped]') : c.dim('[flat]');
  const statSkip    = skipPerms ? c.red('⚠ dangerously-skip-permissions ON') : '';
  out.push(`  ${statTotal}  ${c.gray('·')}  ${statMatch}  ${c.gray('·')}  ${statGroup}${skipPerms ? `  ${c.gray('·')}  ${statSkip}` : ''}`);
  out.push(hr);
  out.push(c.dim(`     ${'DATE'.padEnd(16)} ${grouped ? '' : 'PROJECT'.padEnd(30) + ' '}TITLE`));
  out.push(hr);

  if (filtered.length === 0) {
    out.push('');
    out.push(`  ${c.yellow('⚠')}  ${c.dim('No sessions match.')}`);
  } else {
    const items = buildItems(filtered, grouped);

    // find visual row of selected session in items
    let selVisRow = 0, si = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type === 's') { if (si === sel) { selVisRow = i; break; } si++; }
    }
    // compute display offset to keep selection visible
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

    // progress bar (flat mode only)
    if (!grouped && filtered.length > ROWS) {
      const pct = Math.round(((offset + ROWS) / filtered.length) * 100);
      const filled = Math.round(pct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      out.push('');
      out.push(`  ${c.gray(`[${bar}] ${offset + 1}–${Math.min(offset + ROWS, filtered.length)} of ${filtered.length}`)}`);
    }
  }

  out.push('');
  if (mode === 'del') {
    out.push(`  ${c.red('⚠  Delete this session?')}  ${c.bold('[y]')}es  ${c.bold('[n]')}o`);
  } else if (mode === 'tag') {
    out.push(`  ${c.cyan('⬧  Tag:')} ${c.white(tagInput)}${c.cyan('█')}  ${c.dim('Enter=save  Esc=cancel')}`);
  } else {
    out.push(c.dim(`  ${c.bold('↑↓')} nav  ${c.bold('PgUp/Dn')} jump  ${c.bold('Enter')} open  ${c.bold('p')} preview  ${c.bold('d')} del  ${c.bold('t')} tag  ${c.bold('g')} group  ${c.bold('s')} ${skipPerms ? c.red('dangerously-skip-permissions ON') : 'dangerously-skip-permissions'}  ${c.bold('Esc')} quit`));
  }
  out.push('');

  return out.map(l => fillTo(l, W));
}

// ─── Preview pane ─────────────────────────────────────────────────────────────
function renderPreview(session, W) {
  if (!session) return [];
  const hr  = c.gray('─'.repeat(W));
  const out = [];

  out.push('');
  out.push(` ${c.bold(c.purple('Preview'))}`);
  out.push('');
  out.push(` ${c.cyan(truncate(shortPath(session.cwd), W - 2))}`);
  if (session.tag) out.push(` ${c.magenta(`[${session.tag}]`)}`);
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

  // Hard-clip each line to preW to prevent overflow
  return out.map(l => fillTo(truncate(stripAnsi(l), W), W));
}

// ─── Full frame ───────────────────────────────────────────────────────────────
function render(sessions, filtered, sel, offset, query, grouped, mode, tagInput, showPreview, skipPerms) {
  const W       = process.stdout.columns || 120;
  const preview = showPreview;
  const preW    = preview ? Math.min(48, Math.floor(W * 0.37)) : 0;  // capped at 48 cols
  const listW   = preview ? W - preW - 1 : W;

  const listLines = renderList(sessions, filtered, sel, offset, query, grouped, listW, mode, tagInput, skipPerms);
  const prevLines = preview ? renderPreview(filtered[sel] || null, preW) : [];
  const total     = Math.max(listLines.length, prevLines.length);
  const div       = c.gray('│');

  const out = [];
  for (let i = 0; i < total; i++) {
    const l = listLines[i] || ' '.repeat(listW);
    const p = prevLines[i] || ' '.repeat(preW);
    out.push(preview ? l + div + p : l);
  }
  return out.join('\n');
}

// ─── Filter ───────────────────────────────────────────────────────────────────
function doFilter(sessions, q) {
  if (!q) return sessions;
  const ql = q.toLowerCase();
  return sessions.filter(s =>
    s.title.toLowerCase().includes(ql) ||
    s.cwd.toLowerCase().includes(ql) ||
    (s.tag && s.tag.toLowerCase().includes(ql))
  );
}

// ─── --list mode ──────────────────────────────────────────────────────────────
function listMode(sessions) {
  const tty = process.stdout.isTTY;
  const col = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  console.log('');
  // pad plain strings BEFORE applying color so padEnd counts visible chars only
  console.log(`  ${col('1', 'DATE'.padEnd(16))} ${col('1', 'PROJECT'.padEnd(30))} ${col('1', 'TITLE')}`);
  console.log('  ' + '─'.repeat(100));
  for (const s of sessions) {
    const d    = (Date.now() - s.mtime) / 86400000;
    const code = d < 1 ? '92' : d < 3 ? '33' : d < 14 ? '38;5;208' : '90';
    const date = col(code, fmtDate(s.date).padEnd(16));
    const proj = col('96', truncate(shortPath(s.cwd), 30).padEnd(30));
    const title = truncate(s.tag ? `[${s.tag}] ${s.title}` : s.title, 55);
    console.log(`  ${date} ${proj} ${title}`);
    if (process.argv.includes('--ids')) console.log(`  ${col('90', s.id)}`);
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const meta     = loadMeta();
  const allSess  = loadSessions(meta);

  if (process.argv.includes('--list')) { listMode(allSess); process.exit(0); }

  if (!process.stdout.isTTY) {
    console.error('Run in an interactive terminal, or use --list for plain output.');
    process.exit(1);
  }
  if (!allSess.length) { console.log(c.yellow('No sessions found.')); process.exit(0); }

  let sessions  = allSess;
  let query     = '';
  let filtered  = sessions;
  let sel       = 0;
  let offset    = 0;
  let grouped     = false;
  let showPreview = false;
  let skipPerms   = false;
  let mode        = 'normal';  // 'normal' | 'del' | 'tag'
  let tagInput  = '';
  let delTarget = null;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H');

  const redraw  = () => {
    const out = render(sessions, filtered, sel, offset, query, grouped, mode, tagInput, showPreview, skipPerms);
    process.stdout.write('\x1b[H' + out.split('\n').map(l => l + '\x1b[K').join('\n'));
  };
  const cleanup = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.stdin.setRawMode(false); process.stdin.pause(); };

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
    filtered = doFilter(sessions, query);
    sel      = Math.min(sel, Math.max(0, filtered.length - 1));
    offset   = Math.min(offset, Math.max(0, filtered.length - ROWS));
    previewCache.delete(s.id);
    delete meta[s.id]; saveMeta(meta);
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

  redraw();

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    // ── delete confirm ──
    if (mode === 'del') {
      if (key.name === 'y') doDelete(delTarget);
      else { mode = 'normal'; delTarget = null; }
      redraw(); return;
    }

    // ── tag input ──
    if (mode === 'tag') {
      if (key.name === 'return')    doSaveTag(filtered[sel], tagInput);
      else if (key.name === 'escape') { mode = 'normal'; tagInput = ''; }
      else if (key.name === 'backspace') tagInput = tagInput.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) tagInput += str;
      redraw(); return;
    }

    // ── normal ──
    if ((key.ctrl && key.name === 'c') || key.name === 'escape') { cleanup(); process.exit(0); }
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
    } else if (key.name === 'd' && filtered.length) {
      mode = 'del'; delTarget = filtered[sel];
    } else if (key.name === 't' && filtered.length) {
      mode = 'tag'; tagInput = filtered[sel].tag || '';
    } else if (key.name === 'g') {
      grouped = !grouped;
    } else if (key.name === 'p') {
      showPreview = !showPreview;
    } else if (key.name === 's') {
      skipPerms = !skipPerms;
    } else if (key.name === 'backspace') {
      query = query.slice(0, -1);
      filtered = doFilter(sessions, query); sel = 0; offset = 0;
    } else if (str && !key.ctrl && !key.meta && str.length === 1 && str.charCodeAt(0) >= 32) {
      query += str;
      filtered = doFilter(sessions, query); sel = 0; offset = 0;
    }

    redraw();
  });

  process.stdout.on('resize', redraw);

  // Restore terminal on unexpected exit signals
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }
}

main();
