require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const slugify = require('slugify');

function resolveDatabasePath(value) {
  const requested = value || path.join('database', 'aionos.db');
  return path.isAbsolute(requested) ? requested : path.join(__dirname, requested);
}

const databasePath = resolveDatabasePath(process.env.DATABASE_PATH);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

const now = () => new Date().toISOString();
const slug = (value) => slugify(String(value || 'topic'), { lower: true, strict: true, trim: true }) || 'topic';

function runSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
  db.exec(schema);
}

function seedCategories() {
  const categories = [
    ['support', 'Support Desk', 'Problems, logs, fixes and installation help.', '◎', '#9de7ff', 10],
    ['ideas', 'Ideas & Requests', 'Feature requests, UI feedback and roadmap suggestions.', '✧', '#b9a6ff', 20],
    ['works', 'Works & Showcases', 'Themes, widgets, screenshots, concepts and community creations.', '▣', '#ffd0ea', 30],
    ['releases', 'Releases', 'Stable builds, nightly notes, checksums and known issues.', '↗', '#ffe296', 40],
    ['development', 'Development', 'Shell work, apps, packaging and contribution discussion.', '⌘', '#8df4c7', 50],
    ['gaming', 'Gaming & Drivers', 'Steam, NVIDIA, drivers and gaming performance.', '◈', '#c8b6ff', 60],
    ['robotics', 'Robotics & ROS 2', 'ROS 2, RViz, robotics workflows and lab builds.', '◆', '#a8ecff', 70]
  ];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO categories (slug, name, description, icon, accent, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => categories.forEach((cat) => insert.run(...cat)));
  tx();
}

function ensureUser({ username, display_name, email, password, role = 'member', bio = '' }) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) return existing;
  const passwordHash = bcrypt.hashSync(password, 12);
  const timestamp = now();
  const result = db.prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, bio, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, display_name, email, passwordHash, role, bio, timestamp, timestamp);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function ensureLaunchAdmin() {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || '');
  const adminUsername = String(process.env.ADMIN_USERNAME || 'aion-admin').trim();
  const adminName = String(process.env.ADMIN_DISPLAY_NAME || 'AION Admin').trim();

  if (adminEmail && adminPassword.length >= 12) {
    return ensureUser({
      username: adminUsername,
      display_name: adminName,
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
      bio: 'Official AION OS administrator.'
    });
  }

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount === 0 && process.env.NODE_ENV !== 'production') {
    return ensureUser({
      username: 'aion-admin',
      display_name: 'AION Admin',
      email: 'admin@aionos.local',
      password: 'change-me-now',
      role: 'admin',
      bio: 'Local development admin account. Change this before launch.'
    });
  }
  return null;
}

function ensureTag(name) {
  const clean = String(name || '').trim().replace(/^#/, '').slice(0, 32);
  if (!clean) return null;
  const tagSlug = slug(clean);
  db.prepare('INSERT OR IGNORE INTO tags (name, slug) VALUES (?, ?)').run(clean, tagSlug);
  return db.prepare('SELECT * FROM tags WHERE slug = ?').get(tagSlug);
}

function attachTags(threadId, tags) {
  const insert = db.prepare('INSERT OR IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)');
  for (const tagName of tags || []) {
    const tag = ensureTag(tagName);
    if (tag) insert.run(threadId, tag.id);
  }
}

function uniqueThreadSlug(title) {
  const base = slug(title);
  let candidate = base;
  let index = 2;
  const exists = db.prepare('SELECT id FROM threads WHERE slug = ?');
  while (exists.get(candidate)) {
    candidate = `${base}-${index++}`;
  }
  return candidate;
}

function seedSampleContentIfEnabled() {
  if (String(process.env.SEED_SAMPLE_CONTENT || '').toLowerCase() !== 'true') return;
  const count = db.prepare('SELECT COUNT(*) AS count FROM threads').get().count;
  if (count > 0) return;
  const admin = ensureLaunchAdmin() || ensureUser({
    username: 'aion-team',
    display_name: 'AION Team',
    email: 'team@aionos.local',
    password: 'change-me-now',
    role: 'admin',
    bio: 'Official AION OS team account.'
  });
  const category = db.prepare('SELECT id FROM categories WHERE slug = ?').get('releases');
  const timestamp = now();
  const result = db.prepare(`
    INSERT INTO threads (category_id, author_id, title, slug, body, type, status, is_pinned, created_at, updated_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, 'release', 'open', 1, ?, ?, ?)
  `).run(
    category.id,
    admin.id,
    'Welcome to Aion Forums',
    uniqueThreadSlug('Welcome to Aion Forums'),
    'This optional sample thread confirms the database is working. Disable SEED_SAMPLE_CONTENT before launch if you want the forum to start completely empty.',
    timestamp,
    timestamp,
    timestamp
  );
  attachTags(result.lastInsertRowid, ['welcome', 'launch']);
}

function initDb() {
  runSchema();
  seedCategories();
  ensureLaunchAdmin();
  seedSampleContentIfEnabled();
  return db;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    bio: user.bio,
    role: user.role,
    reputation: user.reputation,
    created_at: user.created_at
  };
}

module.exports = { db, initDb, publicUser, uniqueThreadSlug, attachTags, ensureTag, ensureUser, slug, databasePath };
