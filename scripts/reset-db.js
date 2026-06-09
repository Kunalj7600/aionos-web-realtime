require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'database', 'aionos.db'));
for (const file of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
  if (fs.existsSync(file)) fs.rmSync(file);
}
require('../db').initDb();
console.log(`Database reset at ${dbPath}`);
