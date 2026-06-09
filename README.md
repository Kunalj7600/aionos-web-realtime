# AION OS Website + Real-Time Aion Forums

This package turns the AION OS website into a real full-stack community site. The forum is no longer mocked with fallback demo posts: topics, users, replies, votes, bookmarks and reports are stored in SQLite and broadcast live through Socket.IO.

## What is included

- `public/index.html` — AION OS landing page with your uploaded visuals, glass aesthetics and horizontal gallery slider.
- `public/community.html` — Separate Aion Forums community page.
- `public/thread.html` — Realtime thread detail page.
- `public/admin.html` — Basic moderator/admin report review page.
- `server.js` — Express API + Socket.IO realtime server.
- `db.js` — SQLite initialization, category setup and optional admin setup.
- `database/schema.sql` — Forum database schema.
- `Dockerfile` and `docker-compose.yml` — production-style run option with a persistent database volume.

## Real forum features

- Real user registration and login
- Password hashing with bcrypt
- JWT session cookie authentication
- Persistent SQLite database
- Categories/spaces: Support, Ideas, Works, Releases, Development, Gaming, Robotics/ROS 2
- Real topics/threads created by users
- Real replies/posts
- Tags
- Search and sorting API
- Votes
- Bookmarks
- Reports and moderation queue
- Admin/moderator roles
- Live online count
- Realtime new topic updates
- Realtime reply updates inside thread pages
- Realtime vote/stat/category updates

## Local setup

1. Install Node.js 20 or newer.
2. Open the project folder in a terminal.
3. Install dependencies:

```bash
npm install
```

4. Create your environment file:

```bash
cp .env.example .env
```

5. Edit `.env` and set these before launch:

```env
JWT_SECRET=use-a-long-random-secret-here
ADMIN_EMAIL=your-real-email@example.com
ADMIN_PASSWORD=use-a-strong-12-plus-character-password
ADMIN_USERNAME=aion-admin
ADMIN_DISPLAY_NAME=AION Admin
SEED_SAMPLE_CONTENT=false
```

6. Start the website and realtime API:

```bash
npm start
```

7. Open:

```text
http://localhost:3000
```

## Important: remove old fake/demo forum data

If you already ran the previous package, it created seeded demo threads. To start clean with only real posts, run this once inside the updated project folder:

```bash
npm run db:reset
```

The reset rebuilds the database schema, keeps the real categories, and creates only your admin account from `.env`.

## Admin account behavior

For production, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before the first start.

For local development only, if the database is empty and no admin credentials are provided, the app creates:

```text
Email: admin@aionos.local
Password: change-me-now
```

Do not use that local account on a public site.

## Realtime behavior

Open `community.html` in two browser windows. When one user creates a topic, the other window updates automatically. Open the same thread in two windows. When one user replies, the other window receives the reply without refreshing.

Socket.IO is served automatically from:

```text
/socket.io/socket.io.js
```

No extra frontend setup is needed.

## Going live quickly with SQLite

SQLite is fine for an early public launch if the app runs as a single Node.js instance and the database file is stored on a persistent disk/volume.

Before publishing publicly:

1. Set `NODE_ENV=production`.
2. Set a strong `JWT_SECRET`.
3. Set `COOKIE_SECURE=true` when using HTTPS.
4. Set a real `ADMIN_EMAIL` and strong `ADMIN_PASSWORD`.
5. Keep `SEED_SAMPLE_CONTENT=false`.
6. Use a persistent disk/volume for the database.
7. Back up `database/aionos.db` regularly.
8. Do not run multiple app instances against the same SQLite file.

For a larger forum later, migrate the schema to PostgreSQL and use a Socket.IO Redis adapter for multi-instance realtime.

## Docker option

```bash
docker compose up --build
```

The included compose file mounts a persistent volume at `/data`, and the Dockerfile defaults to:

```env
DATABASE_PATH=/data/aionos.db
```

## Image mapping

Your uploaded images were optimized and mapped like this:

- `aion1.png` → `assets/hero-meet-aion.webp`
- `aion2.png` → `assets/productivity.webp`
- `aion3.png` → `assets/native-blur.webp`
- `aion4.png` → `assets/vscode-refined.webp`
- `aion5.png` → `assets/lock-login-charging.webp`
- `aion6.png` → `assets/steam-gaming.webp`
- `aion7.png` → `assets/ros2.webp`
- `aion8.png` → `assets/devices.webp`

Each image also has a `-thumb.webp` version for lighter previews.
