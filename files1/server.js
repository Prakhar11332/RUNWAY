/* =========================================================
   server.js — Entry point. Wires every route module together.
   Run with: npm start  (after creating .env from .env.example)
   ========================================================= */

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { router: authRouter } = require("./auth");

const aiRouter = require("./ai");
const calendarRouter = require("./calendar");
const autopilotRouter = require("./autopilot");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRouter);

app.use("/api/ai", aiRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/autopilot", autopilotRouter);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    aiConfigured: !!process.env.GEMINI_API_KEY,
    calendarConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Runway server listening on http://localhost:" + PORT);
});
