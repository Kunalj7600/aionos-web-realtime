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


function tableExists(table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableExists(table) || columnExists(table, column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function migrateExistingDatabase() {
  // The schema file uses CREATE TABLE IF NOT EXISTS, so an older local database can
  // survive a code update without receiving newly-added columns. These lightweight
  // migrations keep existing users/topics and add any missing realtime-forum fields.
  db.pragma('foreign_keys = OFF');

  addColumnIfMissing('users', 'avatar_url', 'TEXT');
  addColumnIfMissing('users', 'bio', "TEXT DEFAULT ''");
  addColumnIfMissing('users', 'role', "TEXT NOT NULL DEFAULT 'member'");
  addColumnIfMissing('users', 'reputation', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('users', 'created_at', "TEXT");
  addColumnIfMissing('users', 'updated_at', "TEXT");

  addColumnIfMissing('categories', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('categories', 'icon', "TEXT DEFAULT '✦'");
  addColumnIfMissing('categories', 'accent', "TEXT DEFAULT '#9de7ff'");
  addColumnIfMissing('categories', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('categories', 'created_at', "TEXT");

  addColumnIfMissing('threads', 'type', "TEXT NOT NULL DEFAULT 'discussion'");
  addColumnIfMissing('threads', 'status', "TEXT NOT NULL DEFAULT 'open'");
  addColumnIfMissing('threads', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('threads', 'solved_post_id', 'INTEGER');
  addColumnIfMissing('threads', 'views', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('threads', 'created_at', "TEXT");
  addColumnIfMissing('threads', 'updated_at', "TEXT");
  addColumnIfMissing('threads', 'last_activity_at', "TEXT");

  addColumnIfMissing('posts', 'is_solution', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('posts', 'created_at', "TEXT");
  addColumnIfMissing('posts', 'updated_at', "TEXT");

  if (tableExists('threads')) {
    db.prepare("UPDATE threads SET type = COALESCE(NULLIF(type, ''), 'discussion') WHERE type IS NULL OR type = ''").run();
    db.prepare("UPDATE threads SET status = COALESCE(NULLIF(status, ''), 'open') WHERE status IS NULL OR status = ''").run();
    db.prepare("UPDATE threads SET last_activity_at = COALESCE(last_activity_at, updated_at, created_at, datetime('now')) WHERE last_activity_at IS NULL OR last_activity_at = ''").run();
    db.prepare("UPDATE threads SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL OR updated_at = ''").run();
    db.prepare("UPDATE threads SET created_at = COALESCE(created_at, datetime('now')) WHERE created_at IS NULL OR created_at = ''").run();
  }
  if (tableExists('users')) {
    db.prepare("UPDATE users SET created_at = COALESCE(created_at, datetime('now')) WHERE created_at IS NULL OR created_at = ''").run();
    db.prepare("UPDATE users SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL OR updated_at = ''").run();
  }
  if (tableExists('categories')) {
    db.prepare("UPDATE categories SET created_at = COALESCE(created_at, datetime('now')) WHERE created_at IS NULL OR created_at = ''").run();
  }
  if (tableExists('posts')) {
    db.prepare("UPDATE posts SET created_at = COALESCE(created_at, datetime('now')) WHERE created_at IS NULL OR created_at = ''").run();
    db.prepare("UPDATE posts SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL OR updated_at = ''").run();
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category_id);
    CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
    CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  `);
  db.pragma('foreign_keys = ON');
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
  migrateExistingDatabase();
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
