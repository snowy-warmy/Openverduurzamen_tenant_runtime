// @openverduurzamen/tenant-runtime — entrypoint
//
// Usage from a tenant app:
//
//   import { createTenantApp } from "@openverduurzamen/tenant-runtime";
//   import config from "./tenant.config.js";
//
//   const app = createTenantApp(config);
//   app.listen(process.env.PORT || 3000);
//
// One Render service = one tenant. No host-based routing, no per-tenant
// env-var suffixing. The tenant identity is implicit: it's whichever
// service this code is running inside.

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Agent, fetch as undiciFetch } from "undici";

import {
  initOrdersStore,
  createOrder,
  getOrderById,
  getOrderByPaymentId,
  updateOrder,
  mergeOrder,
  buildOrderPublicView,
  newOrderId,
  newOrderToken,
  listOrders,
} from "./lib/orders_store.js";
import { createMolliePayment, getMolliePayment } from "./lib/mollie_client.js";
import { htmlToPdfBuffer } from "./lib/pdfbolt_client.js";
import { sendReportEmail } from "./lib/mail_client.js";
import { initPrefillStore, createPrefillSession, getPrefillSession } from "./lib/prefill_store.js";
import {
  getCurrentMonthUsage,
  incrementInternalQuota,
  readQuotaState,
  getQuotaMax,
} from "./lib/internal_quota.js";

// ---------------------------------------------------------------------------
// Long-running fetch dispatcher for the report-api render call.
// ---------------------------------------------------------------------------
const LONG_FETCH_HARD_CAP_MS = Number(process.env.FULL_APP_RENDER_TIMEOUT_MS || 1500000);
const longFetchAgent = new Agent({
  connect: { timeout: 20000 },
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: LONG_FETCH_HARD_CAP_MS,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }

function fillTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ""));
  }
  return out;
}

function templateVars(config, extra = {}) {
  return {
    TENANT_ID: config?.id || "",
    TENANT_NAME: config?.brand?.name || "",
    TENANT_LEGAL_NAME: config?.brand?.legalName || config?.brand?.name || "",
    TENANT_ACCENT: config?.brand?.accentColor || "",
    TENANT_LOGO: config?.brand?.logoPath ? `/assets/${String(config.brand.logoPath).replace(/^\/+/, "")}` : "",
    TENANT_PHONE: config?.contact?.phone || "",
    TENANT_EMAIL: config?.contact?.email || "",
    TENANT_WEBSITE: config?.contact?.website || "",
    PRODUCT_NAME: config?.product?.name || "Volledig Verduurzamingsinzicht",
    TERMS_PATH: config?.product?.termsPath || "/algemene-voorwaarden.html",
    ...extra,
  };
}

function safeAssetPath(assetsDir, requestedPath) {
  if (!assetsDir) return null;
  const cleaned = String(requestedPath || "").replace(/^\/+/, "");
  if (!cleaned) return null;
  const abs = path.normalize(path.join(assetsDir, cleaned));
  if (!abs.startsWith(path.normalize(assetsDir + path.sep))) return null;
  return fs.existsSync(abs) ? abs : null;
}

function readFileIfExists(p) {
  if (!p) return null;
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null; } catch { return null; }
}

function logOrderPhase(orderId, phase, meta = {}) {
  const safeMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  console.log(`[tenant-runtime][${orderId}] ${phase}${Object.keys(safeMeta).length ? ` ${JSON.stringify(safeMeta)}` : ''}`);
}

function normalizeAddressInput(input = {}) {
  return {
    postalcode: String(input.postalcode || "").toUpperCase().replace(/\s+/g, ""),
    housenumber: String(input.housenumber || "").trim(),
    houseaddition: String(input.houseaddition || "").trim(),
  };
}

function validateEmail(email) { return /^.+@.+\..+$/.test(String(email || "").trim()); }

function validateConfirmedDataBasic(data = {}) {
  const errors = {};
  const soort = String(data.soort_woning || "").trim();
  const label = String(data.energy_label || "").trim();
  const buildYear = Number(data.build_year);
  const floorArea = Number(data.floor_area_m2);
  const currentYear = new Date().getFullYear();
  if (!soort) errors.soort_woning = "Kies het soort woning.";
  if (!Number.isInteger(buildYear) || buildYear < 1800 || buildYear > currentYear) {
    errors.build_year = `Vul een geldig bouwjaar in tussen 1800 en ${currentYear}.`;
  }
  if (!Number.isFinite(floorArea) || floorArea < 10 || floorArea > 1000) {
    errors.floor_area_m2 = "Vul een geldig woonoppervlak in tussen 10 en 1000 m².";
  }
  if (!label) errors.energy_label = "Kies het huidige energielabel.";
  return errors;
}

function normalizeConfirmedDataInput(data = {}) {
  return {
    soort_woning: String(data.soort_woning || "").trim(),
    build_year: Number(data.build_year),
    floor_area_m2: Number(data.floor_area_m2),
    energy_label: String(data.energy_label || "").trim(),
    ventilation_type: String(data.ventilation_type || "").trim(),
    heating_supply: String(data.heating_supply || "").trim(),
    heat_distribution: String(data.heat_distribution || "").trim(),
    existing_measures: Array.from(new Set(
      Array.isArray(data.existing_measures)
        ? data.existing_measures.map((x) => String(x || "").trim()).filter(Boolean)
        : []
    )),
  };
}

// ---------------------------------------------------------------------------
// The factory: build a full Express app from a tenant config object.
// ---------------------------------------------------------------------------
export function createTenantApp(config) {
  if (!config || typeof config !== "object") throw new Error("createTenantApp: config object required");
  if (!config.id) throw new Error("createTenantApp: config.id is required");

  // The "publicDir" is where the tenant repo keeps its templates and
  // assets. Tenant repos pass an absolute path; if absent we look for a
  // ./public next to the tenant repo's server.js.
  const publicDir = config.publicDir || path.join(process.cwd(), "public");
  const templatesDir = path.join(publicDir, "templates");
  const assetsDir = path.join(publicDir, "assets");

  // Pre-load templates once at boot. Tenants change templates rarely;
  // re-reading on every request would be wasteful.
  const templates = {
    fullStart:    readFileIfExists(path.join(templatesDir, "full_start.html")),
    fullDone:     readFileIfExists(path.join(templatesDir, "full_done.html")),
    terms:        readFileIfExists(path.join(templatesDir, "algemene-voorwaarden.html")),
    email:        readFileIfExists(path.join(templatesDir, "email.html")),
    // Mid landing page — the free short report. When present, becomes
    // the default landing route at "/". Tenants who don't want a Mid
    // funnel just don't ship this template; "/" then falls through to
    // /full_start.html as before.
    midStart:     readFileIfExists(path.join(templatesDir, "mid_start.html")),
    // Onepager landing page — the single-A4-summary flow. When present,
    // takes precedence over Mid/Full at "/". This is what the
    // Energiepresatie tenant ships. The page POSTs to
    // /api/onepager/render and renders the returned html_fragment
    // inline (see the runtime's onepager proxy further down).
    onepagerStart: readFileIfExists(path.join(templatesDir, "onepager_start.html")),
    // Internal-flow templates (WoonWijzerWinkel staff-only, served at
    // /intern and /intern/full_start.html). Optional per tenant — if
    // absent, the /intern routes return 404 and the internal endpoints
    // do nothing useful. WWW ships both; other tenants won't.
    internLogin:     readFileIfExists(path.join(templatesDir, "intern_login.html")),
    internFullStart: readFileIfExists(path.join(templatesDir, "intern_full_start.html")),
  };

  // Storage paths
  const dataDir = process.env.ORDERS_DATA_DIR || "/var/data";
  const pdfDir = path.join(dataDir, "pdfs");
  fs.mkdirSync(pdfDir, { recursive: true });

  initOrdersStore();
  initPrefillStore();

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));

  // -------------------------------------------------------------------------
  // Internal helpers that close over `config`
  // -------------------------------------------------------------------------
  function getBaseUrl(req) {
    const configured = String(process.env.APP_BASE_URL || "").trim();
    if (configured) return configured.replace(/\/$/, "");
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.get("host") || "localhost:3000";
    return `${proto}://${host}`;
  }

  function requireHandoffKey(req, res, next) {
    const key = String(process.env.FULL_HANDOFF_API_KEY || "").trim();
    if (!key) return next();
    if (String(req.header("x-api-key") || "").trim() !== key) return res.status(401).json({ error: "Unauthorized" });
    next();
  }

  function requireAdminKey(req, res, next) {
    const key = String(process.env.ADMIN_API_KEY || "").trim();
    if (!key) return next();
    if (String(req.header("x-api-key") || "").trim() !== key) return res.status(401).json({ error: "Unauthorized" });
    next();
  }

  // ---------------------------------------------------------------------
  // Internal-flow auth (WoonWijzerWinkel staff use)
  //
  // Plain email + password from env, HMAC-signed cookie. Cookie expires
  // after 7 days. The session secret rotates the signing key — rotate
  // it to invalidate all sessions at once.
  // ---------------------------------------------------------------------
  const INTERNAL_COOKIE_NAME = "wwwintern";
  const INTERNAL_COOKIE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

  function getInternalSecret() {
    const s = String(process.env.WWW_INTERNAL_SESSION_SECRET || "").trim();
    // Don't fall back to an empty secret — that would let anyone forge
    // cookies. If the secret isn't set we deliberately produce signatures
    // that will never verify.
    return s || crypto.randomBytes(48).toString("hex");
  }

  function signInternalCookie(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", getInternalSecret()).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  function verifyInternalCookie(cookieValue) {
    if (!cookieValue || typeof cookieValue !== "string") return null;
    const parts = cookieValue.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expected = crypto.createHmac("sha256", getInternalSecret()).update(body).digest("base64url");
    // Constant-time compare to avoid leaking bytes via timing.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")); }
    catch { return null; }
    if (!payload || typeof payload !== "object") return null;
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  }

  function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    for (const part of String(cookieHeader).split(";")) {
      const [k, ...rest] = part.split("=");
      if (!k) continue;
      out[k.trim()] = decodeURIComponent((rest.join("=") || "").trim());
    }
    return out;
  }

  function readInternalSession(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return verifyInternalCookie(cookies[INTERNAL_COOKIE_NAME]);
  }

  function requireInternalSession(req, res, next) {
    const session = readInternalSession(req);
    if (!session) {
      // For HTML page requests, redirect to login. For JSON / API
      // requests, return 401 so the front-end can react cleanly.
      const wantsHtml = String(req.headers.accept || "").includes("text/html");
      if (wantsHtml) return res.redirect("/intern");
      return res.status(401).json({ error: "Niet ingelogd.", code: "internal_session_missing" });
    }
    req.internalSession = session;
    next();
  }

  function checkInternalCredentials(email, password) {
    const expectedEmail = String(process.env.WWW_INTERNAL_EMAIL || "").trim().toLowerCase();
    const expectedPassword = String(process.env.WWW_INTERNAL_PASSWORD || "");
    if (!expectedEmail || !expectedPassword) return false;
    const inputEmail = String(email || "").trim().toLowerCase();
    const inputPassword = String(password || "");
    // Constant-time comparison on bytes — convert to Buffers of equal
    // length first (we pad/truncate the shorter to match). A direct
    // !== check would leak length, so we accept some extra ceremony.
    const ea = Buffer.from(inputEmail);
    const eb = Buffer.from(expectedEmail);
    const pa = Buffer.from(inputPassword);
    const pb = Buffer.from(expectedPassword);
    const emailOk = ea.length === eb.length && crypto.timingSafeEqual(ea, eb);
    const passwordOk = pa.length === pb.length && crypto.timingSafeEqual(pa, pb);
    return emailOk && passwordOk;
  }

  function getReportRenderUrl() {
    return String(process.env.FULL_APP_RENDER_URL || config.reportApi?.renderUrl || "").trim();
  }

  function getReportLookupUrl() {
    const explicit = String(process.env.FULL_APP_LOOKUP_URL || config.reportApi?.lookupUrl || "").trim();
    if (explicit) return explicit;
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return "";
    return renderUrl.replace(/\/api\/full\/render$/i, "/api/mid/lookup");
  }

  function buildReportApiHeaders() {
    const headers = { "Content-Type": "application/json" };
    const key = String(process.env.FULL_APP_RENDER_API_KEY || "").trim();
    if (key) headers["x-api-key"] = key;
    return headers;
  }

  /**
   * Build the brand-payload sent to report-api on every render call.
   * report-api is stateless: this is everything it needs to theme the
   * output. Keep keys flat and stable so changes to the runtime don't
   * silently break the renderer.
   */
  function buildBrandPayload() {
    return {
      id: config.id,
      brand: config.brand || {},
      contact: config.contact || {},
      followUp: config.followUp || { enabled: false },
      product: { name: config.product?.name || "Volledig Verduurzamingsinzicht", fullReportUrl: config.product?.fullReportUrl || "" },
      prompts: config.prompts || {},
    };
  }

  async function fetchLookupFromReportApi(address) {
    const url = getReportLookupUrl();
    if (!url) throw new Error("FULL_APP_LOOKUP_URL ontbreekt.");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Number(process.env.FULL_APP_LOOKUP_TIMEOUT_MS || 45000));
    try {
      const res = await undiciFetch(url, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify({ ...address, tenant: buildBrandPayload() }),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `Lookup mislukt (${res.status})`);
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchFullReportHtml({ order }) {
    const url = getReportRenderUrl();
    if (!url) throw new Error("FULL_APP_RENDER_URL ontbreekt.");

    const reqBody = {
      address: order.address,
      confirmed_data: order.confirmed_data,
      response_mode: "json",
      tenant: buildBrandPayload(),
      generation_options: { enable_photo_analysis: false, enable_web_search: true },
    };

    const t0 = Date.now();
    const ac = new AbortController();
    const hardCap = setTimeout(() => ac.abort(), LONG_FETCH_HARD_CAP_MS);

    let lastProgressLogAt = 0;
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - t0;
      if (elapsed - lastProgressLogAt >= 30000) {
        logOrderPhase(order.id, "render_html_waiting", { elapsed_ms: elapsed });
        lastProgressLogAt = elapsed;
      }
    }, 30000);
    try { progressInterval.unref?.(); } catch {}

    let res, rawText = "";
    try {
      logOrderPhase(order.id, "render_html_fetch_start", { url });
      res = await undiciFetch(url, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });
      rawText = await res.text();
      logOrderPhase(order.id, "render_html_body_received", { status: res.status, bytes: rawText.length, elapsed_ms: Date.now() - t0 });
    } catch (fetchErr) {
      const elapsed = Date.now() - t0;
      const cause = fetchErr?.cause?.code || fetchErr?.code || fetchErr?.cause?.name || fetchErr?.name;
      const err = new Error(`Fetch naar report-api mislukt na ${Math.round(elapsed / 1000)}s: ${fetchErr?.message || String(fetchErr)}${cause ? ` (${cause})` : ""}`);
      err.context = { step: "render_html_fetch", url, elapsed_ms: elapsed, cause, original_message: fetchErr?.message || String(fetchErr), aborted: ac.signal.aborted };
      throw err;
    } finally {
      clearTimeout(hardCap);
      clearInterval(progressInterval);
    }

    let json = null;
    try { json = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const err = new Error(json?.error || rawText || `Full report render mislukt (${res.status})`);
      err.context = { step: "render_html", http_status: res.status, response_json: json, response_text_preview: String(rawText || "").slice(0, 1200), request_preview: reqBody };
      throw err;
    }

    const html = json?.html || json?.html_document || "";
    if (!html) {
      const err = new Error("Report-api gaf geen HTML terug.");
      err.context = { step: "render_html", http_status: res.status, response_json: json, response_text_preview: String(rawText || "").slice(0, 1200), request_preview: reqBody };
      throw err;
    }
    return { html, meta: json?.meta || null };
  }

  function appendStep(orderId, step, extra = {}) {
    return mergeOrder(orderId, (current) => ({
      ...current,
      last_step: step,
      step_log: [...(Array.isArray(current.step_log) ? current.step_log : []), { at: nowIso(), step, ...extra }],
    }));
  }

  async function createPaymentOrder({ req, email, address, confirmedData, sourceMeta = null }) {
    const baseUrl = getBaseUrl(req);
    const orderId = newOrderId();
    const downloadToken = newOrderToken();
    const amount = Number(config?.payment?.priceEur || 30);
    const productName = config?.product?.name || "Volledig Verduurzamingsinzicht";
    const description = fillTemplate(
      config?.payment?.description || "{{PRODUCT_NAME}} {{ORDER_ID}}",
      { PRODUCT_NAME: productName, ORDER_ID: orderId }
    );
    const redirectPath = config?.product?.redirectAfterPaymentPath || "/full_done.html";

    const payment = await createMolliePayment({
      amountEur: amount,
      description,
      redirectUrl: `${baseUrl}${redirectPath}?order_id=${encodeURIComponent(orderId)}`,
      webhookUrl: `${baseUrl}/api/full/webhook/mollie`,
      metadata: { order_id: orderId, tenant_id: config.id },
    });

    createOrder({
      id: orderId,
      tenant_id: config.id,
      download_token: downloadToken,
      status: "payment_created",
      created_at: nowIso(),
      updated_at: nowIso(),
      amount_eur: amount,
      email,
      address,
      confirmed_data: confirmedData,
      payment: { id: payment.id, status: payment.status, checkout_url: payment.checkout_url },
      report_html: "",
      pdf_filename: "",
      download_path: "",
      paid_at: null,
      mailed_at: null,
      processing_lock: false,
      error: "",
      source_meta: sourceMeta || null,
    });

    return {
      order_id: orderId,
      checkout_url: payment.checkout_url,
      done_url: `${baseUrl}${redirectPath}?order_id=${encodeURIComponent(orderId)}`,
      status_url: `${baseUrl}/api/full/order/${encodeURIComponent(orderId)}`,
    };
  }

  /**
   * Internal-flow order creation — same as createPaymentOrder but skips
   * Mollie entirely. The order is born with status "paid" so the
   * existing processOrderById flow immediately runs render → PDF →
   * mail. Used by /api/internal/full/render for WoonWijzerWinkel staff.
   */
  async function createInternalOrder({ req, email, address, confirmedData, sourceMeta = null }) {
    const baseUrl = getBaseUrl(req);
    const orderId = newOrderId();
    const downloadToken = newOrderToken();
    const redirectPath = config?.product?.redirectAfterPaymentPath || "/full_done.html";
    const monthUsage = incrementInternalQuota(dataDir);

    createOrder({
      id: orderId,
      tenant_id: config.id,
      download_token: downloadToken,
      // We mark it "paid" so the existing recovery sweep + processing
      // pipeline treats it identically to a Mollie-paid order. The
      // payment block stays empty so it's clear in audit logs that
      // this was an internal render.
      status: "paid",
      created_at: nowIso(),
      updated_at: nowIso(),
      amount_eur: 0,
      email,
      address,
      confirmed_data: confirmedData,
      payment: { id: null, status: "internal", checkout_url: null },
      report_html: "",
      pdf_filename: "",
      download_path: "",
      paid_at: nowIso(),
      mailed_at: null,
      processing_lock: false,
      error: "",
      source_meta: {
        ...(sourceMeta || {}),
        source: "internal_full_start",
        internal_user: req?.internalSession?.email || null,
        month_usage_after: monthUsage,
      },
    });

    triggerBackgroundProcessing(orderId);

    return {
      order_id: orderId,
      done_url: `${baseUrl}${redirectPath}?order_id=${encodeURIComponent(orderId)}`,
      status_url: `${baseUrl}/api/full/order/${encodeURIComponent(orderId)}`,
      month_usage: monthUsage,
      month_max: getQuotaMax(),
    };
  }

  function isRecoverableStatus(status) {
    return ["paid", "processing", "report_generated", "pdf_created", "mail_failed"].includes(String(status || ""));
  }

  function triggerBackgroundProcessing(orderId) {
    setTimeout(async () => { try { await processOrderById(orderId); } catch {} }, 50);
  }

  async function recoverPendingOrders() {
    const candidates = listOrders(200).filter((o) => isRecoverableStatus(o.status) && !o.processing_lock);
    for (const order of candidates) triggerBackgroundProcessing(order.id);
  }

  async function processOrderById(orderId) {
    let order = getOrderById(orderId);
    if (!order) throw new Error("Order niet gevonden.");
    if (["mailed", "done"].includes(order.status)) return order;
    if (order.processing_lock) return order;

    order = mergeOrder(orderId, (current) => ({
      ...current,
      processing_lock: true,
      status: isRecoverableStatus(current.status) ? "processing" : current.status,
      last_step: "processing_started",
      error: "",
      field_errors: null,
      render_debug: null,
    }));
    appendStep(orderId, "processing_started");

    try {
      appendStep(orderId, "render_html_started");
      const renderResult = order.report_html
        ? { html: order.report_html, meta: order.full_app_meta || null }
        : await fetchFullReportHtml({ order });
      const html = renderResult.html;
      order = updateOrder(orderId, {
        status: "report_generated",
        report_html: html,
        full_app_meta: renderResult.meta || null,
        last_step: "render_html_done",
      });
      appendStep(orderId, "render_html_done", { html_chars: String(html || "").length });

      let pdfPath = order.download_path;
      let filename = order.pdf_filename;
      let pdfBuffer;

      if (pdfPath && fs.existsSync(pdfPath)) {
        pdfBuffer = fs.readFileSync(pdfPath);
      } else {
        appendStep(orderId, "pdf_started");
        pdfBuffer = await htmlToPdfBuffer(html);
        const slug = String(config?.product?.name || "rapport")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        filename = `${order.id}-${slug}.pdf`;
        pdfPath = path.join(pdfDir, filename);
        fs.writeFileSync(pdfPath, pdfBuffer);
        order = updateOrder(orderId, { status: "pdf_created", pdf_filename: filename, download_path: pdfPath, last_step: "pdf_done" });
        appendStep(orderId, "pdf_done", { filename });
      }

      try {
        appendStep(orderId, "mail_started", { to: order.email });
        await sendReportEmail({ to: order.email, orderId: order.id, pdfBuffer, filename, config, emailTemplate: templates.email });
      } catch (mailErr) {
        order = updateOrder(orderId, { status: "mail_failed", processing_lock: false, last_step: "mail_failed", render_debug: mailErr?.context || null, error: mailErr?.message || String(mailErr) });
        appendStep(orderId, "mail_failed", { message: mailErr?.message || String(mailErr) });
        throw mailErr;
      }

      order = updateOrder(orderId, { status: "mailed", mailed_at: nowIso(), processing_lock: false, last_step: "mail_done", error: "" });
      appendStep(orderId, "mail_done", { to: order.email });
      return order;
    } catch (e) {
      const current = getOrderById(orderId);
      const keepStatus = current?.status === "mail_failed" ? "mail_failed"
        : current?.status === "pdf_created" ? "pdf_created"
        : current?.status === "report_generated" ? "report_generated"
        : "error";
      logOrderPhase(orderId, "failed", { status: keepStatus, message: e?.message || String(e), step: e?.context?.step || current?.last_step || "error" });
      updateOrder(orderId, {
        status: keepStatus, processing_lock: false,
        last_step: e?.context?.step || current?.last_step || "error",
        field_errors: e?.context?.response_json?.field_errors || null,
        render_debug: e?.context || null,
        error: e?.message || String(e),
      });
      appendStep(orderId, e?.context?.step ? `${e.context.step}_failed` : "error", { message: e?.message || String(e) });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Pages — read from this tenant's public/templates/ folder.
  // -------------------------------------------------------------------------
  function serveTemplatedPage(req, res, key, fallback) {
    const tpl = templates[key];
    if (!tpl) return res.status(404).type("text/plain").send(fallback);
    const html = fillTemplate(tpl, templateVars(config, {
      BASE_URL: getBaseUrl(req),
      HANDOFF_TOKEN: String(req.query.handoff || ""),
      ORDER_ID: String(req.query.order_id || ""),
    }));
    res.type("text/html; charset=utf-8").send(html);
  }

  // Root route: precedence is onepagerStart → midStart → fullStart. The
  // first template the tenant ships becomes the landing page.
  app.get("/", (req, res) => {
    if (templates.onepagerStart) return serveTemplatedPage(req, res, "onepagerStart", "Pagina niet beschikbaar.");
    if (templates.midStart) return serveTemplatedPage(req, res, "midStart", "Pagina niet beschikbaar.");
    return res.redirect("/full_start.html");
  });
  app.get("/onepager_start.html", (req, res) => serveTemplatedPage(req, res, "onepagerStart", "Onepager niet beschikbaar voor deze tenant."));
  app.get("/mid_start.html", (req, res) => serveTemplatedPage(req, res, "midStart", "Mid-rapport niet beschikbaar voor deze tenant."));
  app.get("/full_start.html", (req, res) => serveTemplatedPage(req, res, "fullStart", "Pagina niet beschikbaar."));
  app.get("/full_done.html",  (req, res) => serveTemplatedPage(req, res, "fullDone",  "Pagina niet beschikbaar."));
  app.get("/algemene-voorwaarden.html", (req, res) => serveTemplatedPage(req, res, "terms", "Algemene voorwaarden niet beschikbaar."));

  // -------------------------------------------------------------------------
  // Internal flow (WoonWijzerWinkel staff)
  // -------------------------------------------------------------------------
  // /intern                       → login page (or redirect to /intern/full_start.html if signed in)
  // /intern/full_start.html       → cookie-protected full-report intake page
  // POST /api/internal/login      → email + password → set cookie
  // POST /api/internal/logout     → clear cookie
  // POST /api/internal/full/render → cookie-protected, skip Mollie, render+mail
  // GET  /api/internal/quota      → returns { used, max, month, remaining }

  app.get("/intern", (req, res) => {
    // If already signed in, skip the login page and go straight to the
    // intake form. The intake page is itself cookie-protected so an
    // expired session bounces back here.
    if (readInternalSession(req)) return res.redirect("/intern/full_start.html");
    return serveTemplatedPage(req, res, "internLogin", "Interne login niet beschikbaar voor deze tenant.");
  });

  app.get("/intern/full_start.html", requireInternalSession, (req, res) =>
    serveTemplatedPage(req, res, "internFullStart", "Interne pagina niet beschikbaar voor deze tenant.")
  );

  app.post("/api/internal/login", (req, res) => {
    const email = String(req.body?.email || "");
    const password = String(req.body?.password || "");
    if (!checkInternalCredentials(email, password)) {
      return res.status(401).json({ error: "Onjuiste e-mail of wachtwoord." });
    }
    const exp = Date.now() + INTERNAL_COOKIE_TTL_MS;
    const cookieValue = signInternalCookie({ email: email.trim().toLowerCase(), exp });
    // Cookie attributes:
    //   HttpOnly  — JS can't read it, so an XSS hole can't steal the
    //               session even if one exists.
    //   Secure    — only sent over HTTPS, which Render always provides.
    //   SameSite=Lax — sent on top-level navigations + GETs, blocks the
    //               cookie on cross-site POSTs (mild CSRF protection).
    //   Path=/    — the cookie is needed for both /intern* pages and
    //               /api/internal/* requests.
    res.setHeader("Set-Cookie",
      `${INTERNAL_COOKIE_NAME}=${encodeURIComponent(cookieValue)}; ` +
      `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(INTERNAL_COOKIE_TTL_MS / 1000)}`
    );
    return res.json({ ok: true, redirect: "/intern/full_start.html" });
  });

  app.post("/api/internal/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${INTERNAL_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res.json({ ok: true });
  });

  app.post("/api/internal/full/render", requireInternalSession, async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body?.address || req.body || {});
      const email = String(req.body?.email || "").trim();
      const confirmedData = normalizeConfirmedDataInput(req.body?.confirmed_data || {});
      const errors = {};
      if (!validateEmail(email)) errors.email = "Geldig e-mailadres is verplicht.";
      if (!address.postalcode) errors.postalcode = "Postcode is verplicht.";
      if (!address.housenumber) errors.housenumber = "Huisnummer is verplicht.";
      Object.assign(errors, validateConfirmedDataBasic(confirmedData));
      if (Object.keys(errors).length) return res.status(400).json({ error: "Ongeldige invoer.", field_errors: errors });

      const payload = await createInternalOrder({
        req, email, address, confirmedData,
        sourceMeta: { tenant_id: config.id, request_id: String(req.body?.request_id || "").trim() },
      });
      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // GET /api/internal/quota — returns the current month's usage. Two
  // ways to authenticate: either the same cookie used by the staff
  // intake page (so the staff can refresh-and-see), or a token query
  // param matching ADMIN_API_KEY (so a CLI / monitor can poll it).
  app.get("/api/internal/quota", (req, res) => {
    const adminKey = String(process.env.ADMIN_API_KEY || "").trim();
    const tokenOk = adminKey && String(req.query?.token || "").trim() === adminKey;
    const sessionOk = !!readInternalSession(req);
    if (!tokenOk && !sessionOk) return res.status(401).json({ error: "Unauthorized" });
    const state = readQuotaState(dataDir);
    const max = getQuotaMax();
    return res.json({
      used: state.current_count,
      max,
      remaining: Math.max(0, max - state.current_count),
      month: state.current_month,
      history: state.history,
    });
  });

  app.get("/assets/:filename(*)", (req, res) => {
    const abs = safeAssetPath(assetsDir, req.params.filename);
    if (!abs) return res.status(404).send("Asset not found");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(abs);
  });

  // -------------------------------------------------------------------------
  // API surface
  // -------------------------------------------------------------------------
  app.get("/health", (_req, res) => res.json({ ok: true, tenant: config.id, ts: nowIso() }));

  // Public brand info — useful for frontends that want to render the
  // current tenant's name/colors without hardcoding them.
  app.get("/api/tenant", (_req, res) => res.json({
    id: config.id,
    brand: config.brand,
    contact: config.contact,
    product: { name: config.product?.name || "", priceEur: Number(config.payment?.priceEur || 30) },
  }));

  app.post("/api/full/lookup-address", async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body || {});
      if (!address.postalcode || !address.housenumber) return res.status(400).json({ error: "postalcode en housenumber zijn verplicht." });
      const lookup = await fetchLookupFromReportApi(address);
      return res.json(lookup);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  // -------------------------------------------------------------------------
  // Mid: free short report flow
  //
  // The user-facing pages live at /mid_start.html (and / when present).
  // The frontend (mid_app.js) POSTs to these three endpoints. Each one
  // proxies through to the report-api so the tenant brand and shared
  // x-api-key stay consistent and the user's browser never talks to
  // report-api directly.
  // -------------------------------------------------------------------------

  // Address lookup. Identical contract to /api/full/lookup-address — the
  // old Mid frontend just calls a different path. Kept as a separate
  // route so no frontend changes are needed.
  app.post("/api/mid/lookup", async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body || {});
      if (!address.postalcode || !address.housenumber) {
        return res.status(400).json({ error: "postalcode en housenumber zijn verplicht." });
      }
      const lookup = await fetchLookupFromReportApi(address);
      return res.json(lookup);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Mid streaming (SSE). The report-api takes ~30-90s to write the short
  // report and emits incremental events along the way. We forward the
  // raw byte stream so the browser's EventSource sees the same events.
  // Auth and tenant branding are added on the way out; everything coming
  // back is just piped.
  app.post("/api/mid/stream", async (req, res) => {
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return res.status(500).json({ error: "FULL_APP_RENDER_URL ontbreekt." });
    const upstream = renderUrl.replace(/\/api\/full\/render$/i, "/api/mid/stream");
    const upstreamBody = JSON.stringify({ ...(req.body || {}), tenant: buildBrandPayload() });

    // SSE response headers. Note: we do NOT set Connection: keep-alive
    // here — it's an HTTP/1.1 directive that's invalid in HTTP/2 (which
    // is what Render+Cloudflare actually use), and adding it can cause
    // the proxy layer to behave unpredictably. Cache-Control: no-cache
    // already prevents intermediary buffering.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    // We DON'T flushHeaders() here. It seemed like a good idea but on
    // Render's HTTP/2 proxy stack, flushing headers before any body byte
    // has been generated triggers a premature client-close event under
    // some conditions. Express will flush automatically when we write
    // the first chunk, which is fine for SSE.

    const ac = new AbortController();
    let upstreamStarted = false;

    // Wire client-disconnect abort, but ONLY after we've successfully
    // received headers from upstream and started piping. The earlier
    // version registered this handler before the upstream fetch even
    // started, which on some Node versions caused the abort to fire as
    // soon as any header-flush happened on the response — within 4ms,
    // before any real data could arrive.
    const onClientClose = () => { if (upstreamStarted) { try { ac.abort(); } catch {} } };
    res.on("close", onClientClose);

    try {
      const upstreamRes = await undiciFetch(upstream, {
        method: "POST",
        headers: { ...buildReportApiHeaders(), Accept: "text/event-stream" },
        body: upstreamBody,
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });

      if (!upstreamRes.ok || !upstreamRes.body) {
        const text = await upstreamRes.text().catch(() => "");
        res.write(`event: error\ndata: ${JSON.stringify({ status: upstreamRes.status, message: text || "stream upstream error" })}\n\n`);
        return res.end();
      }

      // Now that upstream is connected, allow client-disconnect to
      // propagate as an abort (so we don't keep the OpenAI generation
      // running uselessly when the user navigates away).
      upstreamStarted = true;

      for await (const chunk of upstreamRes.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
      res.end();
    } catch (e) {
      // Don't surface "operation aborted" as a user-facing error if it
      // was caused by the client itself disconnecting cleanly.
      const msg = e?.message || String(e);
      const isClientAbort = ac.signal.aborted && upstreamStarted;
      if (!isClientAbort) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`); } catch {}
      }
      try { res.end(); } catch {}
    } finally {
      res.off("close", onClientClose);
    }
  });

  // Onepager render proxy. The report-api does an enriched lookup + a
  // small (~5-10s) Anthropic call to produce a single-page summary.
  // We forward the body, attach the tenant brand payload, and pass the
  // upstream JSON response back unchanged. No streaming — a normal
  // POST/JSON round-trip with a generous timeout to cover the LLM call.
  app.post("/api/onepager/render", async (req, res) => {
    const renderUrl = getReportRenderUrl();
    if (!renderUrl) return res.status(500).json({ error: "FULL_APP_RENDER_URL ontbreekt." });
    const upstream = renderUrl.replace(/\/api\/full\/render$/i, "/api/onepager/render");

    const reqBody = {
      ...(req.body || {}),
      tenant: buildBrandPayload(),
    };

    const ac = new AbortController();
    const timeoutMs = Number(process.env.ONEPAGER_PROXY_TIMEOUT_MS || 60000);
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const upstreamRes = await undiciFetch(upstream, {
        method: "POST",
        headers: buildReportApiHeaders(),
        body: JSON.stringify(reqBody),
        signal: ac.signal,
        dispatcher: longFetchAgent,
      });

      const text = await upstreamRes.text();
      // Pass status code through so the tenant page can react to 404
      // (address not found), 400 (validation), etc. directly.
      res.status(upstreamRes.status);
      res.setHeader("Content-Type", upstreamRes.headers.get("content-type") || "application/json; charset=utf-8");
      return res.send(text);
    } catch (e) {
      const aborted = ac.signal.aborted;
      const message = aborted
        ? `Onepager render timeout na ${Math.round(timeoutMs / 1000)}s`
        : e?.message || String(e);
      return res.status(aborted ? 504 : 502).json({ error: message, code: aborted ? "onepager_timeout" : "onepager_proxy_error" });
    } finally {
      clearTimeout(timer);
    }
  });

  // Mid → Full handoff. Internal alias: same logic as /api/full/handoff,
  // but exposed under the path the legacy Mid frontend hardcoded. Skips
  // requireHandoffKey because this route is called by the user's browser
  // (same-origin), not by a server.
  app.post("/api/mid/full-report-handoff", handleMidHandoff);

  // Mid handoff config — old Mid frontend hits this on init to learn
  // where to send the user. In the merged tenant world, the answer is
  // always "this very server", so we return self-referential URLs.
  app.get("/api/mid/full-handoff-config", (req, res) => {
    const baseUrl = getBaseUrl(req);
    return res.json({
      public_url: baseUrl,
      handoff_candidates: [`${baseUrl}/api/mid/full-report-handoff`],
      has_api_key: false, // browser-side calls don't need a key
    });
  });

  // Mid → tenant handoff. The Mid frontend POSTs confirmed_data here;
  // we mint a prefill token and return a start_url.
  async function handleMidHandoff(req, res) {
    try {
      const address = normalizeAddressInput(req.body?.address || req.body || {});
      const confirmedData = normalizeConfirmedDataInput(req.body?.confirmed_data || {});
      const errors = {};
      if (!address.postalcode) errors.postalcode = "Postcode is verplicht.";
      if (!address.housenumber) errors.housenumber = "Huisnummer is verplicht.";
      Object.assign(errors, validateConfirmedDataBasic(confirmedData));
      if (Object.keys(errors).length) return res.status(400).json({ error: "Ongeldige handoff payload.", field_errors: errors });

      const baseUrl = getBaseUrl(req);
      const session = createPrefillSession({
        source: String(req.body?.source || "mid").trim() || "mid",
        tenant_id: config.id,
        request_id: String(req.body?.request_id || "").trim(),
        cta_source: String(req.body?.cta_source || "").trim(),
        address,
        validated_address: req.body?.validated_address && typeof req.body.validated_address === "object" ? req.body.validated_address : null,
        confirmed_data: confirmedData,
        source_facts: req.body?.source_facts && typeof req.body.source_facts === "object" ? req.body.source_facts : null,
      });
      return res.json({ handoff_token: session.token, start_url: `${baseUrl}/full_start.html?handoff=${encodeURIComponent(session.token)}` });
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  }

  app.post("/api/full/handoff", requireHandoffKey, handleMidHandoff);
  app.post("/api/full/handoff-from-mid", requireHandoffKey, handleMidHandoff);

  app.get("/api/full/handoff/:token", (req, res) => {
    const session = getPrefillSession(String(req.params.token || ""));
    if (!session) return res.status(404).json({ error: "Handoff niet gevonden of verlopen." });
    return res.json({
      token: session.token,
      tenant_id: session.tenant_id || null,
      source: session.source,
      request_id: session.request_id || "",
      cta_source: session.cta_source || "",
      address: session.address,
      validated_address: session.validated_address || null,
      confirmed_data: session.confirmed_data,
      source_facts: session.source_facts || null,
      created_at: session.created_at,
    });
  });
  app.get("/api/full/prefill/:token", (req, res) => {
    // Legacy alias.
    const session = getPrefillSession(String(req.params.token || ""));
    if (!session) return res.status(404).json({ error: "Handoff niet gevonden of verlopen." });
    return res.json({
      token: session.token,
      tenant_id: session.tenant_id || null,
      source: session.source,
      request_id: session.request_id || "",
      cta_source: session.cta_source || "",
      address: session.address,
      validated_address: session.validated_address || null,
      confirmed_data: session.confirmed_data,
      source_facts: session.source_facts || null,
      created_at: session.created_at,
    });
  });

  app.post("/api/full/create-payment-from-handoff", async (req, res) => {
    try {
      const token = String(req.body?.handoff_token || req.body?.prefill_token || "").trim();
      const email = String(req.body?.email || "").trim();
      if (!token) return res.status(400).json({ error: "handoff_token is verplicht." });
      if (!validateEmail(email)) return res.status(400).json({ error: "Geldig e-mailadres is verplicht.", field_errors: { email: "Geldig e-mailadres is verplicht." } });
      const session = getPrefillSession(token);
      if (!session) return res.status(404).json({ error: "Handoff niet gevonden of verlopen." });
      const acceptTerms = req.body?.accept_terms === true || String(req.body?.accept_terms || "").toLowerCase() === "true";
      if (!acceptTerms) return res.status(400).json({ error: "Akkoord met de algemene voorwaarden is verplicht.", field_errors: { accept_terms: "Akkoord met de algemene voorwaarden is verplicht." } });
      const errors = validateConfirmedDataBasic(session.confirmed_data || {});
      if (Object.keys(errors).length) return res.status(400).json({ error: "Handoff bevat ongeldige woninggegevens.", field_errors: errors });

      const payload = await createPaymentOrder({
        req, email,
        address: session.address,
        confirmedData: normalizeConfirmedDataInput(session.confirmed_data || {}),
        sourceMeta: { source: session.source || "mid", tenant_id: config.id, request_id: session.request_id || "", cta_source: session.cta_source || "", handoff_token: session.token, validated_address: session.validated_address || null, source_facts: session.source_facts || null },
      });
      return res.json(payload);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/full/create-payment", async (req, res) => {
    try {
      const address = normalizeAddressInput(req.body?.address || req.body || {});
      const email = String(req.body?.email || "").trim();
      const confirmedData = normalizeConfirmedDataInput(req.body?.confirmed_data || {});
      const acceptTerms = req.body?.accept_terms === true || String(req.body?.accept_terms || "").toLowerCase() === "true";
      const errors = {};
      if (!validateEmail(email)) errors.email = "Geldig e-mailadres is verplicht.";
      if (!address.postalcode) errors.postalcode = "Postcode is verplicht.";
      if (!address.housenumber) errors.housenumber = "Huisnummer is verplicht.";
      if (!acceptTerms) errors.accept_terms = "Akkoord met de algemene voorwaarden is verplicht.";
      Object.assign(errors, validateConfirmedDataBasic(confirmedData));
      if (Object.keys(errors).length) return res.status(400).json({ error: "Ongeldige invoer.", field_errors: errors });

      const payload = await createPaymentOrder({
        req, email, address, confirmedData,
        sourceMeta: { source: "manual_full_start", tenant_id: config.id, request_id: String(req.body?.request_id || "").trim() },
      });
      return res.json(payload);
    } catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/full/webhook/mollie", async (req, res) => {
    try {
      const paymentId = String(req.body?.id || req.query?.id || "").trim();
      if (!paymentId) return res.status(200).send("ok");
      const payment = await getMolliePayment(paymentId);
      const orderId = String(payment?.metadata?.order_id || "").trim();
      if (!orderId) return res.status(200).send("ok");
      const order = getOrderById(orderId);
      if (!order) return res.status(200).send("ok");
      mergeOrder(order.id, (current) => ({
        ...current,
        payment: { ...(current.payment || {}), id: payment.id, status: payment.status, paid_at: payment.paidAt || current.payment?.paid_at || null },
        status:
          payment.status === "paid" ? "paid"
          : payment.status === "authorized" ? "paid"
          : payment.status === "failed" ? "failed"
          : payment.status === "canceled" ? "canceled"
          : current.status,
        paid_at: payment.paidAt || current.paid_at || null,
      }));
      if (["paid", "authorized"].includes(payment.status)) triggerBackgroundProcessing(order.id);
      return res.status(200).send("ok");
    } catch { return res.status(200).send("ok"); }
  });

  app.post("/api/full/process-order/:id", requireAdminKey, async (req, res) => {
    try { return res.json(buildOrderPublicView(await processOrderById(String(req.params.id || "")))); }
    catch (e) { return res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get("/api/full/order/:id", (req, res) => {
    const order = getOrderById(String(req.params.id || ""));
    if (!order) return res.status(404).json({ error: "Order niet gevonden." });
    return res.json(buildOrderPublicView(order));
  });

  app.get("/api/full/order/:id/download", (req, res) => {
    const order = getOrderById(String(req.params.id || ""));
    if (!order) return res.status(404).send("Order niet gevonden.");
    const token = String(req.query?.token || "").trim();
    if (!token || token !== order.download_token) return res.status(401).send("Unauthorized");
    if (!order.download_path || !fs.existsSync(order.download_path)) return res.status(404).send("PDF niet gevonden.");
    return res.download(order.download_path, order.pdf_filename || `${order.id}.pdf`);
  });

  app.get("/api/admin/orders", requireAdminKey, (_req, res) => {
    return res.json({ orders: listOrders(200).map(buildOrderPublicView).slice(0, 100) });
  });

  app.post("/api/admin/recover-orders", requireAdminKey, async (_req, res) => {
    await recoverPendingOrders();
    return res.json({ ok: true });
  });

  // Boot-time: run a recovery sweep + schedule periodic sweeps for any
  // orders that got stuck mid-flight (Render restart, network blip, etc.).
  setTimeout(() => recoverPendingOrders().catch(() => {}), 1000);
  const intervalMs = Number(process.env.RETRY_INTERVAL_MS || 60000);
  setInterval(() => { recoverPendingOrders().catch(() => {}); }, intervalMs);

  console.log(`[tenant-runtime] Tenant '${config.id}' (${config.brand?.name || ""}) ready.`);
  return app;
}

// Re-export so tenant repos can compose if they ever need to (rare).
export { fillTemplate, templateVars };
