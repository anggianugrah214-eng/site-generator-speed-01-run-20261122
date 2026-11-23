// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly what makefun-site 1.0.0's
// build returns for the same input (the output tree as a JSON object of path -> text), byte for byte.
// It re-implements the reference pipeline (front matter, Markdown subset, template dialect, slug
// rule, report) with the same observable behaviour, but fused and allocation-light: the Markdown
// lexer renders in one pass, inline markup scans runs instead of escaping per character, and the
// template renderer reuses scope frames and joins fragments once.
//
// No dependencies, no I/O, no clock, no randomness: the output is a function of the input alone.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text

const AMP = '&amp;';
const LT = '&lt;';
const GT = '&gt;';
const QUOT = '&quot;';
const APOS = '&#39;';

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP = { '&': AMP, '<': LT, '>': GT, '"': QUOT, "'": APOS };

/** `text` with & < > " and ' escaped. Returns `text` itself when nothing needs escaping. */
function escapeHtml(text) {
  let out = '';
  let last = 0;
  ESCAPE_RE.lastIndex = 0;
  let m;
  while ((m = ESCAPE_RE.exec(text)) !== null) {
    if (m.index > last) out += text.slice(last, m.index);
    out += ESCAPE_MAP[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  if (last < text.length) out += text.slice(last);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, exactly as the reference computes it (NFKD, marks dropped, ...). */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();

/** The slug of `text`; an ASCII fast path, the reference algorithm otherwise. Pure: cached. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  let out;
  if (!ascii) {
    out = slugifySlow(text);
  } else {
    let s = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += String.fromCharCode(keep);
    }
    s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
    out = s === '' ? 'untitled' : s;
  }
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. Pure: cached. */
function longDate(date) {
  const hit = longDateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  longDateCache.set(date, out);
  return out;
}

/** Whether the code unit is JavaScript whitespace (\s): 0x09-0x0D, 0x20 and the Unicode spaces. */
function isSpaceCode(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? c === 32 || (c >= 9 && c <= 13) : isSpaceCode(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (
    rel !== '.' &&
    rel !== '..' &&
    !rel.startsWith('./') &&
    !rel.startsWith('../') &&
    !rel.includes('/./') &&
    !rel.includes('/../') &&
    !rel.endsWith('/.') &&
    !rel.endsWith('/..') &&
    !rel.includes('//') &&
    !rel.endsWith('/')
  ) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug opens on a letter or digit, never on "-"
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Line numbers count from 1 at the opening `---`.
 */
function parseFrontMatter(text) {
  const n = text.length;
  if (!text.startsWith('---') || (n !== 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // First pass: find the closing line (the reference reports "not closed" before any line error).
  let pos = n === 3 ? 3 : 4;
  let closePos = -1;
  let closeEnd = -1;
  while (pos < n) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? n : e;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closePos = pos;
      closeEnd = lineEnd;
      break;
    }
    pos = e === -1 ? n : e + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let lineNo = 2;
  while (pos < closePos) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? closePos : e;
    const line = text.slice(pos, lineEnd);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      let i = 0;
      while (i < line.length && isKeyChar(line.charCodeAt(i))) i++;
      if (i === 0 || line.charCodeAt(i) !== 58 || (i + 1 < line.length && line.charCodeAt(i + 1) !== 32)) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, i);
      let raw = i + 1 === line.length ? '' : line.slice(i + 2);
      let r = raw.length;
      while (r > 0) {
        const c = raw.charCodeAt(r - 1);
        if (c !== 32 && c !== 9) break;
        r--;
      }
      if (r !== raw.length) raw = raw.slice(0, r);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = e === -1 ? closePos : e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === n ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const LANG_CHAR = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** Whether the rest of `line` from `i` holds only spaces and tabs. */
function onlySpaceTab(line, i) {
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && LANG_CHAR(line.charCodeAt(i))) i++;
  return onlySpaceTab(line, i) ? line.slice(3, i) : null;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaceTab(line, 3);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  let i = depth;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth, text: line.slice(i, end) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  return onlySpaceTab(line, 3);
}

/**
 * A line's block kind, from its first character alone in the common case: 0 blank, 1 fence-open,
 * 2 heading, 3 thematic break, 4 anything else (a blockquote, list or paragraph line). A
 * paragraph ends at a line whose kind is not 4.
 */
function classify(line) {
  if (line.length === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line) ? 0 : 4;
  if (c0 === 96) return fenceOpen(line) !== null ? 1 : 4;
  if (c0 === 35) return headingOf(line) !== null ? 2 : 4;
  if (c0 === 45 || c0 === 42) return isHr(line) ? 3 : 4;
  return 4;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** Whether `c` is one of the characters a backslash escapes. */
function isEscapableCode(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

/** Whether the backslash run ending just before `j` (counted back to `from`) has odd length. */
function oddBackslashes(s, j, from) {
  let k = j - 1;
  let count = 0;
  while (k >= from && s.charCodeAt(k) === 92) {
    count++;
    k--;
  }
  return count % 2 === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (!oddBackslashes(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (oddBackslashes(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

const ESCAPE_ENTITY = { 38: AMP, 60: LT, 62: GT, 34: QUOT, 39: APOS };

/**
 * The characters inline markup reacts to. One regex scan finds the next of them, so plain runs
 * are copied whole instead of walked character by character. The regex is module-level and its
 * lastIndex is reset on entry and re-set after every recursive call, so the recursion below
 * cannot disturb the caller's scan.
 */
const SPECIAL = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let last = 0;
  SPECIAL.lastIndex = 0;
  let m;
  while ((m = SPECIAL.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < s.length && isEscapableCode(s.charCodeAt(i + 1))) {
        if (i > last) out += s.slice(last, i);
        // The escaped character is written escaped: ">" is both escapable and in the escape table.
        out += s.charCodeAt(i + 1) === 62 ? GT : s[i + 1];
        SPECIAL.lastIndex = i + 2;
        last = i + 2;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > last) out += s.slice(last, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        SPECIAL.lastIndex = j + 1;
        last = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > last) out += s.slice(last, i);
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          SPECIAL.lastIndex = j + 2;
          last = j + 2;
        } else {
          if (i > last) out += s.slice(last, i);
          out += '**';
          SPECIAL.lastIndex = i + 2;
          last = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > last) out += s.slice(last, i);
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        SPECIAL.lastIndex = j + 1;
        last = j + 1;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (i > last) out += s.slice(last, i);
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        SPECIAL.lastIndex = mm + 1;
        last = mm + 1;
      }
      continue;
    }
    const e = ESCAPE_ENTITY[c];
    if (e !== undefined) {
      if (i > last) out += s.slice(last, i);
      out += e;
      last = i + 1;
    }
  }
  if (last < s.length) out += s.slice(last);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    const e0 = src.indexOf('\n', pos);
    const lineEnd = e0 === -1 ? n : e0;
    const line = src.slice(pos, lineEnd);
    const next = e0 === -1 ? n : e0 + 1;
    const kind = classify(line);
    if (kind === 0) {
      pos = next;
      continue;
    }
    if (kind === 1) {
      const lang = fenceOpen(line);
      let code = '';
      let closed = false;
      pos = next;
      while (pos < n) {
        const e = src.indexOf('\n', pos);
        const le = e === -1 ? n : e;
        const l = src.slice(pos, le);
        if (fenceClose(l)) {
          closed = true;
          pos = e === -1 ? n : e + 1;
          break;
        }
        code += escapeHtml(l) + '\n';
        pos = e === -1 ? n : e + 1;
      }
      // An unclosed fence at the end of a source ending in "\n" holds one more empty line:
      // the reference splits the body into lines, and the trailing "\n" leaves a final "" line.
      if (!closed && n > 0 && src.charCodeAt(n - 1) === 10) code += '\n';
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      html += `<pre><code${cls}>${code}</code></pre>\n`;
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      const h = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      pos = next;
      continue;
    }
    if (kind === 3) {
      html += '<hr>\n';
      pos = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const lines = [line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1)];
      pos = next;
      while (pos < n) {
        const e = src.indexOf('\n', pos);
        const le = e === -1 ? n : e;
        const l = src.slice(pos, le);
        if (l.charCodeAt(0) !== 62) break;
        lines.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        pos = e === -1 ? n : e + 1;
      }
      const kept = [];
      for (let k = 0; k < lines.length; k++) {
        const t = trimLine(lines[k]);
        if (t !== '') kept.push(t);
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const c0 = line.charCodeAt(0);
    let ordered = false;
    let startNum = 1;
    let firstItem = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      firstItem = line.slice(2);
    } else {
      let d = 0;
      while (d < 9 && d < line.length && isDigit(line.charCodeAt(d))) d++;
      if (d > 0 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        startNum = Number(line.slice(0, d));
        firstItem = line.slice(d + 2);
      }
    }
    if (firstItem !== null) {
      const items = [[trimLine(firstItem)]];
      pos = next;
      while (pos < n) {
        const e = src.indexOf('\n', pos);
        const le = e === -1 ? n : e;
        const l = src.slice(pos, le);
        const nx = e === -1 ? n : e + 1;
        let m = null;
        if (ordered) {
          let d = 0;
          while (d < 9 && d < l.length && isDigit(l.charCodeAt(d))) d++;
          if (d > 0 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) m = l.slice(d + 2);
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          m = l.slice(2);
        }
        if (m !== null) {
          items.push([trimLine(m)]);
          pos = nx;
        } else {
          let sp = 0;
          while (sp < l.length && l.charCodeAt(sp) === 32) sp++;
          if (sp >= 2 && sp < l.length && !isSpaceCode(l.charCodeAt(sp))) {
            items[items.length - 1].push(trimLine(l));
            pos = nx;
          } else break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let listHtml = `${open}\n`;
      for (let k = 0; k < items.length; k++) listHtml += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      html += `${listHtml}</${tag}>\n`;
      continue;
    }
    const parts = [trimLine(line)];
    pos = next;
    while (pos < n) {
      const e = src.indexOf('\n', pos);
      const le = e === -1 ? n : e;
      const l = src.slice(pos, le);
      if (classify(l) !== 4) break;
      parts.push(trimLine(l));
      pos = e === -1 ? n : e + 1;
    }
    const p = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = p;
    html += `<p>${p}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in a value: an own property, else undefined (null is not an object here). */
function getProp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's nodes compiled to a function (S, C, D, __esc, __txt, __get, __truthy) returning its
 * rendered string. S is the build's one flat scope (a null-prototype object; a for loop writes its
 * bindings into it and restores what it shadows, so an include reads the same scope its caller
 * sees), C holds the compiled templates, D the include depth. Paths read straight off S (an
 * absent name reads undefined, exactly as a lookup that finds nothing does), then own properties
 * via __get. The code is generated from the parsed nodes only, after parsing has accepted the
 * template, so a template that does not parse never reaches the compiler.
 */
function pathExpr(path) {
  let e = `S[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `__get(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * The names a template's nodes read that no for loop inside the template binds, collected into
 * `out`. `bound` holds the names the lexically enclosing fors bind (a loop's variable and `loop`);
 * an include contributes the included template's free names (from `getFree`), less those bound
 * here. A name read is a path's first segment.
 */
function collectFree(nodes, bound, getFree, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'var':
      case 'raw':
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        break;
      case 'if':
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        collectFree(n.then, bound, getFree, out);
        if (n.else !== null) collectFree(n.else, bound, getFree, out);
        break;
      case 'for': {
        if (!bound.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        collectFree(n.body, b2, getFree, out);
        break;
      }
      case 'include': {
        const f = getFree(n.name);
        for (const x of f) if (!bound.has(x)) out.add(x);
        break;
      }
      // text reads nothing
    }
  }
  return out;
}

function genNodes(nodes, out, uid, info, bound) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(`__o+=${JSON.stringify(n.text)};`);
        break;
      case 'var':
        out.push(`__o+=__esc(__txt(${pathExpr(n.path)}));`);
        break;
      case 'raw':
        out.push(`__o+=__txt(${pathExpr(n.path)});`);
        break;
      case 'if': {
        out.push(`if(${n.not ? '!' : ''}__truthy(${pathExpr(n.path)})){`);
        genNodes(n.then, out, uid, info, bound);
        if (n.else !== null) {
          out.push('}else{');
          genNodes(n.else, out, uid, info, bound);
        }
        out.push('}');
        break;
      }
      case 'for': {
        const id = uid.n++;
        const name = JSON.stringify(n.name);
        out.push(`{const __xs${id}=${pathExpr(n.path)};if(Array.isArray(__xs${id})){`);
        out.push(`const __lp${id}={index:0,first:false,last:false,length:__xs${id}.length};`);
        out.push(`const __hn${id}=Object.hasOwn(S,${name}),__sn${id}=S[${name}];`);
        out.push(`const __hl${id}=Object.hasOwn(S,"loop"),__sl${id}=S.loop;S.loop=__lp${id};`);
        out.push(`for(let __k${id}=0;__k${id}<__xs${id}.length;__k${id}++){`);
        if (n.name !== 'loop') out.push(`S[${name}]=__xs${id}[__k${id}];`);
        out.push(`__lp${id}.index=__k${id}+1;__lp${id}.first=__k${id}===0;__lp${id}.last=__k${id}===__xs${id}.length-1;`);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        genNodes(n.body, out, uid, info, b2);
        out.push(`}if(__hn${id})S[${name}]=__sn${id};else delete S[${name}];`);
        out.push(`if(__hl${id})S.loop=__sl${id};else delete S.loop;}}`);
        break;
      }
      case 'include': {
        const id = uid.n++;
        const free = info.free.get(n.name);
        const cacheable =
          free !== undefined &&
          info.cacheable.has(n.name) &&
          ![...free].some((x) => bound.has(x));
        if (cacheable) {
          // This template reads only site, tags and recent, none of them shadowed here, so its
          // output at this depth is the same every time it is included: render once per build.
          out.push(
            `{if(D<${INCLUDE_DEPTH}){const __ck${id}=${JSON.stringify(n.name)}+":"+(D+1);let __cv${id}=C.cache.get(__ck${id});` +
              `if(__cv${id}===undefined){const __t${id}=C.templates.get(${JSON.stringify(n.name)});` +
              `if(__t${id}!==undefined){__cv${id}=__t${id}(S,C,D+1,__esc,__txt,__get,__truthy);C.cache.set(__ck${id},__cv${id});}}` +
              `if(__cv${id}!==undefined)__o+=__cv${id};}}`
          );
        } else {
          out.push(
            `{if(D<${INCLUDE_DEPTH}){const __t${id}=C.templates.get(${JSON.stringify(n.name)});if(__t${id}!==undefined)__o+=__t${id}(S,C,D+1,__esc,__txt,__get,__truthy);}}`
          );
        }
        break;
      }
    }
  }
}

function compileTemplate(nodes, info) {
  const out = ['let __o="";'];
  genNodes(nodes, out, { n: 0 }, info, new Set());
  out.push('return __o;');
  return new Function('S', 'C', 'D', '__esc', '__txt', '__get', '__truthy', out.join('\n'));
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const parsed = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Each template's free names (read, never bound by its own fors), transitively through its
  // includes, to a fixpoint. A template whose free names are only site, tags and recent reads
  // nothing that changes during a build, so an include of it may be rendered once and reused.
  const free = new Map();
  for (const name of parsed.keys()) free.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of parsed) {
      const f = collectFree(nodes, new Set(), (inc) => free.get(inc) ?? new Set(), new Set());
      const old = free.get(name);
      let grew = f.size !== old.size;
      if (!grew) for (const x of f) if (!old.has(x)) { grew = true; break; }
      if (grew) {
        free.set(name, f);
        changed = true;
      }
    }
  }
  const cacheable = new Set();
  for (const [name, f] of free) {
    let ok = true;
    for (const x of f) {
      if (x !== 'site' && x !== 'tags' && x !== 'recent') {
        ok = false;
        break;
      }
    }
    if (ok) cacheable.add(name);
  }
  const templates = new Map();
  const info = { free, cacheable };
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(nodes, info));
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const tags = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, links and pages as templates read them.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, cache: new Map() };
  // One scope per build, its page-specific keys reset on every render: a key left at undefined
  // reads exactly as an absent key does (lookup returns undefined either way), so a page render
  // never leaks `page` into an index render, and no scope is allocated per page. It has no
  // prototype, so a name no scope holds reads undefined rather than an inherited property.
  const scope = Object.create(null);
  scope.site = site;
  scope.tags = allTags;
  scope.recent = recent;
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    return fn(scope, ctx, 0, escapeHtml, textOf, getProp, truthy);
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const html = render('index', {
      posts: slice.map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.length - posts.length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
