require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { db, initDb, publicUser, uniqueThreadSlug, attachTags, databasePath } = require('./db');

initDb();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-me';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || undefined;

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN || true, credentials: true }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (value, max = 5000) => String(value || '').trim().slice(0, max);
const parseTags = (tags) => {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map((tag) => clean(tag, 32).replace(/^#/, '')).filter(Boolean))].slice(0, 8);
};
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 1000 * 60 * 60 * 24 * 30 };

function getStats() {
  const members = db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_banned = 0').get().count;
  const threads = db.prepare('SELECT COUNT(*) AS count FROM threads WHERE status != ?').get('archived').count;
  const posts = db.prepare('SELECT COUNT(*) AS count FROM posts').get().count;
  return { members, threads, posts, online: io.engine.clientsCount || 0 };
}

function emitStats() {
  io.to('community').emit('stats:updated', getStats());
}

function emitCategories() {
  const categories = listCategories();
  io.to('community').emit('categories:updated', { categories });
}

function signUser(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function attachUser(req, _res, next) {
  const token = req.cookies.aion_token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = db.prepare('SELECT * FROM users WHERE id = ? AND is_banned = 0').get(payload.sub) || null;
    } catch (_) {
      req.user = null;
    }
  }
  next();
}
app.use(attachUser);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

function requireModerator(req, res, next) {
  if (!req.user || !['moderator', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Moderator access required.' });
  next();
}

function threadSelectSql(where = '') {
  return `
    SELECT
      t.*,
      c.slug AS category_slug,
      c.name AS category_name,
      c.icon AS category_icon,
      u.username,
      u.display_name,
      u.avatar_url,
      COALESCE((SELECT SUM(value) FROM thread_votes WHERE thread_id = t.id), 0) AS votes,
      (SELECT COUNT(*) FROM posts WHERE thread_id = t.id) AS replies,
      COALESCE((SELECT group_concat(tags.name, ',') FROM tags JOIN thread_tags ON tags.id = thread_tags.tag_id WHERE thread_tags.thread_id = t.id), '') AS tags
    FROM threads t
    JOIN categories c ON c.id = t.category_id
    JOIN users u ON u.id = t.author_id
    ${where}
  `;
}

function mapThread(row) {
  return {
    ...row,
    tags: String(row.tags || '').split(',').filter(Boolean),
    is_pinned: Number(row.is_pinned),
    views: Number(row.views || 0),
    votes: Number(row.votes || 0),
    replies: Number(row.replies || 0)
  };
}

function getThreadById(id) {
  const row = db.prepare(threadSelectSql('WHERE t.id = ?')).get(id);
  return row ? mapThread(row) : null;
}

function getThreadBySlug(slug) {
  const row = db.prepare(threadSelectSql('WHERE t.slug = ?')).get(slug);
  return row ? mapThread(row) : null;
}

function listCategories() {
  return db.prepare(`
    SELECT c.*, COUNT(t.id) AS thread_count
    FROM categories c
    LEFT JOIN threads t ON t.category_id = c.id AND t.status != 'archived'
    GROUP BY c.id
    ORDER BY c.sort_order ASC, c.name ASC
  `).all();
}

function broadcastThreadUpdate(thread) {
  if (!thread) return;
  io.to('community').emit('thread:updated', { thread });
  io.to(`category:${thread.category_slug}`).emit('thread:updated', { thread });
  io.to(`thread:${thread.slug}`).emit('thread:updated', { thread });
  emitStats();
  emitCategories();
}

io.on('connection', (socket) => {
  socket.join('community');
  socket.emit('presence:updated', { online: io.engine.clientsCount || 1 });
  io.to('community').emit('presence:updated', { online: io.engine.clientsCount || 1 });

  socket.on('forum:join', ({ category, slug } = {}) => {
    socket.join('community');
    if (category && category !== 'all') socket.join(`category:${String(category).slice(0, 80)}`);
    if (slug) socket.join(`thread:${String(slug).slice(0, 160)}`);
  });

  socket.on('disconnect', () => {
    setTimeout(() => io.to('community').emit('presence:updated', { online: io.engine.clientsCount || 0 }), 50);
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'AION OS Community API', realtime: true, database: databasePath }));

app.post('/api/auth/register', (req, res) => {
  const username = clean(req.body.username, 24);
  const displayName = clean(req.body.display_name || username, 80);
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-24 letters, numbers or underscores.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (exists) return res.status(409).json({ error: 'Email or username already exists.' });
  const passwordHash = bcrypt.hashSync(password, 12);
  const timestamp = new Date().toISOString();
  const result = db.prepare('INSERT INTO users (username, display_name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(username, displayName, email, passwordHash, timestamp, timestamp);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.cookie('aion_token', signUser(user), cookieOptions).status(201).json({ user: publicUser(user) });
  emitStats();
});

app.post('/api/auth/login', (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_banned = 0').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.cookie('aion_token', signUser(user), cookieOptions).json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('aion_token').json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/stats', (_req, res) => res.json(getStats()));

app.get('/api/categories', (_req, res) => {
  res.json({ categories: listCategories() });
});

app.get('/api/threads', (req, res) => {
  const category = clean(req.query.category, 60);
  const q = clean(req.query.q, 120);
  const sort = clean(req.query.sort, 20) || 'latest';
  const where = [`t.status != 'archived'`];
  const params = {};
  if (category) {
    where.push('c.slug = @category');
    params.category = category;
  }
  if (q) {
    where.push(`(t.title LIKE @q OR t.body LIKE @q OR EXISTS (SELECT 1 FROM thread_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.thread_id = t.id AND tg.name LIKE @q))`);
    params.q = `%${q}%`;
  }
  const order = {
    latest: 't.is_pinned DESC, datetime(t.last_activity_at) DESC',
    top: 't.is_pinned DESC, votes DESC, datetime(t.last_activity_at) DESC',
    new: 'datetime(t.created_at) DESC',
    views: 't.views DESC, datetime(t.last_activity_at) DESC'
  }[sort] || 't.is_pinned DESC, datetime(t.last_activity_at) DESC';
  const sql = `${threadSelectSql(`WHERE ${where.join(' AND ')}`)} ORDER BY ${order} LIMIT 100`;
  const threads = db.prepare(sql).all(params).map(mapThread);
  res.json({ threads });
});

app.post('/api/threads', requireAuth, (req, res) => {
  const title = clean(req.body.title, 140);
  const body = clean(req.body.body, 8000);
  const categorySlug = clean(req.body.category_slug, 60);
  const type = clean(req.body.type, 20) || 'discussion';
  const allowedTypes = ['discussion', 'support', 'idea', 'work', 'release'];
  if (title.length < 8) return res.status(400).json({ error: 'Title must be at least 8 characters.' });
  if (body.length < 20) return res.status(400).json({ error: 'Details must be at least 20 characters.' });
  if (!allowedTypes.includes(type)) return res.status(400).json({ error: 'Invalid topic type.' });
  const category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(categorySlug);
  if (!category) return res.status(400).json({ error: 'Choose a valid category.' });
  const timestamp = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO threads (category_id, author_id, title, slug, body, type, status, created_at, updated_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(category.id, req.user.id, title, uniqueThreadSlug(title), body, type, timestamp, timestamp, timestamp);
  attachTags(result.lastInsertRowid, parseTags(req.body.tags));
  const thread = getThreadById(result.lastInsertRowid);
  res.status(201).json({ thread });
  io.to('community').emit('thread:created', { thread });
  io.to(`category:${thread.category_slug}`).emit('thread:created', { thread });
  emitStats();
  emitCategories();
});

app.get('/api/threads/:slug', (req, res) => {
  const thread = getThreadBySlug(req.params.slug);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  db.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').run(thread.id);
  const updatedThread = getThreadById(thread.id);
  const posts = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p
    JOIN users u ON u.id = p.author_id
    WHERE p.thread_id = ?
    ORDER BY datetime(p.created_at) ASC
  `).all(thread.id);
  res.json({ thread: updatedThread, posts });
  io.to('community').emit('thread:updated', { thread: updatedThread });
  io.to(`thread:${updatedThread.slug}`).emit('thread:updated', { thread: updatedThread });
});

app.post('/api/threads/:slug/posts', requireAuth, (req, res) => {
  const body = clean(req.body.body, 8000);
  if (body.length < 2) return res.status(400).json({ error: 'Reply cannot be empty.' });
  const thread = db.prepare('SELECT * FROM threads WHERE slug = ?').get(req.params.slug);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  if (['locked', 'archived'].includes(thread.status)) return res.status(403).json({ error: 'Thread is locked.' });
  const timestamp = new Date().toISOString();
  const result = db.prepare('INSERT INTO posts (thread_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(thread.id, req.user.id, body, timestamp, timestamp);
  db.prepare('UPDATE threads SET updated_at = ?, last_activity_at = ? WHERE id = ?').run(timestamp, timestamp, thread.id);
  const post = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar_url FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`).get(result.lastInsertRowid);
  const updatedThread = getThreadById(thread.id);
  res.status(201).json({ post, thread: updatedThread });
  io.to(`thread:${updatedThread.slug}`).emit('post:created', { post, thread: updatedThread });
  broadcastThreadUpdate(updatedThread);
});

app.post('/api/threads/:id/vote', requireAuth, (req, res) => {
  const threadId = Number(req.params.id);
  const value = Number(req.body.value) === -1 ? -1 : 1;
  const thread = db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  db.prepare(`
    INSERT INTO thread_votes (thread_id, user_id, value)
    VALUES (?, ?, ?)
    ON CONFLICT(thread_id, user_id) DO UPDATE SET value = excluded.value
  `).run(threadId, req.user.id, value);
  const updatedThread = getThreadById(threadId);
  res.json({ votes: updatedThread.votes, thread: updatedThread });
  broadcastThreadUpdate(updatedThread);
});

app.post('/api/threads/:id/bookmark', requireAuth, (req, res) => {
  const threadId = Number(req.params.id);
  const thread = db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const existing = db.prepare('SELECT 1 FROM bookmarks WHERE thread_id = ? AND user_id = ?').get(threadId, req.user.id);
  if (existing) {
    db.prepare('DELETE FROM bookmarks WHERE thread_id = ? AND user_id = ?').run(threadId, req.user.id);
    res.json({ bookmarked: false });
  } else {
    db.prepare('INSERT INTO bookmarks (thread_id, user_id) VALUES (?, ?)').run(threadId, req.user.id);
    res.json({ bookmarked: true });
  }
});

app.post('/api/reports', requireAuth, (req, res) => {
  const reason = clean(req.body.reason, 800);
  const threadId = req.body.thread_id ? Number(req.body.thread_id) : null;
  const postId = req.body.post_id ? Number(req.body.post_id) : null;
  if (!reason) return res.status(400).json({ error: 'Report reason required.' });
  if (!threadId && !postId) return res.status(400).json({ error: 'Report must reference a thread or post.' });
  db.prepare('INSERT INTO reports (reporter_id, thread_id, post_id, reason) VALUES (?, ?, ?, ?)').run(req.user.id, threadId, postId, reason);
  res.status(201).json({ ok: true });
  io.to('moderators').emit('report:created', { ok: true });
});

app.get('/api/admin/reports', requireModerator, (_req, res) => {
  const reports = db.prepare(`
    SELECT r.*, t.title AS thread_title, substr(p.body, 1, 160) AS post_excerpt, u.username AS reporter_username, u.display_name AS reporter_name
    FROM reports r
    LEFT JOIN threads t ON t.id = r.thread_id
    LEFT JOIN posts p ON p.id = r.post_id
    JOIN users u ON u.id = r.reporter_id
    WHERE r.status = 'open'
    ORDER BY datetime(r.created_at) DESC
    LIMIT 100
  `).all();
  res.json({ reports });
});

app.get('*', (req, res) => {
  let route = 'index.html';
  if (req.path.includes('community')) route = 'community.html';
  if (req.path.includes('thread')) route = 'thread.html';
  if (req.path.includes('admin')) route = 'admin.html';
  res.sendFile(path.join(__dirname, 'public', route));
});

server.listen(PORT, () => {
  console.log(`AION OS website running at http://localhost:${PORT}`);
  console.log(`Database: ${databasePath}`);
});
