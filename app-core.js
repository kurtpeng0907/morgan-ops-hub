"use strict";

// Browser-safe domain helpers. Keep this file free of DOM and network access so
// the operations UI can reuse and test data normalization independently.
(function exposeMorganAppCore(root) {
  function cleanPin(value = "") {
    return String(value ?? "").replace(/^'/, "").trim();
  }

  function sheetText(value = "") {
    const text = cleanPin(value);
    return /^0\d+/.test(text) ? `'${text}` : text;
  }

  function pinMatches(stored, entered) {
    const storedText = cleanPin(stored);
    const enteredText = cleanPin(entered);
    if (storedText === enteredText) return true;
    return /^\d+$/.test(storedText) && /^\d+$/.test(enteredText)
      && storedText.replace(/^0+/, "") === enteredText.replace(/^0+/, "");
  }

  function timeToMinutes(value = "00:00") {
    const [hours = 0, minutes = 0] = String(value).split(":").map(Number);
    return hours * 60 + minutes;
  }

  function minsToTime(minutes) {
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function toDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function normalizeDateField(value = "") {
    if (!value) return "";
    const text = String(value).trim();
    const direct = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (direct) return `${direct[1]}-${String(direct[2]).padStart(2, "0")}-${String(direct[3]).padStart(2, "0")}`;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text : toDateKey(parsed);
  }

  function normalizeTimeField(value = "") {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number" && value >= 0 && value < 1) return minsToTime(Math.round(value * 24 * 60));
    const text = String(value).trim();
    const match = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
    return match ? `${String(match[1]).padStart(2, "0")}:${match[2]}` : text;
  }

  const api = { cleanPin, sheetText, pinMatches, timeToMinutes, minsToTime, toDateKey, normalizeDateField, normalizeTimeField };
  root.MorganAppCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
