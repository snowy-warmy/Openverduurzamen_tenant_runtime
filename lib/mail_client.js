import { Resend } from "resend";

function parseBccAddresses() {
  return String(process.env.MAIL_BCC_ADDRESSES || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function fillTemplate(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ""));
  }
  return out;
}

const FALLBACK_EMAIL_HTML = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6;max-width:680px;">
  <h2 style="margin:0 0 12px;">{{PRODUCT_NAME}}</h2>
  <p>{{BODY_INTRO}}</p>
  {{CONTACT_LINE_HTML}}
  <p>Ordernummer: <b>{{ORDER_ID}}</b></p>
  <p>{{SIGN_OFF_HTML}}</p>
</div>`;

/**
 * Send the report email. Tenant config drives everything except the
 * Resend key, which comes from RESEND_API_KEY env var.
 *
 * config: the tenant config object (passed once at app boot, frozen).
 * emailTemplate: optional pre-loaded HTML string (read by the runtime
 *   from public/templates/email.html if it exists). When absent, the
 *   FALLBACK_EMAIL_HTML inline template is used.
 */
export async function sendReportEmail({ to, orderId, pdfBuffer, filename, config, emailTemplate, downloadUrl, addressLine }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ontbreekt.");

  const resend = new Resend(apiKey);

  const productName = config?.product?.name || "Volledig Verduurzamingsinzicht";
  const subjectTemplate = config?.mail?.subjectTemplate || "{{PRODUCT_NAME}} – rapport {{ORDER_ID}}";
  const from = config?.mail?.fromAddress || process.env.MAIL_FROM_ADDRESS || "OpenVerduurzamen <no-reply@openverduurzamen.nl>";
  const bcc = parseBccAddresses();

  const baseVars = {
    TENANT_ID: config?.id || "",
    TENANT_NAME: config?.brand?.name || "",
    TENANT_PHONE: config?.contact?.phone || "",
    TENANT_EMAIL: config?.contact?.email || "",
    TENANT_WEBSITE: config?.contact?.website || "",
    PRODUCT_NAME: productName,
    ORDER_ID: orderId,
    // Validated address line (e.g. "Anne Franklaan 11, 1422HC Uithoorn").
    // Used by the WWW template's "Adres: {{ADDRESS}}" line. Empty when
    // the runtime didn't pass it (older callers).
    ADDRESS: String(addressLine || ""),
    // Public download URL with token, valid for the retention window
    // (default 365 days). Empty when APP_BASE_URL is not configured —
    // the email template can branch on {{DOWNLOAD_URL}} being empty
    // and just omit the "view online" line in that case.
    DOWNLOAD_URL: String(downloadUrl || ""),
    BODY_INTRO:
      config?.mail?.bodyIntro ||
      "Bedankt voor de bestelling. Hierbij het aangevraagde rapport als PDF-bijlage.",
    CONTACT_LINE_HTML: config?.mail?.contactLine ? `<p>${config.mail.contactLine}</p>` : "",
    SIGN_OFF_HTML: String(
      config?.mail?.signOff || `Met vriendelijke groet,\n${config?.brand?.name || ""}`
    ).replace(/\n/g, "<br/>"),
  };

  // Subject uses the same variable set as the body so tenants can
  // reference {{ADDRESS}}, {{TENANT_NAME}}, etc. in subjectTemplate.
  const subject = fillTemplate(subjectTemplate, baseVars);

  const tpl = emailTemplate || FALLBACK_EMAIL_HTML;
  const html = fillTemplate(tpl, baseVars);

  const { error } = await resend.emails.send({
    from,
    to,
    bcc: bcc.length ? bcc : undefined,
    subject,
    html,
    attachments: [{ filename, content: pdfBuffer.toString("base64") }],
  });

  if (error) {
    throw new Error(`Mail verzenden mislukt via Resend: ${error.message || "unknown error"}`);
  }
}

// ---------------------------------------------------------------------------
// Lead email
//
// Sends a contact-form submission from the website to the tenant's
// configured lead inbox. The recipient is taken from the LEAD_EMAIL env
// var (set per tenant in Render). If LEAD_EMAIL is missing we fall back to
// the tenant's config.contact.email so leads aren't silently dropped, but
// we log a warning so it can be fixed.
//
// Inputs are already validated by the caller; we still HTML-escape on the
// way out so anything the user types is harmless inside the email body.
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendLeadEmail({ firstName, lastName, email, phone, message, sourcePage, config, meta, reportContext, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ontbreekt.");

  const to = process.env.LEAD_EMAIL || config?.contact?.email;
  if (!to) throw new Error("LEAD_EMAIL ontbreekt en geen contact e-mail in config.");
  if (!process.env.LEAD_EMAIL) {
    // eslint-disable-next-line no-console
    console.warn("[lead] LEAD_EMAIL is niet gezet — val terug op config.contact.email:", to);
  }

  const resend = new Resend(apiKey);
  const from = config?.mail?.fromAddress
    || process.env.MAIL_FROM_ADDRESS
    || "OpenVerduurzamen <no-reply@openverduurzamen.nl>";

  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || "(naam onbekend)";
  const productName = config?.product?.name || "Verduurzamingsinzicht";
  const subject = `Nieuwe contactaanvraag — ${fullName}`;

  const messageHtml = message
    ? escapeHtml(message).replace(/\r?\n/g, "<br/>")
    : "<em>(geen opmerkingen achtergelaten)</em>";

  const rows = [
    ["Voornaam", firstName],
    ["Achternaam", lastName],
    ["E-mailadres", email],
    ["Telefoonnummer", phone],
    ["Pagina", sourcePage || "(onbekend)"],
    ["Product", productName],
    ["Tenant", config?.brand?.name || config?.id || ""],
  ]
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#475569;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:4px 0;color:#0f172a;">${escapeHtml(v)}</td></tr>`)
    .join("");

  // Optional report-context section. Built by the route handler from
  // either client-supplied data (mid_report) or the saved order
  // (full_done). reportContext is an object with shape:
  //   {
  //     title: "Mid-rapport details" | "Bestelling: Volledig Rapport",
  //     rows: [ [label, value], ... ],   // simple key/value pairs
  //     downloadUrl?: string,            // shown as a "Bekijk rapport →" link
  //     advice?: string,                 // optional free-form text
  //   }
  let reportSection = "";
  if (reportContext && (reportContext.rows?.length || reportContext.downloadUrl || reportContext.advice)) {
    const ctxRows = (reportContext.rows || [])
      .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#475569;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:4px 0;color:#0f172a;">${escapeHtml(v)}</td></tr>`)
      .join("");
    const link = reportContext.downloadUrl
      ? `<p style="margin:8px 0 0;"><a href="${escapeHtml(reportContext.downloadUrl)}" style="color:#1d4ed8;text-decoration:underline;">Bekijk rapport →</a></p>`
      : "";
    const advice = reportContext.advice
      ? `<div style="margin:8px 0 0;padding:10px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;color:#0f172a;font-size:13px;line-height:1.5;">${escapeHtml(reportContext.advice).replace(/\r?\n/g, "<br/>")}</div>`
      : "";
    reportSection = `
  <div style="margin:14px 0 0;font-weight:700;">${escapeHtml(reportContext.title || "Rapportgegevens")}</div>
  <div style="padding:10px 12px;background:#f7f7f7;border-radius:6px;border:1px solid #e5e7eb;">
    ${ctxRows ? `<table style="border-collapse:collapse;margin:0;">${ctxRows}</table>` : ""}
    ${link}
    ${advice}
  </div>`;
  }

  const metaRows = meta && typeof meta === "object"
    ? Object.entries(meta)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#94a3b8;white-space:nowrap;font-size:12px;">${escapeHtml(k)}</td><td style="padding:4px 0;color:#64748b;font-size:12px;">${escapeHtml(v)}</td></tr>`)
        .join("")
    : "";

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.55;max-width:620px;">
  <h2 style="margin:0 0 8px;font-size:18px;">Nieuwe contactaanvraag</h2>
  <p style="margin:0 0 14px;color:#475569;">Iemand heeft via de website om contact gevraagd.</p>
  <table style="border-collapse:collapse;margin:0 0 16px;">${rows}</table>
  <div style="margin:0 0 6px;font-weight:700;">Opmerkingen</div>
  <div style="padding:10px 12px;background:#f7f7f7;border-radius:6px;border:1px solid #e5e7eb;">${messageHtml}</div>${reportSection}
  ${metaRows ? `<table style="border-collapse:collapse;margin:14px 0 0;">${metaRows}</table>` : ""}
  <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;">U kunt direct op deze e-mail antwoorden — het Reply-To adres is ingesteld op het e-mailadres van de aanvrager.</p>
</div>`;

  // Resend supports up to 40MB of attachments per email.
  const sendArgs = {
    from,
    to,
    subject,
    html,
    replyTo: email,
  };
  if (Array.isArray(attachments) && attachments.length) {
    sendArgs.attachments = attachments
      .filter((a) => a && a.filename && a.content)
      .map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : String(a.content),
      }));
  }

  const { error } = await resend.emails.send(sendArgs);

  if (error) {
    throw new Error(`Lead mail verzenden mislukt via Resend: ${error.message || "unknown error"}`);
  }
}
