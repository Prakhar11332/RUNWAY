# Runway server — step-by-step setup

This is the real backend for the Runway frontend. It replaces
localStorage-only storage with actual accounts, adds a real Claude API
call for prioritization, and a real Google Calendar + autonomous
task-breakdown flow.

## 1. Install dependencies

```bash
cd taskpilot-server
npm install
```

(`better-sqlite3` was deliberately avoided — this project uses a plain
JSON file as the database so it runs with zero native compilation. See
the swap-in note at the bottom of `src/db.js` for moving to a real DB.)

## 2. Create your `.env` file

```bash
cp .env.example .env
```

Then open `.env` and fill in:

- `GEMINI_API_KEY` — get one at https://aistudio.google.com/app/apikey
  Required for `/api/ai/rank` and `/api/autopilot/breakdown`. Without it,
  those two routes return a clean 503 — nothing crashes, the frontend
  just falls back to the local heuristic ranking.
- `JWT_SECRET` — any long random string. Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — only needed for real
  calendar sync. See step 4 below. Leave blank to skip calendar features.

## 3. Run the server

```bash
npm start
```

You should see:
```
Runway server listening on http://localhost:3000
```

Check it's alive:
```bash
curl http://localhost:3000/api/health
```

## 4. (Optional) Set up Google Calendar

1. Go to https://console.cloud.google.com and create a new project.
2. In "APIs & Services" -> "Library", search for and enable the
   Google Calendar API.
3. In "APIs & Services" -> "Credentials", click "Create Credentials" ->
   "OAuth client ID". Choose Web application.
4. Under "Authorized redirect URIs", add exactly:
   `http://localhost:3000/api/calendar/callback`
5. Copy the generated Client ID and Client Secret into your `.env`.
6. Restart the server. `calendarConfigured` in `/api/health` should now
   be `true`.

Note: while your Google Cloud OAuth app is in "Testing" mode, only
email addresses you've explicitly added as test users can connect.
Publish the app (or add yourself as a test user) under "OAuth consent
screen" settings.

## 5. Point the frontend at this server

The frontend's `js/api.js` has:
```js
const API_BASE = "http://localhost:3000/api";
```
Change this if you deploy the backend somewhere other than localhost.

Open `index.html` in a browser (or serve the `taskpilot` folder with
any static file server, e.g. `npx serve .` or VS Code's "Live Server").
Sign in with a name, email, and password (8+ characters) -- this now
creates a real account on the server.

## 6. What happens if the server isn't running at all

The frontend was built to degrade gracefully: if `taskpilot-server`
isn't running, signup/login silently falls back to the original
local-only mode (no password needed), and the AI panel falls back to
the local heuristic in `ai-engine.js`. Nothing breaks either way, but
none of your data will sync across devices or sessions until the
server is actually running and you've signed in with a password.

## API quick reference

| Method | Path | Auth? | Purpose |
|---|---|---|---|
| POST | /api/auth/signup | no | Create account, returns JWT |
| POST | /api/auth/login | no | Returns JWT |
| GET | /api/auth/me | yes | Current user |
| GET | /api/tasks | yes | List tasks |
| POST | /api/tasks | yes | Create task |
| PATCH | /api/tasks/:id | yes | Update task (e.g. mark done) |
| DELETE | /api/tasks/:id | yes | Delete task |
| POST | /api/tasks/profile | yes | Save goal/profession/style |
| POST | /api/ai/rank | yes | Real Claude-backed prioritization |
| GET | /api/calendar/connect?userId= | no* | Start Google OAuth |
| GET | /api/calendar/callback | no* | Google redirects here |
| GET | /api/calendar/status | yes | Is calendar connected? |
| POST | /api/calendar/sync | yes | Push one task to Google Calendar |
| POST | /api/autopilot/breakdown | yes | AI splits a task into subtasks + schedules them |

\* These two are full-page browser redirects, so they can't carry a
custom Authorization header -- the user's id travels in the query
string/OAuth state param instead. Fine for a personal project; in
production, sign or encrypt that value so it can't be tampered with.
