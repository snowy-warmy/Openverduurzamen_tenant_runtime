import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.ORDERS_DATA_DIR || "/var/data";
const FILE_PATH = path.join(DATA_DIR, "full_orders.json");

function ensureDirSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFileSync() {
  ensureDirSync();
  if (!fs.existsSync(FILE_PATH)) {
    fs.writeFileSync(FILE_PATH, JSON.stringify({ orders: [] }, null, 2), "utf-8");
  }
}

function readDbSync() {
  ensureFileSync();
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    return { orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
  } catch {
    return { orders: [] };
  }
}

function writeDbSync(db) {
  ensureFileSync();
  fs.writeFileSync(FILE_PATH, JSON.stringify(db, null, 2), "utf-8");
}

export function initOrdersStore() {
  ensureFileSync();
}

export function newOrderId() {
  return crypto.randomBytes(12).toString("hex");
}

export function newOrderToken() {
  return crypto.randomBytes(20).toString("hex");
}

export function createOrder(order) {
  const db = readDbSync();
  db.orders.push(order);
  writeDbSync(db);
  return order;
}

export function getOrderById(orderId) {
  const db = readDbSync();
  return db.orders.find((o) => o.id === orderId) || null;
}

export function getOrderByPaymentId(paymentId) {
  const db = readDbSync();
  return db.orders.find((o) => o.payment?.id === paymentId) || null;
}

export function updateOrder(orderId, patch) {
  const db = readDbSync();
  const idx = db.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return null;
  db.orders[idx] = {
    ...db.orders[idx],
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeDbSync(db);
  return db.orders[idx];
}

export function mergeOrder(orderId, mutator) {
  const db = readDbSync();
  const idx = db.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return null;
  const next = mutator({ ...db.orders[idx] });
  db.orders[idx] = {
    ...next,
    updated_at: new Date().toISOString(),
  };
  writeDbSync(db);
  return db.orders[idx];
}

export function listOrders(limit = 50) {
  const db = readDbSync();
  return [...db.orders]
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, limit);
}

export function buildOrderPublicView(order) {
  if (!order) return null;
  return {
    id: order.id,
    tenant_id: order.tenant_id || "default",
    status: order.status,
    email: order.email,
    amount_eur: order.amount_eur,
    created_at: order.created_at,
    updated_at: order.updated_at,
    paid_at: order.paid_at || null,
    mailed_at: order.mailed_at || null,
    address: order.address,
    checkout_url: order.payment?.checkout_url || null,
    mollie_status: order.payment?.status || null,
    download_url: order.download_path ? `/api/full/order/${order.id}/download?token=${order.download_token}` : null,
    processing_lock: Boolean(order.processing_lock),
    last_step: order.last_step || "",
    step_log: Array.isArray(order.step_log) ? order.step_log : [],
    field_errors: order.field_errors || null,
    render_debug: order.render_debug || null,
    full_app_meta: order.full_app_meta || null,
    confirmed_data_preview: order.confirmed_data || null,
    error: order.error || "",
  };
}
