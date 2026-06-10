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
const { query, one, initDb, publicUser, uniqueThreadSlug, attachTags, databasePath } = require('./db');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-me';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || undefined;

app.set('trust proxy', 1);

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN || true, credentials: true }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (value, max = 5000) => String(value || '').trim().slice(0, max);
const parseTags = (tags) => {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(list.map((tag) => clean(tag, 32).replace(/^#/, '')).filter(Boolean))].slice(0, 8);
};
const cookieOptions = {
  httpOnly: true,
  sameSite: COOKIE_SECURE && CORS_ORIGIN ? 'none' : 'lax',
  secure: COOKIE_SECURE,
  maxAge: 1000 * 60 * 60 * 24 * 30
};

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function getStats() {
  const members = Number(one(await query('SELECT COUNT(*)::int AS count FROM users WHERE is_banned = 0')).count);
  const threads = Number(one(await query(`SELECT COUNT(*)::int AS count FROM threads WHERE status != 'archived'`)).count);
  const posts = Number(one(await query('SELECT COUNT(*)::int AS count FROM posts')).count);
  return { members, threads, posts, online: io.engine.clientsCount || 0 };
}

async function emitStats() {
  io.to('community').emit('stats:updated', await getStats());
}

async function emitCategories() {
  const categories = await listCategories();
  io.to('community').emit('categories:updated', { categories });
}

function signUser(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

async function attachUser(req, _res, next) {
  const token = req.cookies.aion_token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = one(await query('SELECT * FROM users WHERE id = $1 AND is_banned = 0 LIMIT 1', [payload.sub])) || null;
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
      COALESCE((SELECT SUM(value) FROM thread_votes WHERE thread_id = t.id), 0)::int AS votes,
      (SELECT COUNT(*)::int FROM posts WHERE thread_id = t.id) AS replies,
      COALESCE((SELECT string_agg(tags.name, ',') FROM tags JOIN thread_tags ON tags.id = thread_tags.tag_id WHERE thread_tags.thread_id = t.id), '') AS tags
    FROM threads t
    JOIN categories c ON c.id = t.category_id
    JOIN users u ON u.id = t.author_id
    ${where}
  `;
}

async function getThreadById(id) {
  const row = one(await query(threadSelectSql('WHERE t.id = $1'), [id]));
  return row ? mapThread(row) : null;
}

async function getThreadBySlug(slug) {
  const row = one(await query(threadSelectSql('WHERE t.slug = $1'), [slug]));
  return row ? mapThread(row) : null;
}

async function listCategories() {
  const result = await query(`
    SELECT c.*, COUNT(t.id)::int AS thread_count
    FROM categories c
    LEFT JOIN threads t ON t.category_id = c.id AND t.status != 'archived'
    GROUP BY c.id
    ORDER BY c.sort_order ASC, c.name ASC
  `);
  return result.rows;
}

async function broadcastThreadUpdate(thread) {
  if (!thread) return;
  io.to('community').emit('thread:updated', { thread });
  io.to(`category:${thread.category_slug}`).emit('thread:updated', { thread });
  io.to(`thread:${thread.slug}`).emit('thread:updated', { thread });
  await emitStats();
  await emitCategories();
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

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const username = clean(req.body.username, 24);
  const displayName = clean(req.body.display_name || username, 80);
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-24 letters, numbers or underscores.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const exists = one(await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2) LIMIT 1', [email, username]));
  if (exists) return res.status(409).json({ error: 'Email or username already exists.' });

  const passwordHash = bcrypt.hashSync(password, 12);
  const timestamp = new Date().toISOString();
  const user = one(await query(
    `INSERT INTO users (username, display_name, email, password_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [username, displayName, email, passwordHash, timestamp, timestamp]
  ));
  res.cookie('aion_token', signUser(user), cookieOptions).status(201).json({ user: publicUser(user) });
  await emitStats();
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const user = one(await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND is_banned = 0 LIMIT 1', [email]));
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.cookie('aion_token', signUser(user), cookieOptions).json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('aion_token', cookieOptions).json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/stats', asyncHandler(async (_req, res) => res.json(await getStats())));

app.get('/api/categories', asyncHandler(async (_req, res) => {
  res.json({ categories: await listCategories() });
}));

app.get('/api/threads', asyncHandler(async (req, res) => {
  const category = clean(req.query.category, 60);
  const q = clean(req.query.q, 120);
  const sort = clean(req.query.sort, 20) || 'latest';
  const where = [`t.status != 'archived'`];
  const params = [];

  if (category) {
    params.push(category);
    where.push(`c.slug = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const qIndex = params.length;
    where.push(`(t.title ILIKE $${qIndex} OR t.body ILIKE $${qIndex} OR EXISTS (SELECT 1 FROM thread_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.thread_id = t.id AND tg.name ILIKE $${qIndex}))`);
  }

  const order = {
    latest: 't.is_pinned DESC, t.last_activity_at DESC',
    top: 't.is_pinned DESC, votes DESC, t.last_activity_at DESC',
    new: 't.created_at DESC',
    views: 't.views DESC, t.last_activity_at DESC'
  }[sort] || 't.is_pinned DESC, t.last_activity_at DESC';

  const sql = `${threadSelectSql(`WHERE ${where.join(' AND ')}`)} ORDER BY ${order} LIMIT 100`;
  const threads = (await query(sql, params)).rows.map(mapThread);
  res.json({ threads });
}));

app.post('/api/threads', requireAuth, asyncHandler(async (req, res) => {
  const title = clean(req.body.title, 140);
  const body = clean(req.body.body, 8000);
  const categorySlug = clean(req.body.category_slug, 60);
  const type = clean(req.body.type, 20) || 'discussion';
  const allowedTypes = ['discussion', 'support', 'idea', 'work', 'release'];
  if (title.length < 8) return res.status(400).json({ error: 'Title must be at least 8 characters.' });
  if (body.length < 20) return res.status(400).json({ error: 'Details must be at least 20 characters.' });
  if (!allowedTypes.includes(type)) return res.status(400).json({ error: 'Invalid topic type.' });

  const category = one(await query('SELECT * FROM categories WHERE slug = $1 LIMIT 1', [categorySlug]));
  if (!category) return res.status(400).json({ error: 'Choose a valid category.' });

  const timestamp = new Date().toISOString();
  const threadSlug = await uniqueThreadSlug(title);
  const inserted = one(await query(
    `INSERT INTO threads (category_id, author_id, title, slug, body, type, status, created_at, updated_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9)
     RETURNING id`,
    [category.id, req.user.id, title, threadSlug, body, type, timestamp, timestamp, timestamp]
  ));
  await attachTags(inserted.id, parseTags(req.body.tags));
  const thread = await getThreadById(inserted.id);
  res.status(201).json({ thread });
  io.to('community').emit('thread:created', { thread });
  io.to(`category:${thread.category_slug}`).emit('thread:created', { thread });
  await emitStats();
  await emitCategories();
}));

app.get('/api/threads/:slug', asyncHandler(async (req, res) => {
  const thread = await getThreadBySlug(req.params.slug);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  await query('UPDATE threads SET views = views + 1 WHERE id = $1', [thread.id]);
  const updatedThread = await getThreadById(thread.id);
  const posts = (await query(
    `SELECT p.*, u.username, u.display_name, u.avatar_url
     FROM posts p
     JOIN users u ON u.id = p.author_id
     WHERE p.thread_id = $1
     ORDER BY p.created_at ASC`,
    [thread.id]
  )).rows;
  res.json({ thread: updatedThread, posts });
  io.to('community').emit('thread:updated', { thread: updatedThread });
  io.to(`thread:${updatedThread.slug}`).emit('thread:updated', { thread: updatedThread });
}));

app.post('/api/threads/:slug/posts', requireAuth, asyncHandler(async (req, res) => {
  const body = clean(req.body.body, 8000);
  if (body.length < 2) return res.status(400).json({ error: 'Reply cannot be empty.' });
  const thread = one(await query('SELECT * FROM threads WHERE slug = $1 LIMIT 1', [req.params.slug]));
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  if (['locked', 'archived'].includes(thread.status)) return res.status(403).json({ error: 'Thread is locked.' });

  const timestamp = new Date().toISOString();
  const inserted = one(await query(
    `INSERT INTO posts (thread_id, author_id, body, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [thread.id, req.user.id, body, timestamp, timestamp]
  ));
  await query('UPDATE threads SET updated_at = $1, last_activity_at = $2 WHERE id = $3', [timestamp, timestamp, thread.id]);
  const post = one(await query(
    `SELECT p.*, u.username, u.display_name, u.avatar_url
     FROM posts p
     JOIN users u ON u.id = p.author_id
     WHERE p.id = $1`,
    [inserted.id]
  ));
  const updatedThread = await getThreadById(thread.id);
  res.status(201).json({ post, thread: updatedThread });
  io.to(`thread:${updatedThread.slug}`).emit('post:created', { post, thread: updatedThread });
  await broadcastThreadUpdate(updatedThread);
}));

app.post('/api/threads/:id/vote', requireAuth, asyncHandler(async (req, res) => {
  const threadId = Number(req.params.id);
  const value = Number(req.body.value) === -1 ? -1 : 1;
  const thread = one(await query('SELECT id FROM threads WHERE id = $1 LIMIT 1', [threadId]));
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  await query(
    `INSERT INTO thread_votes (thread_id, user_id, value)
     VALUES ($1, $2, $3)
     ON CONFLICT(thread_id, user_id) DO UPDATE SET value = EXCLUDED.value`,
    [threadId, req.user.id, value]
  );
  const updatedThread = await getThreadById(threadId);
  res.json({ votes: updatedThread.votes, thread: updatedThread });
  await broadcastThreadUpdate(updatedThread);
}));

app.post('/api/threads/:id/bookmark', requireAuth, asyncHandler(async (req, res) => {
  const threadId = Number(req.params.id);
  const thread = one(await query('SELECT id FROM threads WHERE id = $1 LIMIT 1', [threadId]));
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const existing = one(await query('SELECT 1 FROM bookmarks WHERE thread_id = $1 AND user_id = $2 LIMIT 1', [threadId, req.user.id]));
  if (existing) {
    await query('DELETE FROM bookmarks WHERE thread_id = $1 AND user_id = $2', [threadId, req.user.id]);
    res.json({ bookmarked: false });
  } else {
    await query('INSERT INTO bookmarks (thread_id, user_id) VALUES ($1, $2)', [threadId, req.user.id]);
    res.json({ bookmarked: true });
  }
}));

app.post('/api/reports', requireAuth, asyncHandler(async (req, res) => {
  const reason = clean(req.body.reason, 800);
  const threadId = req.body.thread_id ? Number(req.body.thread_id) : null;
  const postId = req.body.post_id ? Number(req.body.post_id) : null;
  if (!reason) return res.status(400).json({ error: 'Report reason required.' });
  if (!threadId && !postId) return res.status(400).json({ error: 'Report must reference a thread or post.' });
  await query('INSERT INTO reports (reporter_id, thread_id, post_id, reason) VALUES ($1, $2, $3, $4)', [req.user.id, threadId, postId, reason]);
  res.status(201).json({ ok: true });
  io.to('moderators').emit('report:created', { ok: true });
}));

app.get('/api/admin/reports', requireModerator, asyncHandler(async (_req, res) => {
  const reports = (await query(`
    SELECT r.*, t.title AS thread_title, substring(p.body from 1 for 160) AS post_excerpt, u.username AS reporter_username, u.display_name AS reporter_name
    FROM reports r
    LEFT JOIN threads t ON t.id = r.thread_id
    LEFT JOIN posts p ON p.id = r.post_id
    JOIN users u ON u.id = r.reporter_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC
    LIMIT 100
  `)).rows;
  res.json({ reports });
}));

app.get('*', (req, res) => {
  let route = 'index.html';
  if (req.path.includes('community')) route = 'community.html';
  if (req.path.includes('thread')) route = 'thread.html';
  if (req.path.includes('admin')) route = 'admin.html';
  res.sendFile(path.join(__dirname, 'public', route));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : err.message });
});

(async () => {
  try {
    await initDb();
    server.listen(PORT, () => {
      console.log(`AION OS website running at http://localhost:${PORT}`);
      console.log(`Database: ${databasePath}`);
    });
  } catch (error) {
    console.error('Failed to start AION OS server:', error);
    process.exit(1);
  }
})();
