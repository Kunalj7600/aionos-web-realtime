require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add it to .env locally or Render Environment Variables.');
  process.exit(1);
}

const isLocalDatabase = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && !isLocalDatabase ? { rejectUnauthorized: false } : false
});

(async () => {
  try {
    console.log('Resetting AION Postgres tables...');
    await pool.query(`
      DROP TABLE IF EXISTS notifications CASCADE;
      DROP TABLE IF EXISTS reports CASCADE;
      DROP TABLE IF EXISTS attachments CASCADE;
      DROP TABLE IF EXISTS bookmarks CASCADE;
      DROP TABLE IF EXISTS post_reactions CASCADE;
      DROP TABLE IF EXISTS thread_votes CASCADE;
      DROP TABLE IF EXISTS thread_tags CASCADE;
      DROP TABLE IF EXISTS tags CASCADE;
      DROP TABLE IF EXISTS posts CASCADE;
      DROP TABLE IF EXISTS threads CASCADE;
      DROP TABLE IF EXISTS categories CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    console.log('Done. Restart the server; it will recreate the schema and admin account.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
