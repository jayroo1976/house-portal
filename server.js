const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const { runBackup, status: backupStatus } = require('./backup');

const DATA = process.env.DATA_DIR || '/data';
const UPLOADS = path.join(DATA, 'uploads');
const CURRENCY = process.env.CURRENCY || 'AED';
const TITLE = process.env.APP_TITLE || 'House Projects';
const PORT = parseInt(process.env.PORT || '3000', 10);
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- users / auth ----------
// APP_USERS="James:password1,Wife:password2"
const USERS = {};
(process.env.APP_USERS || 'admin:changeme').split(',').forEach(p => {
  const i = p.indexOf(':');
  if (i > 0) USERS[p.slice(0, i).trim()] = p.slice(i + 1).trim();
});
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA, '.secret');
  if (fs.existsSync(f)) SECRET = fs.readFileSync(f, 'utf8');
  else { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const safeEq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
function makeToken(user) {
  const body = Buffer.from(JSON.stringify({ u: user, e: Date.now() + 90 * 864e5 })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(tok) {
  if (!tok) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig || !safeEq(sig, sign(body))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.e > Date.now() && USERS[o.u] !== undefined ? o.u : null; } catch { return null; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
const attempts = new Map();
function auth(req, res, next) {
  const u = readToken(cookies(req).sid);
  if (!u) return res.status(401).json({ error: 'auth' });
  req.user = u; next();
}

// ---------- db ----------
const db = new Database(path.join(DATA, 'house.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, room TEXT DEFAULT '', category TEXT DEFAULT '',
  priority TEXT DEFAULT 'Nice to have', status TEXT DEFAULT 'Idea', budget REAL DEFAULT 0,
  notes TEXT DEFAULT '', created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS quotes(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL, amount REAL DEFAULT 0, quote_date TEXT, status TEXT DEFAULT 'Received', notes TEXT DEFAULT '',
  created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS spend(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  vendor TEXT DEFAULT '', amount REAL NOT NULL, spend_date TEXT, notes TEXT DEFAULT '',
  created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'photo', filename TEXT NOT NULL, original TEXT, caption TEXT DEFAULT '',
  created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  body TEXT NOT NULL, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const PRIORITIES = ['Essential', 'Important', 'Nice to have'];
const STATUSES = ['Idea', 'Getting quotes', 'Approved', 'In progress', 'Done', 'On hold'];

const ITEM_SELECT = `
SELECT i.*,
 COALESCE((SELECT SUM(amount) FROM spend s WHERE s.item_id=i.id),0) AS spent,
 (SELECT amount FROM quotes q WHERE q.item_id=i.id AND q.status='Accepted' ORDER BY q.id DESC LIMIT 1) AS accepted_quote,
 (SELECT MIN(amount) FROM quotes q WHERE q.item_id=i.id AND q.status IN ('Received','Accepted') AND amount>0) AS lowest_quote,
 (SELECT COUNT(*) FROM quotes q WHERE q.item_id=i.id) AS quote_count,
 (SELECT COUNT(*) FROM files f WHERE f.item_id=i.id) AS file_count,
 (SELECT filename FROM files f WHERE f.item_id=i.id AND f.kind IN ('photo','idea') ORDER BY f.id LIMIT 1) AS cover
FROM items i`;

function listItems(filter = {}) {
  let rows = db.prepare(ITEM_SELECT + ' ORDER BY i.id').all();
  if (filter.priority) rows = rows.filter(r => r.priority === filter.priority);
  if (filter.status) rows = rows.filter(r => r.status === filter.status);
  if (filter.room) rows = rows.filter(r => r.room === filter.room);
  const po = p => PRIORITIES.indexOf(p);
  rows.sort((a, b) => po(a.priority) - po(b.priority) || a.id - b.id);
  return rows;
}
function summaryOf(rows) {
  const s = { items: rows.length, budget: 0, spent: 0, committed: 0, remaining: 0, byPriority: {} };
  PRIORITIES.forEach(p => s.byPriority[p] = { items: 0, budget: 0, spent: 0, committed: 0 });
  rows.forEach(r => {
    const committed = Math.max(r.accepted_quote ?? 0, r.spent);
    s.budget += r.budget; s.spent += r.spent; s.committed += committed;
    const b = s.byPriority[r.priority] || (s.byPriority[r.priority] = { items: 0, budget: 0, spent: 0, committed: 0 });
    b.items++; b.budget += r.budget; b.spent += r.spent; b.committed += committed;
  });
  s.remaining = s.budget - s.committed;
  return s;
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ title: TITLE, currency: CURRENCY, priorities: PRIORITIES, statuses: STATUSES, user: readToken(cookies(req).sid) }));

app.post('/api/login', (req, res) => {
  const ip = req.ip, n = attempts.get(ip) || { c: 0, t: Date.now() };
  if (Date.now() - n.t > 15 * 60e3) { n.c = 0; n.t = Date.now(); }
  if (n.c >= 10) return res.status(429).json({ error: 'Too many attempts, try later' });
  const { user, password } = req.body || {};
  const key = Object.keys(USERS).find(k => k.toLowerCase() === String(user || '').trim().toLowerCase());
  if (!key || !safeEq(String(password || ''), USERS[key])) { n.c++; attempts.set(ip, n); return res.status(401).json({ error: 'Wrong name or password' }); }
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${makeToken(key)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${90 * 86400}${secure}`);
  res.json({ user: key });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', auth);

// uploads (served only to logged-in users)
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg'))
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }
});
app.get('/files/:name', (req, res) => {
  if (!readToken(cookies(req).sid)) return res.status(401).end();
  const f = path.join(UPLOADS, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(f);
});

// items
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const oneOf = (v, arr, d) => arr.includes(v) ? v : d;
app.get('/api/items', (req, res) => { const rows = listItems(req.query); res.json({ items: rows, summary: summaryOf(listItems()), rooms: [...new Set(db.prepare("SELECT room FROM items WHERE room<>''").all().map(r => r.room))].sort() }); });
app.post('/api/items', (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) return res.status(400).json({ error: 'Title required' });
  const r = db.prepare('INSERT INTO items(title,room,category,priority,status,budget,notes,created_by) VALUES(?,?,?,?,?,?,?,?)')
    .run(b.title.trim(), (b.room || '').trim(), (b.category || '').trim(), oneOf(b.priority, PRIORITIES, 'Nice to have'), oneOf(b.status, STATUSES, 'Idea'), num(b.budget), b.notes || '', req.user);
  res.json({ id: r.lastInsertRowid });
});
app.get('/api/items/:id', (req, res) => {
  const id = +req.params.id;
  const item = db.prepare(ITEM_SELECT + ' WHERE i.id=?').get(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({
    item,
    quotes: db.prepare('SELECT * FROM quotes WHERE item_id=? ORDER BY amount').all(id),
    spend: db.prepare('SELECT * FROM spend WHERE item_id=? ORDER BY spend_date DESC, id DESC').all(id),
    files: db.prepare('SELECT * FROM files WHERE item_id=? ORDER BY id').all(id),
    comments: db.prepare('SELECT * FROM comments WHERE item_id=? ORDER BY id').all(id)
  });
});
app.put('/api/items/:id', (req, res) => {
  const b = req.body || {}, cur = db.prepare('SELECT * FROM items WHERE id=?').get(+req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE items SET title=?,room=?,category=?,priority=?,status=?,budget=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run((b.title ?? cur.title).trim() || cur.title, (b.room ?? cur.room).trim(), (b.category ?? cur.category).trim(),
      oneOf(b.priority, PRIORITIES, cur.priority), oneOf(b.status, STATUSES, cur.status), b.budget === undefined ? cur.budget : num(b.budget), b.notes ?? cur.notes, cur.id);
  res.json({ ok: true });
});
app.delete('/api/items/:id', (req, res) => {
  const files = db.prepare('SELECT filename FROM files WHERE item_id=?').all(+req.params.id);
  db.prepare('DELETE FROM items WHERE id=?').run(+req.params.id);
  files.forEach(f => fs.rmSync(path.join(UPLOADS, f.filename), { force: true }));
  res.json({ ok: true });
});

// quotes
app.post('/api/items/:id/quotes', (req, res) => {
  const b = req.body || {};
  if (!String(b.vendor || '').trim()) return res.status(400).json({ error: 'Vendor required' });
  const r = db.prepare('INSERT INTO quotes(item_id,vendor,amount,quote_date,status,notes,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(+req.params.id, b.vendor.trim(), num(b.amount), b.quote_date || new Date().toISOString().slice(0, 10), oneOf(b.status, ['Received', 'Accepted', 'Rejected', 'Expired'], 'Received'), b.notes || '', req.user);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/quotes/:id', (req, res) => {
  const b = req.body || {}, q = db.prepare('SELECT * FROM quotes WHERE id=?').get(+req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const status = oneOf(b.status, ['Received', 'Accepted', 'Rejected', 'Expired'], q.status);
  db.transaction(() => {
    if (status === 'Accepted') db.prepare("UPDATE quotes SET status='Received' WHERE item_id=? AND status='Accepted' AND id<>?").run(q.item_id, q.id);
    db.prepare('UPDATE quotes SET vendor=?,amount=?,quote_date=?,status=?,notes=? WHERE id=?')
      .run((b.vendor ?? q.vendor).trim(), b.amount === undefined ? q.amount : num(b.amount), b.quote_date ?? q.quote_date, status, b.notes ?? q.notes, q.id);
    if (status === 'Accepted') db.prepare("UPDATE items SET status='Approved',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('Idea','Getting quotes')").run(q.item_id);
  })();
  res.json({ ok: true });
});
app.delete('/api/quotes/:id', (req, res) => { db.prepare('DELETE FROM quotes WHERE id=?').run(+req.params.id); res.json({ ok: true }); });

// spend
app.post('/api/items/:id/spend', (req, res) => {
  const b = req.body || {};
  if (!num(b.amount)) return res.status(400).json({ error: 'Amount required' });
  const r = db.prepare('INSERT INTO spend(item_id,vendor,amount,spend_date,notes,created_by) VALUES(?,?,?,?,?,?)')
    .run(+req.params.id, (b.vendor || '').trim(), num(b.amount), b.spend_date || new Date().toISOString().slice(0, 10), b.notes || '', req.user);
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/spend/:id', (req, res) => { db.prepare('DELETE FROM spend WHERE id=?').run(+req.params.id); res.json({ ok: true }); });

// files (photos, ideas, quote PDFs, receipts)
app.post('/api/items/:id/files', upload.array('files', 10), (req, res) => {
  const kind = oneOf(req.body.kind, ['photo', 'idea', 'quote', 'receipt'], 'photo');
  const ins = db.prepare('INSERT INTO files(item_id,kind,filename,original,caption,created_by) VALUES(?,?,?,?,?,?)');
  (req.files || []).forEach(f => ins.run(+req.params.id, kind, f.filename, f.originalname, req.body.caption || '', req.user));
  res.json({ ok: true, count: (req.files || []).length });
});
app.put('/api/files/:id', (req, res) => { db.prepare('UPDATE files SET caption=? WHERE id=?').run(req.body.caption || '', +req.params.id); res.json({ ok: true }); });
app.delete('/api/files/:id', (req, res) => {
  const f = db.prepare('SELECT filename FROM files WHERE id=?').get(+req.params.id);
  if (f) { db.prepare('DELETE FROM files WHERE id=?').run(+req.params.id); fs.rmSync(path.join(UPLOADS, f.filename), { force: true }); }
  res.json({ ok: true });
});

// comments / ideas
app.post('/api/items/:id/comments', (req, res) => {
  if (!String((req.body || {}).body || '').trim()) return res.status(400).json({ error: 'Empty' });
  db.prepare('INSERT INTO comments(item_id,body,created_by) VALUES(?,?,?)').run(+req.params.id, req.body.body.trim(), req.user);
  res.json({ ok: true });
});
app.delete('/api/comments/:id', (req, res) => { db.prepare('DELETE FROM comments WHERE id=?').run(+req.params.id); res.json({ ok: true }); });

// ---------- exports ----------
const money = n => `${CURRENCY} ${Math.round(n || 0).toLocaleString('en-US')}`;
app.get('/api/export.csv', (req, res) => {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = listItems(req.query);
  const lines = [['Priority', 'Item', 'Room', 'Category', 'Status', 'Budget', 'Lowest quote', 'Accepted quote', 'Spent', 'Notes'].join(',')]
    .concat(rows.map(r => [r.priority, r.title, r.room, r.category, r.status, r.budget, r.lowest_quote ?? '', r.accepted_quote ?? '', r.spent, r.notes].map(q).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="house-projects.csv"');
  res.send('\ufeff' + lines.join('\n'));
});

app.get('/api/export.pdf', (req, res) => {
  const rows = listItems(req.query);
  const sum = summaryOf(rows);
  const withPhotos = req.query.photos !== '0';
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: TITLE } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="house-projects-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);
  const W = doc.page.width - 84, INK = '#1f2937', MUTED = '#6b7280', ACC = '#0f766e';
  const need = h => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };

  doc.fillColor(ACC).fontSize(22).font('Helvetica-Bold').text(TITLE);
  doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(`Generated ${new Date().toISOString().slice(0, 10)} - ${rows.length} item${rows.length === 1 ? '' : 's'}`);
  doc.moveDown(0.8);

  // summary box
  const bx = doc.x, by = doc.y;
  doc.roundedRect(bx, by, W, 56, 6).fill('#f0fdfa');
  const cols = [['Budget', sum.budget], ['Committed', sum.committed], ['Spent', sum.spent], ['Remaining', sum.remaining]];
  cols.forEach(([l, v], i) => {
    const x = bx + 14 + i * (W / 4);
    doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(l.toUpperCase(), x, by + 12, { width: W / 4 - 10 });
    doc.fillColor(v < 0 && l === 'Remaining' ? '#b91c1c' : INK).fontSize(12).font('Helvetica-Bold').text(money(v), x, by + 26, { width: W / 4 - 10 });
  });
  doc.x = bx; doc.y = by + 70;

  // priority totals
  doc.fillColor(INK).fontSize(9).font('Helvetica');
  PRIORITIES.forEach(p => { const b = sum.byPriority[p]; if (b && b.items) doc.text(`${p}: ${b.items} item${b.items > 1 ? 's' : ''}  |  budget ${money(b.budget)}  |  committed ${money(b.committed)}  |  spent ${money(b.spent)}`); });
  doc.moveDown(0.8);

  PRIORITIES.forEach(p => {
    const group = rows.filter(r => r.priority === p);
    if (!group.length) return;
    need(60);
    doc.fillColor(ACC).fontSize(14).font('Helvetica-Bold').text(p);
    doc.moveTo(doc.x, doc.y + 1).lineTo(doc.x + W, doc.y + 1).strokeColor(ACC).lineWidth(0.8).stroke();
    doc.moveDown(0.5);
    group.forEach(r => {
      need(90);
      const start = doc.y;
      doc.fillColor(INK).fontSize(11.5).font('Helvetica-Bold').text(r.title, { width: W - 150, continued: false });
      const afterTitle = doc.y;
      doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text(money(r.budget), doc.x + W - 140, start, { width: 140, align: 'right' });
      doc.x = 42; doc.y = afterTitle;
      doc.fillColor(MUTED).fontSize(8.5).font('Helvetica')
        .text([r.room, r.category, r.status].filter(Boolean).join('  |  '));
      const money_bits = [];
      if (r.accepted_quote != null) money_bits.push(`Accepted quote ${money(r.accepted_quote)}`);
      else if (r.lowest_quote != null) money_bits.push(`Lowest quote ${money(r.lowest_quote)} (${r.quote_count} quote${r.quote_count > 1 ? 's' : ''})`);
      if (r.spent) money_bits.push(`Spent ${money(r.spent)}`);
      if (money_bits.length) doc.fillColor(ACC).text(money_bits.join('   '));
      if (r.notes) doc.fillColor(INK).fontSize(9).text(r.notes, { width: W });

      const quotes = db.prepare('SELECT * FROM quotes WHERE item_id=? ORDER BY amount').all(r.id);
      quotes.forEach(q => { need(14); doc.fillColor(MUTED).fontSize(8.5).text(`   - ${q.vendor}: ${money(q.amount)} (${q.status}${q.quote_date ? ', ' + q.quote_date : ''})${q.notes ? ' - ' + q.notes : ''}`, { width: W }); });
      const comments = db.prepare('SELECT * FROM comments WHERE item_id=? ORDER BY id').all(r.id);
      comments.forEach(c => { need(14); doc.fillColor(MUTED).fontSize(8.5).text(`   ${c.created_by}: ${c.body}`, { width: W }); });

      if (withPhotos) {
        const pics = db.prepare("SELECT * FROM files WHERE item_id=? AND kind IN ('photo','idea') ORDER BY id LIMIT 6").all(r.id)
          .filter(f => /\.(jpe?g|png)$/i.test(f.filename));
        if (pics.length) {
          const size = 92, gap = 8;
          need(size + 12);
          let x = 42; const y = doc.y + 4;
          pics.forEach(f => {
            try { doc.image(path.join(UPLOADS, f.filename), x, y, { fit: [size, size], align: 'center', valign: 'center' }); } catch { }
            x += size + gap;
          });
          doc.x = 42; doc.y = y + size + 4;
        }
      }
      doc.moveDown(0.7);
      doc.x = 42;
    });
    doc.moveDown(0.4);
  });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(`${TITLE}  -  page ${i + 1} of ${range.count}`, 42, doc.page.height - 32, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
});

// ---------- backup ----------
app.get('/api/backup', (req, res) => res.json(backupStatus));
app.post('/api/backup', async (req, res) => {
  try { res.json(await runBackup(db)); } catch (e) { res.status(500).json({ error: e.message, status: backupStatus }); }
});
const sched = process.env.BACKUP_CRON || '30 2 * * *'; // nightly 02:30
if (sched !== 'off') cron.schedule(sched, () => runBackup(db).catch(e => console.error('backup failed:', e.message)), { timezone: process.env.TZ || 'UTC' });

app.listen(PORT, () => console.log(`${TITLE} listening on :${PORT}, data in ${DATA}, users: ${Object.keys(USERS).join(', ')}`));
