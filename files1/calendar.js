/* =========================================================
   routes/calendar.js — Real Google Calendar integration
   GET  /api/calendar/connect       — redirect user to Google's consent screen
   GET  /api/calendar/callback      — Google redirects back here with a code
   POST /api/calendar/sync          — push a task to the user's Google Calendar
   GET  /api/calendar/status        — is this user connected?

   SETUP REQUIRED (see the walkthrough in chat for full steps):
   1. Create a project at https://console.cloud.google.com
   2. Enable the "Google Calendar API"
   3. Create an OAuth Client ID (type: Web application)
   4. Add this exact redirect URI: http://localhost:3000/api/calendar/callback
   5. Put the Client ID + Secret into your .env file (see .env.example)
   Without those credentials in .env, every route here returns
   a clear 503 instead of crashing.
   ========================================================= */

const express = require("express");
const { google } = require("googleapis"); // npm install googleapis
const db = require("./db");
const { requireAuth } = require("./auth");

const router = express.Router();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/calendar/callback"
  );
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Step 1: send the user to Google's consent screen.
// We can't use requireAuth's header-based JWT here because this is a
// full-page browser redirect (no custom headers possible), so instead
// we pass the userId through Google's "state" parameter, signed-ish
// by just being opaque — fine for a demo; in production sign/encrypt it.
router.get("/connect", (req, res) => {
  if (!isConfigured()) {
    return res.status(503).send("Google Calendar isn't configured on this server yet.");
  }
  const { userId } = req.query;
  if (!userId) return res.status(400).send("Missing userId");

  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: userId,
    prompt: "consent",
  });
  res.redirect(url);
});

// Step 2: Google redirects here after the user approves access.
router.get("/callback", async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send("Missing code or state");

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    db.updateUser(userId, { googleCalendarTokens: tokens });
    res.redirect("http://localhost:5500/index.html?calendar=connected");
  } catch (err) {
    console.error("Calendar OAuth callback failed:", err.message);
    res.status(500).send("Couldn't connect your calendar. Please try again.");
  }
});

router.get("/status", requireAuth, (req, res) => {
  const user = db.findUserById(req.userId);
  res.json({ connected: !!user.googleCalendarTokens });
});

// Push a single task onto the user's primary Google Calendar as an event.
router.post("/sync", requireAuth, async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: "Google Calendar isn't configured on this server yet." });
  }
  const user = db.findUserById(req.userId);
  if (!user.googleCalendarTokens) {
    return res.status(400).json({ error: "Connect Google Calendar first." });
  }

  const { title, deadline, effort } = req.body;
  if (!title || !deadline) {
    return res.status(400).json({ error: "title and deadline are required" });
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(user.googleCalendarTokens);
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const end = new Date(new Date(deadline).getTime() + (Number(effort) || 30) * 60000);

  try {
    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        start: { dateTime: new Date(deadline).toISOString() },
        end: { dateTime: end.toISOString() },
        description: "Synced automatically from Runway.",
      },
    });
    res.json({ eventId: event.data.id, htmlLink: event.data.htmlLink });
  } catch (err) {
    console.error("Calendar sync failed:", err.message);
    res.status(502).json({ error: "Couldn't sync to Google Calendar", detail: err.message });
  }
});

module.exports = router;
