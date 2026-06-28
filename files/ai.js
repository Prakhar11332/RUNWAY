/* =========================================================
   routes/ai.js — Real LLM-backed prioritization
   POST /api/ai/rank
   Body: { tasks: [...], profile: { goal, profession, style } }
   Returns: { ranked: [...with priority/reasoning], headline, recommendations }

   WHY THIS LIVES ON THE SERVER, NOT THE BROWSER:
   The Anthropic API key must never be shipped to client-side
   JS — anyone could open dev tools, read it from the network
   tab or bundle, and run up charges on your account. The
   browser calls THIS endpoint; this endpoint (which holds the
   key in a server-only environment variable) calls Anthropic.

   WHY WE STILL KEEP THE LOCAL HEURISTIC (ai-engine.js) AROUND:
   - It's the instant fallback if this endpoint is slow, rate
     limited, or the API key isn't configured yet.
   - It guarantees the UI never fully breaks without the LLM.
   The frontend calls this endpoint first; if it fails or times
   out, app.js falls back to RunwayAI's local scorer.
   ========================================================= */

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { requireAuth } = require("./auth");

const router = express.Router();
router.use(requireAuth);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // set in .env — never hardcode this
});

router.post("/rank", async (req, res) => {
  const { tasks, profile } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI ranking is not configured on this server yet." });
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.json({ ranked: [], headline: "Add a task to get started.", recommendations: [] });
  }

  const systemPrompt = "You are an embedded prioritization engine for a productivity app called Runway. " +
    "You receive a list of tasks with deadlines and effort estimates, plus the user's stated goal, " +
    "profession, and peak-focus time. Return ONLY valid JSON, no prose, no markdown fences, matching " +
    "exactly this shape: " +
    '{ "ranked": [ { "id": "<task id, unchanged>", "priority": "high|medium|low", "reasoning": "<one short sentence, max 18 words>" } ], ' +
    '"headline": "<one sentence summarizing the overall picture, max 25 words>", ' +
    '"recommendations": [ { "type": "warn|good|gold", "text": "<actionable, specific, max 30 words>" } ] } ' +
    'Order "ranked" with the task that should be done FIRST at index 0. Limit "recommendations" to at most 4 items. ' +
    "Be concrete and specific to the actual task titles and the user's profession/goal — avoid generic filler advice.";

  const userPrompt = "User profile: " + JSON.stringify(profile) +
    "\n\nCurrent time: " + new Date().toISOString() +
    "\n\nTasks:\n" + JSON.stringify(
      tasks.map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, effort: t.effort, done: t.done })),
      null, 2
    );

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("No text content in model response");

    // Defensive parse: strip accidental ```json fences if the model adds them anyway.
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    res.json(parsed);
  } catch (err) {
    console.error("AI ranking failed:", err.message);
    res.status(502).json({ error: "AI ranking failed, use local fallback", detail: err.message });
  }
});

module.exports = router;
