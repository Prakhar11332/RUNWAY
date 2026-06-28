/* =========================================================
   db.js — Minimal JSON-file "database"
   Why: better-sqlite3 / Postgres need native binaries or a
   running server, which makes a tutorial harder to just run.
   This file reads/writes one JSON file and exposes the same
   shape a real DB layer would (getUser, saveUser, etc.), so
   swapping to Postgres/SQLite later only means editing THIS
   file — nothing in server.js or routes/ has to change.

   PRODUCTION NOTE: a JSON file is not safe for concurrent
   writes at scale (race conditions if two requests write at
   once). Swap this for SQLite (better-sqlite3) or Postgres
   (pg) before you have real concurrent users. See the bottom
   of this file for the swap-in shape to aim for.
   ========================================================= */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [] };
  }
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return { users: [] };
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---- Public data access functions ----

function findUserByEmail(email) {
  const db = readDb();
  return db.users.find((u) => u.email === email) || null;
}

function findUserById(id) {
  const db = readDb();
  return db.users.find((u) => u.id === id) || null;
}

function createUser(user) {
  const db = readDb();
  db.users.push(user);
  writeDb(db);
  return user;
}

function updateUser(id, updates) {
  const db = readDb();
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  db.users[idx] = { ...db.users[idx], ...updates };
  writeDb(db);
  return db.users[idx];
}

module.exports = { findUserByEmail, findUserById, createUser, updateUser };

/* ---------------------------------------------------------
   SWAP-IN SHAPE FOR A REAL DATABASE (e.g. with better-sqlite3):

   const Database = require("better-sqlite3");
   const db = new Database("runway.db");
   db.exec(`CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, email TEXT UNIQUE, passwordHash TEXT,
     name TEXT, goal TEXT, profession TEXT, style TEXT,
     points INTEGER, streak INTEGER, lastCompletionDate TEXT,
     tasksJson TEXT
   )`);

   function findUserByEmail(email) {
     return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
   }
   // ...same function names, same signatures, different internals.
   --------------------------------------------------------- */
