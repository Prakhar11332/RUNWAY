/* =========================================================
   api.js — Thin wrapper around fetch() for talking to the
   real backend (taskpilot-server). Every other frontend file
   calls THESE functions instead of touching fetch/localStorage
   directly, so swapping API shape later means editing only
   this file.

   Set API_BASE to wherever your backend actually runs.
   ========================================================= */

const RunwayAPI = (() => {
  const API_BASE = "http://localhost:3000/api";
  const TOKEN_KEY = "runway_token_v1";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }
  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  async function request(path, options) {
    options = options || {};
    const method = options.method || "GET";
    const body = options.body;

    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;

    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || ("Request failed: " + res.status));
    }
    return data;
  }

  return {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,

    signup: function (name, email, password) {
      return request("/auth/signup", { method: "POST", body: { name, email, password } });
    },

    login: function (email, password) {
      return request("/auth/login", { method: "POST", body: { email, password } });
    },

    me: function () {
      return request("/auth/me");
    },

    saveProfile: function (goal, profession, style) {
      return request("/tasks/profile", { method: "POST", body: { goal, profession, style } });
    },

    listTasks: function () {
      return request("/tasks");
    },

    addTask: function (title, deadline, effort) {
      return request("/tasks", { method: "POST", body: { title, deadline, effort } });
    },

    updateTask: function (id, updates) {
      return request("/tasks/" + id, { method: "PATCH", body: updates });
    },

    deleteTask: function (id) {
      return request("/tasks/" + id, { method: "DELETE" });
    },

    rankWithAI: function (tasks, profile) {
      return request("/ai/rank", { method: "POST", body: { tasks: tasks, profile: profile } });
    },

    connectCalendarUrl: function (userId) {
      return API_BASE + "/calendar/connect?userId=" + encodeURIComponent(userId);
    },

    calendarStatus: function () {
      return request("/calendar/status");
    },

    syncTaskToCalendar: function (title, deadline, effort) {
      return request("/calendar/sync", { method: "POST", body: { title, deadline, effort } });
    },

    breakdownTask: function (taskId) {
      return request("/autopilot/breakdown", { method: "POST", body: { taskId } });
    },
  };
})();
