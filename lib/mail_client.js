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
  const subject = fillTemplate(subjectTemplate, { PRODUCT_NAME: productName, ORDER_ID: orderId });
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
