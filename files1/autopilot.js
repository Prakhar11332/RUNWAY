/* =========================================================
   routes/autopilot.js — Real autonomous task execution (Gemini version)
   POST /api/autopilot/breakdown
   Body: { taskId }

   Same behavior as the Claude version: asks the model to split
   a task into concrete subtasks with deadlines, then actually
   commits that plan — creates real subtask rows in the DB, and
   real calendar events if Google Calendar is connected. Only
   the model call itself differs (Gemini instead of Claude).
   ========================================================= */

const express = require("express");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const db = require("./db");
const { requireAuth } = require("./auth");

const router = express.Router();
router.use(requireAuth);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

router.post("/breakdown", async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "Autopilot needs GEMINI_API_KEY configured." });
  }

  const { taskId } = req.body;
  const user = db.findUserById(req.userId);
  const parentTask = user.tasks.find((t) => t.id === taskId);
  if (!parentTask) return res.status(404).json({ error: "Task not found" });

  const instructions = "You break a single task into a short, realistic execution plan. " +
    "Respond with JSON matching exactly this shape: " +
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
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: instructions + "\n\n" + userPrompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text;
    if (!text) throw new Error("No text content in model response");
    const cleaned = text.replace(/```json|```/g, "").trim();
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
