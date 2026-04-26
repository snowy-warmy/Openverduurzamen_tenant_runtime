export async function htmlToPdfBuffer(html) {
  const apiKey = process.env.PDFBOLT_API_KEY;
  if (!apiKey) throw new Error("PDFBOLT_API_KEY ontbreekt in orchestrator.");

  const htmlBase64 = Buffer.from(String(html || ""), "utf-8").toString("base64");

  const body = {
    html: htmlBase64,
    format: "A4",
    printBackground: true,
    preferCssPageSize: true,
    emulateMediaType: "print",
    margin: {
      top: "0mm",
      right: "0mm",
      bottom: "0mm",
      left: "0mm",
    },
  };

  const controller = new AbortController();
  const timeoutMs = Number(process.env.PDFBOLT_TIMEOUT_MS || 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch("https://api.pdfbolt.com/v1/direct", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "API-KEY": apiKey,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PDFBolt fout (${res.status}): ${txt.slice(0, 800)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
