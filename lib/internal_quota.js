// lib/internal_quota.js
//
// Persistent monthly quota counter for the WWW internal flow. Stored as
// a JSON file on the runtime's data dir (typically /var/data on Render),
// so the count survives restarts and redeploys.
//
// Format on disk (file: ${dataDir}/internal_quota.json):
//   {
//     "version": 1,
//     "months": {
//       "2026-04": 23,
//       "2026-03": 100,
//       "2026-02": 87
//     }
//   }
//
// Past months are kept (not pruned) so we can show usage history if
// needed. The current month's key is created lazily on first write.
//
// Concurrency: the write path is read-modify-rename, atomic at the
// filesystem level. A burst of simultaneous internal-render requests
// would race and possibly under-count, but for the WWW use case (a few
// reports per day, single user) that's acceptable. If stronger
// guarantees become needed, swap in a SQLite-backed counter.

import fs from "fs";
import path from "path";

const FILE_NAME = "internal_quota.json";

function getFilePath(dataDir) {
  return path.join(dataDir, FILE_NAME);
}

function currentMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function readQuotaFile(dataDir) {
  const filePath = getFilePath(dataDir);
  try {
    if (!fs.existsSync(filePath)) return { version: 1, months: {} };
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, months: {} };
    return {
      version: Number(parsed.version) || 1,
      months: parsed.months && typeof parsed.months === "object" ? parsed.months : {},
    };
  } catch {
    return { version: 1, months: {} };
  }
}

function writeQuotaFile(dataDir, data) {
  const filePath = getFilePath(dataDir);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read the count for the current calendar month (UTC).
 * Returns 0 if no entry yet.
 */
export function getCurrentMonthUsage(dataDir, date = new Date()) {
  const data = readQuotaFile(dataDir);
  const key = currentMonthKey(date);
  return Number(data.months[key] || 0);
}

/**
 * Increment the current month's counter by 1 and persist. Returns the
 * new count after the increment.
 */
export function incrementInternalQuota(dataDir, date = new Date()) {
  const data = readQuotaFile(dataDir);
  const key = currentMonthKey(date);
  const next = Number(data.months[key] || 0) + 1;
  data.months[key] = next;
  writeQuotaFile(dataDir, data);
  return next;
}

/**
 * Read the entire quota state (for the admin / quota-check endpoint).
 * Returns { current_month: "YYYY-MM", current_count, history: {...} }.
 */
export function readQuotaState(dataDir, date = new Date()) {
  const data = readQuotaFile(dataDir);
  const key = currentMonthKey(date);
  return {
    current_month: key,
    current_count: Number(data.months[key] || 0),
    history: data.months,
  };
}

/**
 * Resolve the configured monthly cap. Default 100. The runtime uses
 * this for the GET /api/internal/quota response â€” there's no hard-block
 * enforcement at the route level (per product decision: "doorlaten gaan
 * zonder waarschuwing").
 */
export function getQuotaMax() {
  const raw = process.env.WWW_INTERNAL_QUOTA_PER_MONTH;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 100;
}
