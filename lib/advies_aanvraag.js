// lib/advies_aanvraag.js
//
// Aanvraag voor vrijblijvend advies vanuit het snelle rapport.
//
// De Energie Raadgever biedt onder het snelle rapport geen volledig rapport
// meer aan, maar een gratis extra dienst: vrijblijvend advies van een partner
// (WoonWijzerWinkel) die het rapport omzet in concrete maatregelen en de
// uitvoering regelt. De aanvraag gaat met het snelle rapport naar het adres in
// config.adviceRequest.recipient, niet naar LEAD_EMAIL.
//
// Een tenant zonder config.adviceRequest kent deze aanvraag niet: de route
// behandelt hem dan als een gewoon contactverzoek.

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Ontvanger en teksten van de mail, of null als de tenant geen adviesaanvraag
 * kent.
 */
export function adviesAanvraagMail({ config, firstName, lastName, adres }) {
  const ontvanger = String(config?.adviceRequest?.recipient || "").trim();
  if (!ontvanger) return null;
  const partner = String(config?.adviceRequest?.partnerName || "de partner").trim();
  const naam = [firstName, lastName].filter(Boolean).join(" ").trim() || "(naam onbekend)";
  const tenant = config?.brand?.name || config?.id || "";
  return {
    to: ontvanger,
    subject: `Aanvraag vrijblijvend advies — ${adres || naam}`,
    heading: "Aanvraag vrijblijvend advies",
    intro: `${naam} vraagt via het snelle verduurzamingsrapport van ${tenant} vrijblijvend advies aan bij ${partner}. Het snelle rapport zit als bijlage bij deze mail.`,
    partner,
  };
}

/** Het snelle rapport als losse HTML-pagina, geschikt om naar pdf om te zetten. */
export function losRapportHtml({ adres, rapportHtml, tenantNaam }) {
  const titel = `Snel verduurzamingsrapport${adres ? ` — ${adres}` : ""}`;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${esc(titel)}</title>
<style>
@page{size:A4;margin:10mm}
body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.kop{padding:0 0 8px;margin:0 0 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#475569}
.mid-mobile-stack,.mid-footer-cta,.contactCta,.rapportActies{display:none!important}
.mid-grid-cell,.mid-kerngegevens,.mid-footer,.mid-toelichting{break-inside:avoid;page-break-inside:avoid}
</style></head><body>
<div class="kop">${esc(tenantNaam || "")}${adres ? ` · ${esc(adres)}` : ""}</div>
${String(rapportHtml || "")}
</body></html>`;
}

export default { adviesAanvraagMail, losRapportHtml };
