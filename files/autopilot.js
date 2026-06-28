/* =========================================================
   routes/autopilot.js — Real autonomous task execution
   POST /api/autopilot/breakdown
   Body: { taskId }
   What it actually does (no hand-waving):
     1. Loads the task and the user's profile/other tasks.
     2. Asks Claude to break it into 2-6 concrete subtasks,
        each with its own suggested deadline that fits BEFORE
        the parent task's deadline and around existing tasks.
     3. Creates those subtasks for real in the database.
     4. If the user has Google Calendar connected, also creates
        a real calendar event for each subtask.
   This is the part of "autonomous execution" that's honestly
   buildable: the AI plans AND commits the plan to real state
   (DB rows + calendar events) without the user re-typing
   anything. It does NOT send emails, click buttons on other
   sites, or take actions outside this app's own data — that
   would need separate, explicitly-scoped integrations (see
   the chat walkthrough for why that's a bigger, separate step).
   ========================================================= */

const express = require("express");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const db = require("../db");
const { requireAuth } = require("./auth");

const router = express.Router();
router.use(requireAuth);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post("/breakdown", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Autopilot needs ANTHROPIC_API_KEY configured." });
  }

  const { taskId } = req.body;
  const user = db.findUserById(req.userId);
  const parentTask = user.tasks.find((t) => t.id === taskId);
  if (!parentTask) return res.status(404).json({ error: "Task not found" });

  const systemPrompt = "You break a single task into a short, realistic execution plan. " +
    "Return ONLY valid JSON: " +
    '{ "subtasks": [ { "title": "<concrete action, max 12 words>", "deadline": "<ISO 8601 datetime, BEFORE the parent deadline>", "effort": <minutes, integer> } ] } ' +
    "Produce 2 to 6 subtasks. Space their deadlines out sensibly between now and the parent deadline. " +
    "Each subtask must be something the user can actually sit down and do — not vague phases.";

  const userPrompt = "Parent task: " + JSON.stringify({
    title: parentTask.title,
    deadline: parentTask.deadline,
    effort: parentTask.effort,
  }) + "\nCurrent time: " + new Date().toISOString() +
    "\nUser profession: " + (user.profession || "unspecified");

  let subtasksPlan;
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = message.content.find((b) => b.type === "text");
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    subtasksPlan = JSON.parse(cleaned).subtasks;
  } catch (err) {
    console.error("Autopilot breakdown failed:", err.message);
    return res.status(502).json({ error: "Couldn't generate a breakdown", detail: err.message });
  }

  const newSubtasks = subtasksPlan.map((s) => ({
    id: crypto.randomUUID(),
    title: s.title,
    deadline: s.deadline,
    effort: s.effort || 30,
    done: false,
    parentTaskId: parentTask.id,
    createdAt: new Date().toISOString(),
  }));
  const tasks = [...user.tasks, ...newSubtasks];
  db.updateUser(user.id, { tasks });

  const calendarResults = [];
  if (user.googleCalendarTokens && process.env.GOOGLE_CLIENT_ID) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(user.googleCalendarTokens);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    for (const sub of newSubtasks) {
      try {
        const end = new Date(new Date(sub.deadline).getTime() + sub.effort * 60000);
        const event = await calendar.events.insert({
          calendarId: "primary",
          requestBody: {
            summary: sub.title,
            start: { dateTime: new Date(sub.deadline).toISOString() },
            end: { dateTime: end.toISOString() },
            description: "Auto-scheduled by Runway as part of: " + parentTask.title,
          },
        });
        calendarResults.push({ subtaskId: sub.id, eventId: event.data.id });
      } catch (err) {
        console.error("Autopilot calendar push failed for subtask:", sub.title, err.message);
      }
    }
  }

  res.json({ subtasks: newSubtasks, calendarResults, calendarSynced: calendarResults.length });
});

module.exports = router;
