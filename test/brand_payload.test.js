// Regressietest voor de brand-payload die naar de report-api gaat.
//
// WAAROM DEZE TEST BESTAAT
// De runtime stelt per render-call zelf samen welke tenantvelden de
// report-api krijgt (buildBrandPayload). Dat is een handmatige lijst. Toen
// tenant_der een `report`-blok in zijn config kreeg — doellabels, focus,
// en of het volledige rapport in de dienstverlening zit — bleef dat veld
// buiten die lijst. Gevolg: de config stond in de tenant, de report-api
// kon het lezen, maar het bereikte de renderer nooit. Het rapport was
// daardoor live niet te onderscheiden van een tenant zonder profiel:
// prijskaart en "Fase 1" in plaats van scenario's met doellabel A.
//
// De fout was onzichtbaar omdat niets faalt: een ontbrekend veld betekent
// alleen dat de report-api zijn defaults gebruikt. Deze test maakt de
// doorgifte expliciet, zodat een volgende toevoeging aan de lijst niet
// stil kan wegvallen.
//
// OPZET
// De mid/stream-route proxyt naar FULL_APP_RENDER_URL (met /api/full/render
// vervangen door /api/mid/stream). We zetten daar een lokale server voor en
// lezen de doorgestuurde body: dat is precies wat de report-api zou zien.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

// NB: de runtime houdt een undici-Agent met keep-alive open voor zijn
// proxy-calls. Die handle is van buiten niet te sluiten en houdt het
// event-loop bezig, waardoor een testrun na de laatste assertie blijft
// hangen. Daarom draait de suite met `--test-force-exit` (zie package.json).
// Een `process.exit()` in een after-hook is géén alternatief: dat sluit af
// terwijl libuv nog handles opruimt en crasht op UV_HANDLE_CLOSING.

/** Start een server en geef { port, close } terug. */
async function listen(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        // closeAllConnections(): server.close() wacht anders op de keep-alive
        // sockets die de proxy openhoudt.
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/**
 * Doet één POST /api/mid/stream tegen een app met deze config en geeft de
 * body terug die de proxy naar de report-api stuurde.
 */
async function capturedUpstreamBody(config) {
  let captured = null;

  const upstream = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = raw;
      // Minimale SSE-respons: de proxy pipet alleen door.
      // Connection: close sluit de socket die de proxy-Agent anders
      // keep-alive houdt. Dat alleen was niet genoeg om het proces te laten
      // eindigen: createTenantApp() startte ook boot-timers zonder unref().
      // Die zijn nu ge-unref'd in index.js. Forceren was geen optie —
      // process.exit() en --test-force-exit sluiten af terwijl libuv nog
      // handles opruimt en crashen dan op Windows (UV_HANDLE_CLOSING).
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end("event: done\ndata: {}\n\n");
    });
  });

  const prevUrl = process.env.FULL_APP_RENDER_URL;
  process.env.FULL_APP_RENDER_URL = `http://127.0.0.1:${upstream.port}/api/full/render`;

  const app = createTenantApp(config);
  const server = await listen(app);

  try {
    await fetch(`http://127.0.0.1:${server.port}/api/mid/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: { postalcode: "1234AB", housenumber: "1" } }),
    }).then((r) => r.text());
  } finally {
    await server.close();
    await upstream.close();
    if (prevUrl === undefined) delete process.env.FULL_APP_RENDER_URL;
    else process.env.FULL_APP_RENDER_URL = prevUrl;
  }

  assert.ok(captured, "de proxy heeft geen body naar de upstream gestuurd");
  return JSON.parse(captured);
}

test("het rapportprofiel van de tenant gaat mee naar de report-api", async () => {
  const body = await capturedUpstreamBody({
    id: "testtenant",
    brand: { name: "Test" },
    report: {
      fullReportAccess: "included",
      midFocus: ["investering", "subsidies"],
      labelFloor: "A",
      labelScenarios: ["A", "A+", "A++"],
    },
  });

  assert.equal(body.tenant.id, "testtenant");
  assert.deepEqual(body.tenant.report.labelScenarios, ["A", "A+", "A++"]);
  assert.equal(body.tenant.report.labelFloor, "A");
  assert.equal(body.tenant.report.fullReportAccess, "included");
  assert.deepEqual(body.tenant.report.midFocus, ["investering", "subsidies"]);
});

test("een tenant zonder rapportprofiel stuurt een leeg profiel, niet undefined", async () => {
  const body = await capturedUpstreamBody({ id: "zonderprofiel", brand: { name: "Zonder" } });

  // Leeg object en niet undefined: de report-api mergt dit over zijn eigen
  // defaults, en hasReportProfile() blijft false. Zo houdt elke tenant die
  // geen profiel heeft exact het gedrag van voor deze wijziging.
  assert.deepEqual(body.tenant.report, {});
});

test("de adresvelden uit het verzoek blijven onaangetast", async () => {
  const body = await capturedUpstreamBody({ id: "t", brand: {} });

  // De proxy voegt alleen de tenant toe; alles wat de browser stuurde moet
  // ongewijzigd doorgaan, anders verschuift het rapport op andere velden.
  assert.deepEqual(body.address, { postalcode: "1234AB", housenumber: "1" });
});
