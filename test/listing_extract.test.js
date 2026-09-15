// Doorgifte van de geplakte advertentietekst naar de report-api.
//
// De browser van De Energie Raadgever stuurt een advertentietekst naar
// /api/mid/listing-extract. De runtime moet die ongewijzigd doorgeven, met het
// rapportprofiel van de tenant erbij: de report-api beslist daarop of de tenant
// dit mag. Ontbreekt de doorgifte, dan faalt niets zichtbaar -- de knop zou
// alleen nooit iets invullen.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTenantApp } from "../index.js";

async function listen(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 1;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function roepAan({ config, body, upstreamStatus = 200, upstreamJson }) {
  let captured = null;
  let pad = null;
  const upstream = await listen((req, res) => {
    let raw = "";
    pad = req.url;
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = raw;
      res.writeHead(upstreamStatus, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify(upstreamJson));
    });
  });

  const prevUrl = process.env.FULL_APP_RENDER_URL;
  process.env.FULL_APP_RENDER_URL = `http://127.0.0.1:${upstream.port}/api/full/render`;
  const app = createTenantApp(config);
  const server = await listen(app);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/mid/listing-extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json(), captured: captured ? JSON.parse(captured) : null, pad };
  } finally {
    await server.close();
    await upstream.close();
    if (prevUrl === undefined) delete process.env.FULL_APP_RENDER_URL;
    else process.env.FULL_APP_RENDER_URL = prevUrl;
  }
}

test("de advertentietekst gaat met het rapportprofiel naar de report-api", async () => {
  const uit = await roepAan({
    config: { id: "der", brand: { name: "DER" }, report: { labelFloor: "A" } },
    body: { tekst: "10 zonnepanelen, energielabel B", ongevraagd: "x" },
    upstreamJson: { velden: { solar_panels_count: 10 } },
  });
  assert.equal(uit.pad, "/api/mid/listing-extract");
  assert.equal(uit.captured.tekst, "10 zonnepanelen, energielabel B");
  assert.equal(uit.captured.tenant.report.labelFloor, "A");
  assert.equal(uit.captured.ongevraagd, undefined, "alleen de tekst en de tenant gaan door");
  assert.equal(uit.status, 200);
  assert.equal(uit.json.velden.solar_panels_count, 10);
});

test("een weigering van de report-api komt met status en melding terug", async () => {
  const uit = await roepAan({
    config: { id: "zonder", brand: {} },
    body: { tekst: "kort" },
    upstreamStatus: 404,
    upstreamJson: { error: "Niet beschikbaar." },
  });
  assert.equal(uit.status, 404);
  assert.equal(uit.json.error, "Niet beschikbaar.");
});
