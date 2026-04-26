import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.ORDERS_DATA_DIR || "/var/data";
const FILE_PATH = path.join(DATA_DIR, "full_prefills.json");
const DEFAULT_TTL_MS = Number(process.env.PREFILL_TTL_MS || 1000 * 60 * 60 * 24 * 7);

function ensureDirSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFileSync() {
  ensureDirSync();
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({ prefills: [] }, null, 2), "utf-8");
  }
}

function readDbSync() {
  ensureFileSync();
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    return { prefills: Array.isArray(parsed.prefills) ? parsed.prefills : [] };
  } catch {
    return { prefills: [] };
  }
}

function writeDbSync(db) {
  ensureFileSync();
  fs.writeFileSync(FILE_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function cleanupExpired(db) {
  const now = Date.now();
  db.prefills = (db.prefills || []).filter((item) => {
    const expiresAt = Number(new Date(item.expires_at || 0));
    return !expiresAt || expiresAt > now;
  });
  return db;
}

export function initPrefillStore() {
  ensureFileSync();
  const db = cleanupExpired(readDbSync());
  writeDbSync(db);
}

export function newPrefillToken() {
  return crypto.randomBytes(18).toString("hex");
}

export function createPrefillSession(payload) {
  const db = cleanupExpired(readDbSync());
  const token = newPrefillToken();
  const now = new Date();
  const session = {
    token,
    // Tenant the prefill was minted for. Stored explicitly so the
    // checkout step uses the right tenant context even if the user lands
    // on the start page via a different host or query string.
    tenant_id: payload.tenant_id || "default",
    source: payload.source || "mid",
    request_id: payload.request_id || "",
    cta_source: payload.cta_source || "",
    address: payload.address || {},
    validated_address: payload.validated_address || null,
    confirmed_data: payload.confirmed_data || {},
    source_facts: payload.source_facts || null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
  db.prefills.push(session);
  writeDbSync(db);
  return session;
}

export function getPrefillSession(token) {
  const db = cleanupExpired(readDbSync());
  writeDbSync(db);
  return db.prefills.find((item) => item.token === token) || null;
}
