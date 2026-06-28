/* =========================================================
   routes/auth.js — Real accounts (replaces localStorage-only auth)
   POST /api/auth/signup  — create account, hash password, return JWT
   POST /api/auth/login   — verify password, return JWT
   GET  /api/auth/me      — return the logged-in user (requires JWT)
   ========================================================= */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";

// Middleware: verifies the JWT sent in the Authorization header
// and attaches the decoded user id to req.userId for downstream routes.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

router.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existing = db.findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash,
    goal: null,
    profession: null,
    style: null,
    points: 0,
    streak: 0,
    lastCompletionDate: null,
    tasks: [],
    googleCalendarTokens: null, // filled in once calendar is connected
  };
  db.createUser(user);

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = db.findUserByEmail(email);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password" });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: publicUser(user) });
});

router.get("/me", requireAuth, (req, res) => {
  const user = db.findUserById(req.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user: publicUser(user) });
});

// Never send the password hash (or raw calendar tokens) to the browser.
function publicUser(user) {
  const { passwordHash, googleCalendarTokens, ...safe } = user;
  return { ...safe, calendarConnected: !!googleCalendarTokens };
}

module.exports = { router, requireAuth, publicUser };
