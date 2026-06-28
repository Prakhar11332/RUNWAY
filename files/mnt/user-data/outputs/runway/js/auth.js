/* =========================================================
   auth.js — Login + Onboarding
   Handles: local "login", 3-step onboarding wizard, and
   persisting the user's profile (goal / profession / style)
   to localStorage so app.js and ai-engine.js can read it.

   This file is intentionally self-contained — vibe-code here
   freely (swap localStorage for a real backend, add OAuth,
   add more onboarding steps) without touching app.js logic.
   ========================================================= */

const RunwayAuth = (() => {
  const STORAGE_KEY = "runway_user_v1";

  let state = {
    name: "",
    email: "",
    goal: null,
    profession: null,
    style: null,
    currentStep: 1,
  };

  function loadUser() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveUser(user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  }

  function clearUser() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("screen--active"));
    document.getElementById(id).classList.add("screen--active");
  }

  // Tries the real backend first (signup, falling back to login if the
  // email already exists). If the backend can't be reached at all (e.g.
  // you're just opening index.html with no server running), falls back
  // to the original local-only flow so the demo still works standalone.
  function initLogin() {
    const form = document.getElementById("loginForm");
    const errorEl = document.getElementById("loginError");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("loginName").value.trim();
      const email = document.getElementById("loginEmail").value.trim();
      const passwordInput = document.getElementById("loginPassword");
      const password = passwordInput ? passwordInput.value : "";
      if (!name || !email) return;
      if (errorEl) errorEl.textContent = "";

      state.name = name;
      state.email = email;

      const hasBackend = window.RunwayAPI && password;
      if (hasBackend) {
        try {
          let result;
          try {
            result = await window.RunwayAPI.signup(name, email, password);
          } catch (signupErr) {
            // Most likely "account already exists" — try logging in instead.
            result = await window.RunwayAPI.login(email, password);
          }
          window.RunwayAPI.setToken(result.token);
          saveUser(result.user); // local mirror, used as instant-read cache

          if (result.user.goal) {
            window.RunwayApp && window.RunwayApp.boot();
            showScreen("screen-dashboard");
          } else {
            showScreen("screen-onboarding");
          }
          return;
        } catch (err) {
          console.warn("Backend auth failed, falling back to local-only mode:", err.message);
          if (errorEl) errorEl.textContent = "Couldn't reach the server — continuing in local-only mode.";
        }
      }

      // Local-only fallback (no backend running, or no password provided).
      const existing = loadUser();
      if (existing && existing.email === email && existing.goal) {
        saveUser({ ...existing, name });
        window.RunwayApp && window.RunwayApp.boot();
        showScreen("screen-dashboard");
      } else {
        showScreen("screen-onboarding");
      }
    });
  }

  function selectChoice(grid, key) {
    grid.querySelectorAll(".choice-card").forEach((card) => {
      card.addEventListener("click", () => {
        grid.querySelectorAll(".choice-card").forEach((c) => c.classList.remove("is-selected"));
        card.classList.add("is-selected");
        state[key] = card.dataset[key];
        updateNavButtons();
      });
    });
  }

  function updateNavButtons() {
    const nextBtn = document.getElementById("onboardNext");
    const backBtn = document.getElementById("onboardBack");
    const step = state.currentStep;

    backBtn.disabled = step === 1;

    const keyForStep = { 1: "goal", 2: "profession", 3: "style" };
    const hasAnswer = !!state[keyForStep[step]];
    nextBtn.disabled = !hasAnswer;
    nextBtn.textContent = step === 3 ? "Finish →" : "Continue →";
  }

  function goToStep(step) {
    document.querySelectorAll(".onboard-step").forEach((s) => {
      s.classList.toggle("onboard-step--active", Number(s.dataset.step) === step);
    });
    document.querySelectorAll(".dot").forEach((d) => {
      const n = Number(d.dataset.step);
      d.classList.toggle("dot--active", n === step);
      d.classList.toggle("dot--done", n < step);
    });
    state.currentStep = step;
    updateNavButtons();
  }

  async function finishOnboarding() {
    const user = {
      name: state.name,
      email: state.email,
      goal: state.goal,
      profession: state.profession,
      style: state.style,
      points: 0,
      streak: 0,
      lastCompletionDate: null,
      tasks: [],
    };
    saveUser(user);

    // If we have a real session token, persist the profile server-side too.
    if (window.RunwayAPI && window.RunwayAPI.getToken()) {
      try {
        await window.RunwayAPI.saveProfile(state.goal, state.profession, state.style);
      } catch (err) {
        console.warn("Couldn't save profile to backend, continuing locally:", err.message);
      }
    }

    window.RunwayApp && window.RunwayApp.boot();
    showScreen("screen-dashboard");
  }

  function initOnboarding() {
    selectChoice(document.getElementById("goalGrid"), "goal");
    selectChoice(document.getElementById("professionGrid"), "profession");
    selectChoice(document.getElementById("styleGrid"), "style");

    document.getElementById("onboardNext").addEventListener("click", () => {
      if (state.currentStep < 3) {
        goToStep(state.currentStep + 1);
      } else {
        finishOnboarding();
      }
    });

    document.getElementById("onboardBack").addEventListener("click", () => {
      if (state.currentStep > 1) goToStep(state.currentStep - 1);
    });

    updateNavButtons();
  }

  function initLogout() {
    document.getElementById("logoutBtn").addEventListener("click", () => {
      clearUser();
      if (window.RunwayAPI) window.RunwayAPI.clearToken();
      state = { name: "", email: "", goal: null, profession: null, style: null, currentStep: 1 };
      showScreen("screen-login");
    });

    document.getElementById("editProfileBtn").addEventListener("click", () => {
      goToStep(1);
      document.querySelectorAll(".choice-card").forEach((c) => c.classList.remove("is-selected"));
      showScreen("screen-onboarding");
    });
  }

  function initThemeToggle() {
    const STORAGE_THEME_KEY = "runway_theme_v1";
    const btn = document.getElementById("themeToggle");
    const icon = btn.querySelector(".theme-toggle__icon");

    function applyTheme(theme) {
      document.body.dataset.theme = theme;
      icon.textContent = theme === "dark" ? "🌙" : "☀️";
      localStorage.setItem(STORAGE_THEME_KEY, theme);
    }

    const saved = localStorage.getItem(STORAGE_THEME_KEY) || "dark";
    applyTheme(saved);

    btn.addEventListener("click", () => {
      const next = document.body.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }

  function init() {
    initThemeToggle();
    initLogin();
    initOnboarding();
    initLogout();

    // Auto-resume session if a profile already exists
    const existing = loadUser();
    if (existing && existing.goal) {
      window.RunwayApp && window.RunwayApp.boot();
      showScreen("screen-dashboard");
    } else {
      showScreen("screen-login");
    }
  }

  return { init, loadUser, saveUser, showScreen };
})();

document.addEventListener("DOMContentLoaded", RunwayAuth.init);
