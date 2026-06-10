require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const slugify = require('slugify');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Add your Neon/Supabase Postgres connection string in Render Environment Variables.');
}

const isLocalDatabase = String(process.env.DATABASE_URL || '').includes('localhost') || String(process.env.DATABASE_URL || '').includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && !isLocalDatabase ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

const now = () => new Date().toISOString();
const slug = (value) => slugify(String(value || 'topic'), { lower: true, strict: true, trim: true }) || 'topic';
const one = (result) => result.rows[0] || null;

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function runSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'database', 'schema.pg.sql'), 'utf8');
  await pool.query(schema);
}

async function seedCategories() {
  const categories = [
    ['support', 'Support Desk', 'Problems, logs, fixes and installation help.', '◎', '#9de7ff', 10],
    ['ideas', 'Ideas & Requests', 'Feature requests, UI feedback and roadmap suggestions.', '✧', '#b9a6ff', 20],
    ['works', 'Works & Showcases', 'Themes, widgets, screenshots, concepts and community creations.', '▣', '#ffd0ea', 30],
    ['releases', 'Releases', 'Stable builds, nightly notes, checksums and known issues.', '↗', '#ffe296', 40],
    ['development', 'Development', 'Shell work, apps, packaging and contribution discussion.', '⌘', '#8df4c7', 50],
    ['gaming', 'Gaming & Drivers', 'Steam, NVIDIA, drivers and gaming performance.', '◈', '#c8b6ff', 60],
    ['robotics', 'Robotics & ROS 2', 'ROS 2, RViz, robotics workflows and lab builds.', '◆', '#a8ecff', 70]
  ];

  for (const cat of categories) {
    await query(
      `INSERT INTO categories (slug, name, description, icon, accent, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO NOTHING`,
      cat
    );
  }
}

async function ensureUser({ username, display_name, email, password, role = 'member', bio = '' }) {
  const existing = one(await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2) LIMIT 1', [email, username]));
  if (existing) return existing;

  const passwordHash = bcrypt.hashSync(password, 12);
  const timestamp = now();
  const inserted = one(await query(
    `INSERT INTO users (username, display_name, email, password_hash, role, bio, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [username, display_name, email, passwordHash, role, bio, timestamp, timestamp]
  ));
  return inserted;
}

async function ensureLaunchAdmin() {
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

  const userCount = Number(one(await query('SELECT COUNT(*)::int AS count FROM users')).count);
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

async function ensureTag(name) {
  const clean = String(name || '').trim().replace(/^#/, '').slice(0, 32);
  if (!clean) return null;
  const tagSlug = slug(clean);
  await query(
    `INSERT INTO tags (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO NOTHING`,
    [clean, tagSlug]
  );
  return one(await query('SELECT * FROM tags WHERE slug = $1 LIMIT 1', [tagSlug]));
}

async function attachTags(threadId, tags) {
  for (const tagName of tags || []) {
    const tag = await ensureTag(tagName);
    if (tag) {
      await query(
        `INSERT INTO thread_tags (thread_id, tag_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [threadId, tag.id]
      );
    }
  }
}

async function uniqueThreadSlug(title) {
  const base = slug(title);
  let candidate = base;
  let index = 2;
  while (one(await query('SELECT id FROM threads WHERE slug = $1 LIMIT 1', [candidate]))) {
    candidate = `${base}-${index++}`;
  }
  return candidate;
}

async function seedSampleContentIfEnabled() {
  if (String(process.env.SEED_SAMPLE_CONTENT || '').toLowerCase() !== 'true') return;
  const count = Number(one(await query('SELECT COUNT(*)::int AS count FROM threads')).count);
  if (count > 0) return;

  const admin = await ensureLaunchAdmin() || await ensureUser({
    username: 'aion-team',
    display_name: 'AION Team',
    email: 'team@aionos.local',
    password: 'change-me-now',
    role: 'admin',
    bio: 'Official AION OS team account.'
  });

  const category = one(await query('SELECT id FROM categories WHERE slug = $1 LIMIT 1', ['releases']));
  const timestamp = now();
  const threadSlug = await uniqueThreadSlug('Welcome to Aion Forums');
  const inserted = one(await query(
    `INSERT INTO threads (category_id, author_id, title, slug, body, type, status, is_pinned, created_at, updated_at, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, 'release', 'open', 1, $6, $7, $8)
     RETURNING id`,
    [
      category.id,
      admin.id,
      'Welcome to Aion Forums',
      threadSlug,
      'This optional sample thread confirms the Postgres database is working. Disable SEED_SAMPLE_CONTENT before launch if you want the forum to start completely empty.',
      timestamp,
      timestamp,
      timestamp
    ]
  ));
  await attachTags(inserted.id, ['welcome', 'launch']);
}

async function initDb() {
  await runSchema();
  await seedCategories();
  await ensureLaunchAdmin();
  await seedSampleContentIfEnabled();
  return pool;
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

module.exports = {
  pool,
  query,
  one,
  initDb,
  publicUser,
  uniqueThreadSlug,
  attachTags,
  ensureTag,
  ensureUser,
  slug,
  databasePath: 'postgres:DATABASE_URL'
};
