// Fuzzy importer: turns an invoice / quote / list (PDF, XLSX, CSV, text) into candidate item rows.
// Nothing here writes to the database - results are shown to the user for review first.

const CUR = /^(?:aed|dhs?|dirhams?|usd|gbp|eur|us\$|\$|£|€)$/i;

// ---------- numbers ----------
function parseNum(tok) {
  let t = String(tok).trim()
    .replace(/^[(\[]|[)\]]$/g, '')
    .replace(/\/-$/, '')
    .replace(/^(aed|dhs?|usd|gbp|eur|us\$|\$|£|€)\s*/i, '')
    .replace(/\s*(aed|dhs?)$/i, '');
  if (!t || /%/.test(t)) return null;
  let mult = 1;
  if (/^\d+(\.\d+)?k$/i.test(t)) { mult = 1000; t = t.slice(0, -1); }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (!/^\d+(\.\d+)?$/.test(t)) return null;
  if (/^\d{7,}$/.test(t)) return null; // phone numbers, TRNs, IDs
  const n = parseFloat(t) * mult;
  return Number.isFinite(n) ? n : null;
}

// Peel numbers (and currency words / dashes / percentages) off the end of a line.
// single=true keeps only the last number (free-form lists); otherwise keeps the whole trailing run (invoice tables).
function splitTrailing(line, single) {
  const toks = line.trim().split(/\s+/);
  const nums = [];
  let i = toks.length;
  while (i > 0) {
    const t = toks[i - 1];
    if (CUR.test(t) || (/^[-–—:=]$/.test(t) && nums.length) || /^\d+(\.\d+)?%$/.test(t)) { i--; continue; }
    const n = parseNum(t);
    if (n === null) break;
    if (single && nums.length) break;
    nums.unshift(n); i--;
  }
  const desc = toks.slice(0, i).join(' ').replace(/[\s\-–—:=]+$/, '');
  return { desc, nums };
}

const letters = s => (String(s).match(/[A-Za-z؀-ۿ]/g) || []).length;

// ---------- dates ----------
function parseDate(s) {
  s = String(s || '').trim();
  let m;
  const mon = x => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(x.slice(0, 3).toLowerCase()) + 1;
  const iso = (y, mo, d) => {
    if (y < 100) y += 2000;
    if (!mo || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/(\d{1,2})[\s\-\/.]+([A-Za-z]{3,9})[\s\-\/.,]+(\d{2,4})/))) return iso(+m[3], mon(m[2]), +m[1]);
  if ((m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/))) return iso(+m[3], mon(m[1]), +m[2]);
  if ((m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/))) return iso(+m[3], +m[2], +m[1]); // day first (UAE/UK)
  return null;
}

function findDate(lines) {
  const head = lines.slice(0, 45);
  for (const l of head) {
    const m = l.match(/(?:invoice|issue|quote|quotation|document)\s*date\s*[:\-]?\s*(.{6,30})/i);
    if (m) { const d = parseDate(m[1]); if (d) return d; }
  }
  for (const l of head) {
    if (/due\s*date/i.test(l)) continue;
    const m = l.match(/\bdate\s*[:\-]\s*(.{6,30})/i);
    if (m) { const d = parseDate(m[1]); if (d) return d; }
  }
  return null;
}

// ---------- document-level facts ----------
function findVendor(lines) {
  const co = /\b(llc|l\.l\.c|fzco|fze|fz-?llc|ltd|limited|inc|est|establishment|trading|contracting|interiors?|enterprises?|company|co\.|gmbh|pllc|services|maintenance|decor)\b/i;
  for (const l of lines.slice(0, 25)) {
    if (co.test(l) && letters(l) > 6 && l.length < 90 && !/bill\s*to|ship\s*to/i.test(l)) {
      return l.replace(/\s+(balance due|amount due|total).*$/i, '').trim();
    }
  }
  for (const l of lines) {
    const m = l.match(/account\s*(?:holder|name)\s*:\s*(.+)$/i);
    if (m) return m[1].trim().replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase());
  }
  return '';
}

function findRef(lines) {
  const re = /(?:#|\b(?:invoice|quote|quotation|estimate|proposal|ref(?:erence)?)\s*(?:no\.?|number|#)?)\s*[:#]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{2,})/i;
  for (const l of lines.slice(0, 30)) {
    const m = l.match(re);
    if (m) return m[1];
  }
  return '';
}

function findDocType(lines) {
  const head = lines.slice(0, 30).join(' ').toLowerCase();
  if (/\b(tax\s+)?invoice\b/.test(head)) return 'invoice';
  if (/\breceipt\b/.test(head)) return 'receipt';
  if (/\b(quotation|quote|estimate|proposal|boq|bill of quantit)/.test(head)) return 'quote';
  return '';
}

// ---------- guessing room / category / priority ----------
const ROOMS = [
  [/\b(shower|bath(room)?|toilet|wc|powder room|washroom|vanity)\b/i, 'Bathroom'],
  [/\b(kitchen|hob|pantry|counter ?top|kitchen counter)\b/i, 'Kitchen'],
  [/\b(balcon(y|ies)|terrace|patio|railing)\b/i, 'Balcony'],
  [/\b(master|bed(room)?|wardrobe|closet)\b/i, 'Bedroom'],
  [/\b(living|lounge|sofa|tv unit|dining)\b/i, 'Living area'],
  [/\b(garden|pergola|lawn|outdoor|pool)\b/i, 'Garden'],
  [/\b(laundry|utility)\b/i, 'Laundry'],
  [/\b(maid'?s?|study|office)\b/i, 'Study'],
  [/\b(entrance|hall(way)?|corridor|door)\b/i, 'Entrance'],
  [/\b(roof|attic|garage|parking)\b/i, 'Exterior']
];
const CATS = [
  [/\b(silicon\w*|grout\w*|seal\w*|waterproof\w*|caulk\w*)\b/i, 'Sealing'],
  [/\b(remov\w*|demoli\w*|dispos\w*|strip\w*)\b/i, 'Demolition'],
  [/\b(plumb\w*|pipe\w*|leak\w*|tap|mixer|shower ?head|toilet|drain\w*|heater)\b/i, 'Plumbing'],
  [/\b(gypsum|ceiling|partition|false ceiling|cornice)\b/i, 'Ceiling'],
  [/\b(paint\w*|plaster\w*)\b/i, 'Painting'],
  [/\b(glass|glazing|window|mirror)\b/i, 'Glazing'],
  [/\b(electric\w*|socket\w*|switch\w*|wiring|light(s|ing)?|lamp|spotlight\w*)\b/i, 'Electrical'],
  [/\b(floor\w*|tile\w*|tiling|parquet|marble|carpet)\b/i, 'Flooring'],
  [/\b(a\/?c|air ?con\w*|hvac|ventilat\w*|exhaust)\b/i, 'HVAC'],
  [/\b(sofa|table|chair\w*|bed|desk|shelv\w*|cabinet\w*|wardrobe|furniture|rug)\b/i, 'Furniture'],
  [/\b(curtain\w*|blind\w*|shutter\w*)\b/i, 'Soft furnishings'],
  [/\b(clean\w*|pest|fumigat\w*)\b/i, 'Cleaning'],
  [/\b(door\w*|lock\w*|handle\w*|joinery|carpent\w*)\b/i, 'Joinery']
];
function guess(table, text) { for (const [re, v] of table) if (re.test(text)) return v; return ''; }
const guessPriority = t => /\b(leak\w*|damp\w*|mou?ld|broken|burst|unsafe|safety|urgent|fire|essential|must|critical)\b/i.test(t) ? 'Essential' : '';

function alignRoom(room, existing) {
  if (!room) return '';
  const r = room.toLowerCase();
  const hit = (existing || []).find(e => { const x = e.toLowerCase(); return x === r || x.includes(r) || r.includes(x); });
  return hit || room;
}

// ---------- row factory ----------
function shorten(desc) {
  const t0 = String(desc || '').replace(/\s+/g, ' ').trim();
  const t = t0.charAt(0).toUpperCase() + t0.slice(1);
  if (t.length <= 80) return { title: t.replace(/[.:;,\s]+$/, ''), rest: '' };
  const cut = t.slice(0, 80);
  const sp = cut.lastIndexOf(' ');
  return { title: cut.slice(0, sp > 40 ? sp : 80).replace(/[,.;:\s]+$/, '') + '…', rest: t };
}

function makeRow(o, ctx) {
  const { title, rest } = shorten(o.desc || o.title);
  const hay = `${o.desc || ''} ${o.title || ''}`;
  return {
    title: o.title ? o.title : title,
    notes: o.notes || (o.title ? '' : rest),
    room: alignRoom(o.room || guess(ROOMS, hay), ctx.rooms),
    category: o.category || guess(CATS, hay),
    priority: o.priority || guessPriority(hay) || '',
    status: o.status || '',
    vendor: o.vendor || '',
    nums: o.nums || null,
    amount: o.amount ?? null,
    budget: o.budget ?? null,
    quote: o.quote ?? null,
    spent: o.spent ?? null,
    explicit: !!o.explicit
  };
}

// ---------- text / PDF-lines extraction ----------
const NOISE = /^(sub\s*-?\s*total|total|grand\s*total|balance|amount\s*due|vat|tax|discount|round(ing)?|paid|payment|deposit|advance|bank|iban|swift|bic|account|trn|tel|phone|mob|mobile|email|e-mail|www|date|due|terms|invoice|tax invoice|quotation|quote|page|bill\s*to|ship\s*to|ref|po\s*box|address|thanks|thank you|notes?|signature|authori[sz]ed|prepared|validity|subject)\b/i;
const ROOMWORDS = new Set(('kitchen bathroom bathrooms bath shower toilet wc balcony terrace patio garden living lounge dining bedroom bedrooms master guest kids kid study office laundry utility entrance hall hallway corridor roof garage maid maids room area outdoor outdoors indoor general other misc whole house villa apartment exterior interior first second third main upstairs downstairs the').split(' '));
const isRoomHeading = l => { const w = l.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean); return w.length > 0 && w.length <= 3 && w.every(x => ROOMWORDS.has(x)); };
const STOP = /^(sub\s*-?\s*total|total\b|grand\s*total|balance\s*due|amount\s*due|tax\s*summary|vat\s*summary|notes?\b|terms)/i;
const isHeader = l => /\b(item|description|particulars|scope|details|work)\b/i.test(l) && /\b(qty|quantity|rate|amount|price|total|cost|unit)\b/i.test(l);
const TOTALLINE = /^(?:sub\s*-?\s*total|total|grand\s*total|balance(?:\s*due)?|amount\s*due|total\s*due|net\s*total|total\s*amount)\b/i;

function extractFromLines(lines, opts) {
  const { pdf, rooms } = opts;
  const ctx = { rooms };
  const totals = [];
  lines.forEach(l => { if (TOTALLINE.test(l)) splitTrailing(l, false).nums.forEach(n => totals.push(n)); });

  const rows = [];
  const h = lines.findIndex(isHeader);

  if (h >= 0) {
    // Table mode: invoice / quotation with columns. Wrapped descriptions are glued back together.
    const body = [];
    for (let i = h + 1; i < lines.length; i++) {
      const l = lines[i];
      if (STOP.test(l) && body.length) break;
      if (isHeader(l)) continue;
      body.push(l);
    }
    const parsed = body.map(l => ({ l, ...splitTrailing(l, false) }));
    const maxLen = Math.max(0, ...parsed.map(p => (letters(p.desc) >= 3 ? p.nums.length : 0)));
    let cur = null;
    for (const p of parsed) {
      const isRow = letters(p.desc) >= 3 && p.nums.length >= (maxLen >= 2 ? 2 : 1);
      if (isRow) {
        let d = p.desc;
        const idx = d.match(/^(\d{1,3})[.)]?\s+(.*)$/);
        if (idx && +idx[1] === rows.length + 1) d = idx[2];
        cur = { desc: d, nums: p.nums };
        rows.push(cur);
      } else if (cur && letters(p.l) >= 2 && !NOISE.test(p.l)) {
        cur.desc += ' ' + p.l.replace(/(?:\s+\d+(?:\.\d+)?%)+\s*$/, '').trim(); // drop tax-% column text
      }
    }
    return finish(rows.map(r => makeRow({ desc: r.desc, nums: r.nums }, ctx)), totals, 'table');
  }

  // Flat mode: one item per line, amount at the end (or none, for pasted wish-lists)
  let room = '';
  for (let raw of lines) {
    let l = raw.trim();
    if (!l) continue;
    const head = l.match(/^(?:#{1,4}\s*)?([A-Za-z][A-Za-z &\/'-]{1,30}?)\s*:?$/);
    if (!pdf && head && !splitTrailing(l, true).nums.length && (/:$/.test(l) || /^#/.test(l) || isRoomHeading(head[1]))) {
      room = alignRoom(head[1].trim().replace(/^./, c => c.toUpperCase()), rooms); continue;
    }
    l = l.replace(/^\s*(?:[-*•·▪◦]|\d{1,3}[.)]|\[[ xX]?\])\s+/, '');
    if (NOISE.test(l) || /@|www\./i.test(l)) continue;
    const { desc, nums } = splitTrailing(l, true);
    if (letters(desc) < 3) continue;
    if (pdf && !nums.length) continue;
    if (!nums.length && (/\d{7,}/.test(l) || (opts.skip && opts.skip.has(l.toLowerCase())))) continue; // phone numbers, vendor name lines
    rows.push(makeRow({ desc, nums: nums.length ? nums : null, amount: nums.length ? nums[0] : null, room: room || undefined }, ctx));
  }
  return finish(rows, totals, 'flat');
}

function finish(rows, totals, mode) {
  let maxK = 1, k = 1;
  const withNums = rows.filter(r => r.nums && r.nums.length);
  if (withNums.length) {
    maxK = Math.min(4, Math.max(...withNums.map(r => r.nums.length)));
    for (let kk = 1; kk <= maxK; kk++) {
      const sum = withNums.reduce((s, r) => s + (r.nums[r.nums.length - kk] ?? 0), 0);
      if (totals.some(t => Math.abs(t - sum) < 0.01)) { k = kk; break; }
    }
    rows.forEach(r => { if (r.nums && r.nums.length) r.amount = r.nums[Math.max(0, r.nums.length - k)]; });
  }
  return { rows, totals: [...new Set(totals)], maxK, k, layout: mode };
}

// ---------- CSV / spreadsheet matrices ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const cnt = c => (first.match(new RegExp(c === '\t' ? '\\t' : '\\' + c, 'g')) || []).length;
  const delim = [',', ';', '\t'].sort((a, b) => cnt(b) - cnt(a))[0];
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out.filter(r => r.some(c => String(c).trim() !== ''));
}

const SYN = {
  title: /^(item|items|title|name|task|project|work|scope|line item|requirement|what)$/,
  desc: /^(description|details?|particulars|specification|spec)$/,
  room: /^(room|area|location|space|zone|where)$/,
  category: /^(category|type|trade|discipline|group)$/,
  priority: /^(priority|importance|need|urgency)$/,
  status: /^(status|stage|state)$/,
  vendor: /^(vendor|supplier|contractor|company|from|payee|paid to)$/,
  budget: /^(budget|est|estimate|estimated|estimated cost|planned|allocation)$/,
  quote: /^(quote|quoted|quotation|quote amount|quoted price)$/,
  spent: /^(spent|paid|actual|actuals|spend|cost to date)$/,
  amount: /^(amount|price|cost|total|value|aed|line total|net|gross|rate)$/,
  qty: /^(qty|quantity)$/,
  notes: /^(notes?|comments?|remarks?|ideas?)$/
};
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const cellNum = v => (typeof v === 'number' ? v : (v == null || String(v).trim() === '' ? null : parseNum(String(v).trim())));
const cellStr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());

function mapPriority(v) {
  const t = String(v || '').toLowerCase();
  if (!t) return '';
  if (/essential|must|critical|urgent|high|necessar|required|need|p1|1\b/.test(t)) return 'Essential';
  if (/important|medium|should|p2|2\b|normal/.test(t)) return 'Important';
  if (/nice|low|optional|wish|later|want|p3|3\b/.test(t)) return 'Nice to have';
  return '';
}
function mapStatus(v) {
  const t = String(v || '').toLowerCase();
  if (!t) return '';
  if (/done|complete|finish|closed/.test(t)) return 'Done';
  if (/progress|ongoing|started|doing|underway/.test(t)) return 'In progress';
  if (/approved|accepted|confirm|ordered|awarded/.test(t)) return 'Approved';
  if (/quot/.test(t)) return 'Getting quotes';
  if (/hold|pause|postpone|defer/.test(t)) return 'On hold';
  if (/idea|todo|to do|wish|new|open|planned/.test(t)) return 'Idea';
  return '';
}

function fromMatrix(m, { rooms }) {
  const ctx = { rooms };
  if (!m.length) return finish([], [], 'table');
  let hi = m.findIndex(r => r.filter(c => Object.values(SYN).some(re => re.test(norm(c)))).length >= 2);
  const rows = [];
  if (hi >= 0) {
    const col = {};
    m[hi].forEach((c, i) => { const n = norm(c); for (const [k, re] of Object.entries(SYN)) if (re.test(n) && col[k] === undefined) { col[k] = i; break; } });
    if (col.title === undefined && col.desc !== undefined) { col.title = col.desc; delete col.desc; }
    if (col.title === undefined) col.title = m[hi].findIndex((c, i) => !Object.values(col).includes(i));
    for (const r of m.slice(hi + 1)) {
      const g = k => (col[k] === undefined ? '' : r[col[k]]);
      const title = cellStr(g('title'));
      if (letters(title) < 2 || /^(sub\s*-?\s*total|total|grand total)\b/i.test(title)) continue;
      const budget = cellNum(g('budget')), quote = cellNum(g('quote')), spent = cellNum(g('spent'));
      const amount = cellNum(g('amount'));
      const extra = col.desc !== undefined ? cellStr(g('desc')) : '';
      rows.push(makeRow({
        title: title.length > 90 ? undefined : title,
        desc: title.length > 90 ? title : undefined,
        notes: [extra, cellStr(g('notes'))].filter(Boolean).join('\n'),
        room: cellStr(g('room')) || undefined, category: cellStr(g('category')) || undefined,
        priority: mapPriority(g('priority')), status: mapStatus(g('status')), vendor: cellStr(g('vendor')),
        amount, budget, quote, spent,
        explicit: budget != null || quote != null || spent != null
      }, ctx));
    }
  } else {
    // No header: first text cell is the item, last number is the amount
    for (const r of m) {
      const cells = r.map(cellStr);
      const title = cells.find(c => letters(c) >= 3 && cellNum(c) === null);
      const nums = cells.map(cellNum).filter(n => n !== null);
      if (!title || /^(sub\s*-?\s*total|total)\b/i.test(title)) continue;
      rows.push(makeRow({ desc: title, amount: nums.length ? nums[nums.length - 1] : null }, ctx));
    }
  }
  return finish(rows, [], 'table');
}

// ---------- PDF text with layout ----------
let pdfjsP;
function loadPdfjs() { // pdfjs prints harmless canvas-polyfill warnings on load; text extraction doesn't need them
  if (!pdfjsP) {
    const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {};
    pdfjsP = import('pdfjs-dist/legacy/build/pdf.mjs').finally(() => { console.warn = w; console.log = l; });
  }
  return pdfjsP;
}
async function pdfLines(buffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(i => i.str && i.str.trim() !== '')
      .map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const groups = []; let cur = null;
    for (const it of items) {
      if (cur && Math.abs(cur.y - it.y) <= 3) cur.items.push(it);
      else { cur = { y: it.y, items: [it] }; groups.push(cur); }
    }
    for (const g of groups) {
      g.items.sort((a, b) => a.x - b.x);
      let out = '', prevEnd = null;
      for (const it of g.items) {
        if (prevEnd !== null && it.x - prevEnd > it.h * 0.15) out += ' ';
        out += it.s; prevEnd = it.x + it.w;
      }
      const t = out.replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

// ---------- public API ----------
async function parseFile(buffer, filename, opts = {}) {
  const rooms = opts.rooms || [];
  const ext = (String(filename).match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  const warnings = [];

  if (ext === 'pdf' || buffer.slice(0, 5).toString() === '%PDF-') {
    const lines = await pdfLines(buffer);
    if (lines.join('').length < 20) {
      return { source: 'pdf', docType: '', vendor: '', ref: '', date: null, rows: [], totals: [], maxK: 1, k: 1,
        warnings: ['No readable text in this PDF - it looks like a scan or photo. Add the items by hand, or send a text-based PDF / Excel / CSV.'] };
    }
    const r = extractFromLines(lines, { pdf: true, rooms });
    const docType = findDocType(lines);
    if (!r.rows.length) warnings.push('Could not find any line items in this PDF.');
    return { source: 'pdf', docType, vendor: findVendor(lines), ref: findRef(lines), date: findDate(lines), ...r, warnings };
  }
  if (ext === 'xlsx') {
    const readXlsx = require('read-excel-file/node');
    const m = await readXlsx(buffer);
    const r = fromMatrix(m, { rooms });
    if (!r.rows.length) warnings.push('Could not find any items in this spreadsheet.');
    return { source: 'xlsx', docType: '', vendor: '', ref: '', date: null, ...r, warnings };
  }
  if (ext === 'xls' || ext === 'numbers' || ext === 'docx' || ext === 'doc') {
    throw new Error(`.${ext} files aren't supported - save as .xlsx, .csv or PDF and try again.`);
  }
  if (['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'].includes(ext)) {
    throw new Error("Photos can't be read automatically. Use a PDF, Excel or CSV file, or paste the text.");
  }
  const text = buffer.toString('utf8');
  if (ext === 'csv' || ext === 'tsv') {
    const r = fromMatrix(parseCsv(text), { rooms });
    if (!r.rows.length) warnings.push('Could not find any items in this file.');
    return { source: 'csv', docType: '', vendor: '', ref: '', date: null, ...r, warnings };
  }
  return parseText(text, { rooms });
}

function parseText(text, opts = {}) {
  const rooms = opts.rooms || [];
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/\t/g, ' ').trimEnd());
  const sniff = lines.filter(l => l.trim()).slice(0, 3).join('\n');
  // Pasted spreadsheet / CSV (several delimiters on the first lines) -> treat as a table
  if (/[\t;]/.test(text) && sniff.split(/[\t;]/).length > 2) {
    const r = fromMatrix(parseCsv(text.replace(/\t/g, '\t')), { rooms });
    if (r.rows.length) return { source: 'text', docType: '', vendor: '', ref: '', date: null, ...r, warnings: [] };
  }
  if (/^[^\n]*,[^\n]*,/.test(sniff) && /(item|title|name|task|description).*(,|;).*(budget|amount|price|cost|quote)/i.test(sniff)) {
    const r = fromMatrix(parseCsv(text), { rooms });
    if (r.rows.length) return { source: 'text', docType: '', vendor: '', ref: '', date: null, ...r, warnings: [] };
  }
  const clean = lines.map(l => l.trim());
  const vendor = findVendor(clean);
  const r = extractFromLines(clean, { pdf: false, rooms, skip: new Set(vendor ? [vendor.toLowerCase()] : []) });
  return { source: 'text', docType: findDocType(clean), vendor, ref: findRef(clean), date: findDate(clean), ...r,
    warnings: r.rows.length ? [] : ['Could not find any items in that text.'] };
}

module.exports = { parseFile, parseText, parseNum, parseDate, _test: { splitTrailing, parseCsv } };
