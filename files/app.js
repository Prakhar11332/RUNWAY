/* =========================================================
   app.js — Task engine + UI glue
   Owns: task storage/CRUD, points & streak, the "shiver near
   deadline" watcher, the all-done celebration video, and
   voice-enabled task entry (Web Speech API).

   Reads/writes the same localStorage user object auth.js
   creates, and calls RunwayAI for all ranking/recommendation
   logic — this file never computes priority itself.
   ========================================================= */

const RunwayApp = (() => {
  const STORAGE_KEY = "runway_user_v1";
  let user = null;
  let shiverInterval = null;

  // Holds the latest result from the real backend /ai/rank call, keyed by
  // task id -> { priority, reasoning }, plus the latest headline/recs.
  // render() prefers this when present; RunwayAI's local heuristic (from
  // ai-engine.js) is the instant value shown before the network call
  // resolves, and the permanent fallback if the call fails entirely.
  let llmRanking = null; // { byId: {...}, headline, recommendations } | null
  let llmRequestInFlight = false;

  function hasBackend() {
    return !!(window.RunwayAPI && window.RunwayAPI.getToken());
  }

  // Fire-and-forget: ask the real backend (which calls Claude) to rank the
  // current tasks. Cheap local heuristic ranking is already on screen by
  // the time this resolves, so the UI updates smoothly rather than
  // blocking on network latency.
  async function refreshAiRanking() {
    if (!hasBackend() || llmRequestInFlight) return;
    if (user.tasks.filter((t) => !t.done).length === 0) {
      llmRanking = null;
      return;
    }
    llmRequestInFlight = true;
    try {
      const profile = { goal: user.goal, profession: user.profession, style: user.style };
      const result = await window.RunwayAPI.rankWithAI(user.tasks, profile);
      const byId = {};
      (result.ranked || []).forEach((r) => { byId[r.id] = r; });
      llmRanking = { byId, headline: result.headline, recommendations: result.recommendations };
      renderTaskList();
      renderAiPanel();
    } catch (err) {
      // 503 = not configured, anything else = transient failure. Either way,
      // we just keep using the local heuristic — no error shown to the user,
      // since the local ranking is already a complete, working answer.
      console.warn("Real AI ranking unavailable, using local heuristic:", err.message);
      llmRanking = null;
    } finally {
      llmRequestInFlight = false;
    }
  }

  function getUser() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  }

  // ---------------- TASK CRUD ----------------
  // Each function tries the real backend first (so data is durable across
  // devices/sessions) and falls back to pure localStorage if the backend
  // call fails — e.g. no server running, offline, or token expired. The
  // local `user.tasks` array is always updated either way, so render()
  // never needs to know which path was taken.
  async function addTask(title, deadline, effort) {
    const localTask = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      title,
      deadline,
      effort,
      done: false,
      createdAt: new Date().toISOString(),
    };

    if (hasBackend()) {
      try {
        const result = await window.RunwayAPI.addTask(title, deadline, effort);
        user.tasks = result.tasks;
        persist();
        render();
        return;
      } catch (err) {
        console.warn("Backend addTask failed, saving locally only:", err.message);
      }
    }

    user.tasks.push(localTask);
    persist();
    render();
  }

  async function toggleTask(id) {
    const task = user.tasks.find((t) => t.id === id);
    if (!task) return;
    const wasDone = task.done;
    task.done = !task.done;

    if (hasBackend()) {
      try {
        const result = await window.RunwayAPI.updateTask(id, { done: task.done });
        // Trust the server's point/streak math — it's the source of truth
        // so a user can't inflate points by editing client-side JS.
        if (typeof result.points === "number") user.points = result.points;
        if (typeof result.streak === "number") user.streak = result.streak;
        persist();
        render();
        if (task.done) maybeCelebrate();
        return;
      } catch (err) {
        console.warn("Backend toggleTask failed, applying locally only:", err.message);
        task.done = wasDone ? false : true; // keep the optimistic flip we already made
      }
    }

    if (task.done) {
      awardPoints(task);
      bumpStreak();
    } else {
      user.points = Math.max(0, user.points - pointsFor(task));
    }
    persist();
    render();

    if (task.done) maybeCelebrate();
  }

  async function deleteTask(id) {
    if (hasBackend()) {
      try {
        const result = await window.RunwayAPI.deleteTask(id);
        user.tasks = result.tasks;
        persist();
        render();
        return;
      } catch (err) {
        console.warn("Backend deleteTask failed, applying locally only:", err.message);
      }
    }
    user.tasks = user.tasks.filter((t) => t.id !== id);
    persist();
    render();
  }

  // ---------------- REWARDS ----------------
  function pointsFor(task) {
    const effortMinutes = Number(task.effort) || 30;
    const base = 10;
    const effortBonus = Math.round(effortMinutes / 10); // longer tasks pay more
    const deadline = new Date(task.deadline);
    const earlyBonus = deadline > new Date() ? 5 : 0; // finished before due
    return base + effortBonus + earlyBonus;
  }

  function awardPoints(task) {
    const pts = pointsFor(task);
    user.points += pts;
    flashXp();
  }

  function flashXp() {
    const dial = document.getElementById("xpDial");
    dial.style.transform = "scale(1.15)";
    setTimeout(() => (dial.style.transform = "scale(1)"), 220);
  }

  function bumpStreak() {
    const today = new Date().toDateString();
    if (user.lastCompletionDate === today) return; // already counted today
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    if (user.lastCompletionDate === yesterday) {
      user.streak += 1;
    } else if (user.lastCompletionDate !== today) {
      user.streak = 1;
    }
    user.lastCompletionDate = today;
  }

  // ---------------- CELEBRATION ----------------
  function maybeCelebrate() {
    const hasTasks = user.tasks.length > 0;
    const allDone = hasTasks && user.tasks.every((t) => t.done);
    if (allDone) {
      const overlay = document.getElementById("celebrationOverlay");
      overlay.classList.add("is-active");
      const video = document.getElementById("celebrationVideo");
      video.play().catch(() => {}); // autoplay may be blocked silently
    }
  }

  function closeCelebration() {
    document.getElementById("celebrationOverlay").classList.remove("is-active");
  }

  // ---------------- RENDER ----------------
  function render() {
    renderHeader();
    renderTaskList();
    renderAiPanel();
    renderStats();
    renderProfile();
    renderStreak();
    refreshAiRanking(); // async — re-renders task list/AI panel again once it resolves
  }

  function renderHeader() {
    document.getElementById("userNameDisplay").textContent = user.name;
    document.getElementById("userAvatar").textContent = (user.name[0] || "?").toUpperCase();
    document.getElementById("xpValue").textContent = user.points;

    // Ring fills toward a soft cap of 200 points, then loops visually
    const pct = Math.min((user.points % 200) / 200, 1);
    const circumference = 176; // 2*pi*28
    const offset = circumference - pct * circumference;
    document.getElementById("xpRing").style.strokeDashoffset = offset;
  }

  function renderTaskList() {
    const ranked = RunwayAI.rankTasks(user.tasks);
    const listEl = document.getElementById("taskList");
    const trackEl = document.getElementById("runwayTrack");
    listEl.innerHTML = "";

    trackEl.classList.toggle("is-empty", user.tasks.length === 0);

    ranked.forEach((task) => {
      // Overlay the real Claude-backed ranking when we have one for this
      // task; otherwise keep the instant local heuristic's priority.
      const llm = llmRanking && llmRanking.byId[task.id];
      const priority = llm ? llm.priority : task.priority;
      const reasoning = llm ? llm.reasoning : null;

      const card = document.createElement("div");
      const priorityClass = task.done ? "" : `priority-${priority}`;
      card.className = `task-card ${priorityClass} ${task.done ? "is-done" : ""} ${
        !task.done && task.isUrgent ? "is-urgent is-shivering" : ""
      }`;
      card.dataset.id = task.id;

      const deadlineDate = new Date(task.deadline);
      const dateLabel = deadlineDate.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

      const badge = task.done
        ? ""
        : `<span class="task-card__badge badge-${priority}">${
            task.isOverdue ? "Overdue" : priority
          }</span>`;

      const reasoningHtml = reasoning
        ? `<div class="task-card__reasoning">🤖 ${escapeHtml(reasoning)}</div>`
        : "";

      card.innerHTML = `
        <button class="task-card__check" aria-label="Mark complete">${task.done ? "✓" : ""}</button>
        <div class="task-card__body">
          <div class="task-card__title">${escapeHtml(task.title)}</div>
          <div class="task-card__meta">
            <span>${dateLabel}</span>
            <span>${task.effort} min</span>
            ${badge}
          </div>
          ${reasoningHtml}
        </div>
        <div class="task-card__actions">
          <button class="task-card__breakdown" aria-label="Break this down with AI" title="Auto-break this into subtasks">🪄</button>
          <button class="task-card__del" aria-label="Delete task">✕</button>
        </div>
      `;

      card.querySelector(".task-card__check").addEventListener("click", () => toggleTask(task.id));
      card.querySelector(".task-card__del").addEventListener("click", () => deleteTask(task.id));
      card.querySelector(".task-card__breakdown").addEventListener("click", () => breakdownTask(task.id));

      listEl.appendChild(card);
    });
  }

  function renderAiPanel() {
    const activeRanked = RunwayAI.rankTasks(user.tasks).filter((t) => !t.done);

    const headline = (llmRanking && llmRanking.headline) || RunwayAI.headline(activeRanked);
    document.getElementById("aiHeadline").textContent = headline;

    const recs = (llmRanking && llmRanking.recommendations) || RunwayAI.recommend(activeRanked, user);
    const recEl = document.getElementById("aiRecommendations");
    recEl.innerHTML = "";
    recs.forEach((r) => {
      const li = document.createElement("li");
      li.className = r.type === "good" ? "rec-good" : r.type === "gold" ? "rec-gold" : "";
      li.textContent = r.text;
      recEl.appendChild(li);
    });
  }

  function renderStats() {
    const completed = user.tasks.filter((t) => t.done).length;
    const pending = user.tasks.filter((t) => !t.done).length;
    const urgent = RunwayAI.rankTasks(user.tasks).filter((t) => !t.done && t.isUrgent).length;

    document.getElementById("statCompleted").textContent = completed;
    document.getElementById("statPending").textContent = pending;
    document.getElementById("statUrgent").textContent = urgent;
  }

  function renderProfile() {
    const labels = {
      goal: { career: "Career growth", study: "Studying / exams", business: "Building something", health: "Health & balance", creative: "Creative project", life: "Life admin & home" },
      profession: { student: "Student", engineer: "Engineer / Developer", designer: "Designer", founder: "Founder / Freelancer", manager: "Manager / Ops", other: "Something else" },
      style: { morning: "Early morning", afternoon: "Afternoon", night: "Late night", flexible: "It varies" },
    };
    document.getElementById("profileGoal").textContent = labels.goal[user.goal] || "—";
    document.getElementById("profileProfession").textContent = labels.profession[user.profession] || "—";
    document.getElementById("profileStyle").textContent = labels.style[user.style] || "—";
  }

  function renderStreak() {
    const row = document.getElementById("streakRow");
    row.innerHTML = "";
    const days = 7;
    for (let i = 0; i < days; i++) {
      const cell = document.createElement("div");
      cell.className = "streak-cell" + (i < Math.min(user.streak, days) ? " is-lit" : "");
      row.appendChild(cell);
    }
    document.getElementById("streakCount").textContent = user.streak;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------- LIVE SHIVER WATCHER ----------------
  // Re-checks every 30s so a task can start shivering the moment
  // it crosses into the 24h danger zone, even with no user action.
  function startShiverWatcher() {
    if (shiverInterval) clearInterval(shiverInterval);
    shiverInterval = setInterval(() => {
      if (document.getElementById("screen-dashboard").classList.contains("screen--active")) {
        renderTaskList();
        renderStats();
        renderAiPanel();
      }
    }, 30000);
  }

  // ---------------- TASK FORM ----------------
  function initTaskForm() {
    document.getElementById("taskForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const title = document.getElementById("taskTitle").value.trim();
      const deadline = document.getElementById("taskDeadline").value;
      const effort = document.getElementById("taskEffort").value;
      if (!title || !deadline) return;

      addTask(title, deadline, effort);
      e.target.reset();
      document.getElementById("taskEffort").value = "30";
    });
  }

  // ---------------- VOICE INPUT ----------------
  // Uses the Web Speech API where available. Falls back gracefully
  // (just tells the user it's not supported) rather than breaking.
  function initVoice() {
    const micBtn = document.getElementById("micBtn");
    const statusEl = document.getElementById("voiceStatus");
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      micBtn.addEventListener("click", () => {
        statusEl.textContent = "Voice input isn't supported in this browser.";
        setTimeout(() => (statusEl.textContent = ""), 3000);
      });
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;

    let listening = false;

    micBtn.addEventListener("click", () => {
      if (listening) {
        recognition.stop();
        return;
      }
      statusEl.textContent = "Listening…";
      micBtn.classList.add("is-listening");
      listening = true;
      recognition.start();
    });

    recognition.addEventListener("result", (e) => {
      const transcript = e.results[0][0].transcript;
      document.getElementById("taskTitle").value = transcript;
      statusEl.textContent = `Heard: "${transcript}" — set a deadline and add it.`;
      document.getElementById("taskTitle").focus();
    });

    recognition.addEventListener("end", () => {
      listening = false;
      micBtn.classList.remove("is-listening");
      setTimeout(() => (statusEl.textContent = ""), 4000);
    });

    recognition.addEventListener("error", () => {
      listening = false;
      micBtn.classList.remove("is-listening");
      statusEl.textContent = "Couldn't catch that — try again.";
      setTimeout(() => (statusEl.textContent = ""), 3000);
    });
  }

  function initCelebrationClose() {
    document.getElementById("celebrationClose").addEventListener("click", closeCelebration);
  }

  // ---------------- AUTOPILOT: AI TASK BREAKDOWN ----------------
  // Calls /api/autopilot/breakdown, which asks Claude to split a task into
  // concrete subtasks AND commits them (creates real task rows, and real
  // calendar events if connected) — see routes/autopilot.js for the actual
  // server-side logic. This is genuinely autonomous in the narrow sense:
  // the user clicks once, and the app both plans and acts on that plan.
  async function breakdownTask(taskId) {
    if (!hasBackend()) {
      alert("Connect to the Runway server (sign in with a password) to use AI breakdown.");
      return;
    }
    const card = document.querySelector(`.task-card[data-id="${taskId}"]`);
    const btn = card && card.querySelector(".task-card__breakdown");
    if (btn) { btn.disabled = true; btn.textContent = "⏳"; }

    try {
      const result = await window.RunwayAPI.breakdownTask(taskId);
      // Pull the fresh full task list from the server rather than guessing
      // the merge ourselves — simplest way to stay in sync after the
      // server appended several new subtasks server-side.
      const fresh = await window.RunwayAPI.listTasks();
      user.tasks = fresh.tasks;
      persist();
      render();

      const calendarNote = result.calendarSynced > 0
        ? ` ${result.calendarSynced} subtask(s) were also added to your Google Calendar.`
        : "";
      alert(`Broke this into ${result.subtasks.length} subtasks.${calendarNote}`);
    } catch (err) {
      console.warn("Autopilot breakdown failed:", err.message);
      alert("Couldn't break this task down right now: " + err.message);
      if (btn) { btn.disabled = false; btn.textContent = "🪄"; }
    }
  }

  // ---------------- GOOGLE CALENDAR ----------------
  function initCalendarConnect() {
    const btn = document.getElementById("connectCalendarBtn");
    if (!btn) return;

    btn.addEventListener("click", () => {
      if (!hasBackend()) {
        alert("Sign in with a password first so the server knows which account to connect.");
        return;
      }
      window.location.href = window.RunwayAPI.connectCalendarUrl(user.id);
    });

    if (hasBackend()) {
      window.RunwayAPI.calendarStatus()
        .then((status) => {
          if (status.connected) {
            btn.textContent = "✓ Calendar connected";
            btn.disabled = true;
          }
        })
        .catch(() => {}); // calendar route not configured yet — leave button as-is
    }
  }

  // Default deadline input to "tomorrow, same time" for convenience
  function setDefaultDeadline() {
    const input = document.getElementById("taskDeadline");
    const d = new Date(Date.now() + 86400000);
    d.setMinutes(0);
    input.value = d.toISOString().slice(0, 16);
  }

  // Pull the authoritative task list from the server on boot, so a user
  // logging in on a second device sees the same tasks — this is the part
  // that actually replaces "everything lives only in this browser."
  async function syncFromBackend() {
    if (!hasBackend()) return;
    try {
      const fresh = await window.RunwayAPI.listTasks();
      user.tasks = fresh.tasks;
      persist();
      render();
    } catch (err) {
      console.warn("Couldn't sync tasks from backend, using local cache:", err.message);
    }
  }

  // ---------------- BOOT ----------------
  function boot() {
    user = getUser();
    if (!user) return;
    if (!Array.isArray(user.tasks)) user.tasks = [];
    if (typeof user.points !== "number") user.points = 0;
    if (typeof user.streak !== "number") user.streak = 0;

    initTaskForm();
    initVoice();
    initCelebrationClose();
    initCalendarConnect();
    setDefaultDeadline();
    startShiverWatcher();
    render();
    syncFromBackend();
  }

  return { boot, toggleTask, deleteTask, breakdownTask };
})();
