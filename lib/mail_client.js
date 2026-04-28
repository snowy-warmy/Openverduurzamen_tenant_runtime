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

// Format "3131KZ" -> "3131 KZ" (the raw form input strips the space; templates
// usually want it back). Returns the input unchanged if it doesn't match the
// 4-digit + 2-letter Dutch pattern.
function prettyPostalCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/\s+/g, "");
  return /^[0-9]{4}[A-Z]{2}$/.test(s) ? `${s.slice(0, 4)} ${s.slice(4)}` : s;
}

// Build a pretty single-line address: "3131 KZ 8A" or "3131 KZ 8".
function formatAddress(address) {
  if (!address) return "";
  const pc = prettyPostalCode(address.postalcode);
  const num = String(address.housenumber || "").trim();
  const add = String(address.houseaddition || "").trim();
  const numPart = add ? `${num}${add}` : num;
  return [pc, numPart].filter(Boolean).join(" ");
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
 * address: optional { postalcode, housenumber, houseaddition }. When
 *   present, exposes POSTAL_CODE / HOUSE_NUMBER / HOUSE_ADDITION /
 *   ADDRESS to both the subject template and the body template.
 */
export async function sendReportEmail({ to, orderId, pdfBuffer, filename, config, emailTemplate, address }) {
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
    POSTAL_CODE: prettyPostalCode(address?.postalcode),
    HOUSE_NUMBER: String(address?.housenumber || "").trim(),
    HOUSE_ADDITION: String(address?.houseaddition || "").trim(),
    ADDRESS: formatAddress(address),
    BODY_INTRO:
      config?.mail?.bodyIntro ||
      "Bedankt voor de bestelling. Hierbij het aangevraagde rapport als PDF-bijlage.",
    CONTACT_LINE_HTML: config?.mail?.contactLine ? `<p>${config.mail.contactLine}</p>` : "",
    SIGN_OFF_HTML: String(
      config?.mail?.signOff || `Met vriendelijke groet,\n${config?.brand?.name || ""}`
    ).replace(/\n/g, "<br/>"),
  };

  // Subject and body share the same variable set so templates can use
  // POSTAL_CODE / HOUSE_NUMBER / HOUSE_ADDITION / ADDRESS in either place.
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
