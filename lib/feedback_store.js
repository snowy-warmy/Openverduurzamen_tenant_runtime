// lib/feedback_store.js
//
// Tiny append-only JSON store for EPA-preview feedback ("klopt / klopt niet"
// + free-text). Residents, EP-adviseurs and staff use the feedback card
// under the EPA preview; entries land here so acceptance/correctness of the
// parsed output can actually be measured (the parse pipeline can succeed
// while still surfacing wrong data — this is the loop that catches it).
//
// Same storage pattern as orders_store/prefill_store: a JSON file on the
// service disk (ORDERS_DATA_DIR), synchronous whole-file rewrite. Entries
// are small (rating + message + model metadata), so this stays cheap well
// past thousands of entries.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.ORDERS_DATA_DIR || "/var/data";
const FEEDBACK_FILE = path.join(DATA_DIR, "epa_feedback.json");
const MAX_ENTRIES = 5000;

let state = null;

export function initFeedbackStore() {
  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      state = JSON.parse(fs.readFileSync(FEEDBACK_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[feedback_store] kon feedbackbestand niet lezen, starten leeg:", e?.message || e);
  }
  if (!Array.isArray(state)) state = [];
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FEEDBACK_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs.renameSync(tmp, FEEDBACK_FILE);
  } catch (e) {
    console.warn("[feedback_store] schrijven mislukt:", e?.message || e);
  }
}

// payload: { tenant_id, rating: "correct"|"incorrect", message, context }
export function appendFeedback(payload) {
  const entry = {
    id: crypto.randomBytes(12).toString("hex"),
    ts: new Date().toISOString(),
    tenant_id: String(payload.tenant_id || "").slice(0, 60),
    rating: payload.rating === "incorrect" ? "incorrect" : "correct",
    message: String(payload.message || "").trim().slice(0, 2000),
    // Free-form model metadata (registratienummer, label, kernel version,
    // parse warnings…) — capped so a bogus client can't bloat the store.
    context: payload.context && typeof payload.context === "object" ? payload.context : {},
  };
  entry.context = JSON.parse(JSON.stringify(entry.context).slice(0, 4000));
  state.push(entry);
  // Ring buffer: keep the most recent entries.
  if (state.length > MAX_ENTRIES) state = state.slice(state.length - MAX_ENTRIES);
  persist();
  return entry;
}

export function listFeedback(limit = 200) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  return state.slice(-n).reverse();
}

export function feedbackStats() {
  const total = state.length;
  const correct = state.filter((e) => e.rating === "correct").length;
  return {
    total,
    correct,
    incorrect: total - correct,
    correct_pct: total ? Math.round((correct / total) * 100) : null,
    with_message: state.filter((e) => e.message).length,
  };
}
