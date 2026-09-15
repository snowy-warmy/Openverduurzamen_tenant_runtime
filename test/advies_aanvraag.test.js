// Aanvraag voor vrijblijvend advies vanuit het snelle rapport.
//
// De Energie Raadgever stuurt de aanvraag met het snelle rapport naar een
// partner (WoonWijzerWinkel) op een vast adres uit de tenantconfig, niet naar
// LEAD_EMAIL. Een tenant zonder adviceRequest mag hier niets van merken.

import test from "node:test";
import assert from "node:assert/strict";
import { adviesAanvraagMail, losRapportHtml } from "../lib/advies_aanvraag.js";

const DER = {
  id: "deenergieraadgever",
  brand: { name: "De Energie Raadgever" },
  adviceRequest: { recipient: "dennisreus91@gmail.com", partnerName: "WoonWijzerWinkel" },
};

test("de aanvraag gaat naar het vaste adres van de partner", () => {
  const mail = adviesAanvraagMail({ config: DER, firstName: "Jan", lastName: "Jansen", adres: "Horst 36 22, 8225NP Lelystad" });
  assert.equal(mail.to, "dennisreus91@gmail.com");
  assert.match(mail.subject, /vrijblijvend advies/i);
  assert.match(mail.subject, /Horst 36 22/);
  assert.match(mail.intro, /WoonWijzerWinkel/);
  assert.match(mail.intro, /De Energie Raadgever/);
});

test("zonder adviceRequest kent de tenant deze aanvraag niet", () => {
  assert.equal(adviesAanvraagMail({ config: { id: "woonwijzerwinkel" }, firstName: "a", lastName: "b" }), null);
  assert.equal(adviesAanvraagMail({ config: { adviceRequest: { recipient: "  " } } }), null);
});

test("het losse rapport verbergt knoppen en de mobiele weergave", () => {
  const html = losRapportHtml({ adres: "Horst 36 22", rapportHtml: '<div class="mid-grid">x</div>', tenantNaam: "De Energie Raadgever" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /mid-mobile-stack,.mid-footer-cta/);
  assert.match(html, /<div class="mid-grid">x<\/div>/);
  assert.match(html, /De Energie Raadgever · Horst 36 22/);
  assert.doesNotMatch(losRapportHtml({ adres: "<script>", rapportHtml: "" }), /<script>/);
});
