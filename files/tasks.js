/* =========================================================
   routes/tasks.js — Task CRUD against the real backend
   All routes require a valid JWT (see requireAuth in auth.js).
   This replaces app.js's direct localStorage reads/writes —
   the BROWSER no longer owns the data; the SERVER does.
   ========================================================= */

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, publicUser } = require("./auth");

const router = express.Router();
router.use(requireAuth); // every route below needs a logged-in user

router.get("/", (req, res) => {
  const user = db.findUserById(req.userId);
  res.json({ tasks: user.tasks });
});

router.post("/", (req, res) => {
  const { title, deadline, effort } = req.body;
  if (!title || !deadline) {
    return res.status(400).json({ error: "title and deadline are required" });
  }

  const user = db.findUserById(req.userId);
  const task = {
    id: crypto.randomUUID(),
    title,
    deadline,
    effort: effort || 30,
    done: false,
    createdAt: new Date().toISOString(),
  };
  const tasks = [...user.tasks, task];
  db.updateUser(user.id, { tasks });

  res.status(201).json({ task, tasks });
});

router.patch("/:id", (req, res) => {
  const user = db.findUserById(req.userId);
  const idx = user.tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Task not found" });

  const updatedTask = { ...user.tasks[idx], ...req.body };
  const tasks = [...user.tasks];
  tasks[idx] = updatedTask;

  // If this PATCH just marked the task done, award points + streak server-side
  // (mirrors app.js's pointsFor/bumpStreak — see ai.js comment below on why
  // this kind of game logic stays here rather than trusting the client).
  let pointsAwarded = 0;
  if (updatedTask.done && !user.tasks[idx].done) {
    pointsAwarded = 10 + Math.round((Number(updatedTask.effort) || 30) / 10);
    if (new Date(updatedTask.deadline) > new Date()) pointsAwarded += 5;
  }

  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  let { points, streak, lastCompletionDate } = user;
  if (pointsAwarded > 0) {
    points += pointsAwarded;
    if (lastCompletionDate !== today) {
      streak = lastCompletionDate === yesterday ? streak + 1 : 1;
      lastCompletionDate = today;
    }
  }

  db.updateUser(user.id, { tasks, points, streak, lastCompletionDate });
  res.json({ task: updatedTask, points, streak });
});

router.delete("/:id", (req, res) => {
  const user = db.findUserById(req.userId);
  const tasks = user.tasks.filter((t) => t.id !== req.params.id);
  db.updateUser(user.id, { tasks });
  res.json({ tasks });
});

// Save onboarding answers (goal / profession / style)
router.post("/profile", (req, res) => {
  const { goal, profession, style } = req.body;
  const user = db.updateUser(req.userId, { goal, profession, style });
  res.json({ user: publicUser(user) });
});

module.exports = router;
