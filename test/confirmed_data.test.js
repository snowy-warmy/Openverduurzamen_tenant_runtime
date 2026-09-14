// Regressietest voor de velden van confirmed_data die de runtime doorlaat.
//
// WAAROM DEZE TEST BESTAAT
// normalizeConfirmedDataInput() bouwt confirmed_data opnieuw op uit een vaste
// lijst velden. Die functie draait bij het volledige rapport: de adviseursflow
// (/api/internal/full/render), de overdracht vanuit het snelle rapport en de
// betaalde route. Toen de formulieren van tenant_der het aantal zonnepanelen
// gingen vragen, werkten formulier en report-api allebei -- en toch kwam het
// aantal voor het volledige rapport nooit aan, omdat het hier wegviel. Niets
// faalde; de report-api rekende gewoon met een schatting.
//
// Het snelle rapport had dit probleem niet: /api/mid/stream stuurt de body
// ongewijzigd door.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfirmedDataInput } from "../index.js";

const BASIS = {
  soort_woning: "twee_onder_een_kap",
  build_year: 1990,
  floor_area_m2: 171,
  energy_label: "b",
  ventilation_type: "natuurlijk",
  heating_supply: "cv_ketel",
  heat_distribution: "radiatoren_convectoren",
  existing_measures: ["zonnepanelen", "dakisolatie"],
};

test("het aantal zonnepanelen komt door de normalisatie heen", () => {
  const uit = normalizeConfirmedDataInput({ ...BASIS, solar_panels_count: 10 });
  assert.equal(uit.solar_panels_count, 10);

  // Uit een formulier komt het vaak als tekst.
  assert.equal(normalizeConfirmedDataInput({ ...BASIS, solar_panels_count: "10" }).solar_panels_count, 10);
});

test("zonder aantal blijven het precies de oorspronkelijke acht velden", () => {
  // Orders en overdrachten zonder dit veld moeten exact gelijk blijven.
  const verwacht = [
    "soort_woning", "build_year", "floor_area_m2", "energy_label",
    "ventilation_type", "heating_supply", "heat_distribution", "existing_measures",
  ];
  for (const leeg of [undefined, null, "", "   ", "geen getal"]) {
    const uit = normalizeConfirmedDataInput({ ...BASIS, solar_panels_count: leeg });
    assert.deepEqual(Object.keys(uit), verwacht, `solar_panels_count=${JSON.stringify(leeg)} voegde een veld toe`);
  }
  assert.deepEqual(Object.keys(normalizeConfirmedDataInput(BASIS)), verwacht);
});

test("de bestaande velden veranderen niet door de toevoeging", () => {
  const zonder = normalizeConfirmedDataInput(BASIS);
  const met = normalizeConfirmedDataInput({ ...BASIS, solar_panels_count: 10 });
  const { solar_panels_count, ...rest } = met;
  assert.deepEqual(rest, zonder);
});
