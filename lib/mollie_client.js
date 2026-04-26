const MOLLIE_BASE = "https://api.mollie.com/v2";

function getApiKey() {
  const key = process.env.MOLLIE_API_KEY;
  if (!key) throw new Error("MOLLIE_API_KEY ontbreekt.");
  return key;
}

function getHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
}

export function toMoneyValue(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Ongeldig bedrag voor Mollie.");
  return n.toFixed(2);
}

export async function createMolliePayment({ amountEur, description, redirectUrl, webhookUrl, metadata }) {
  const res = await fetch(`${MOLLIE_BASE}/payments`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      amount: { currency: process.env.CURRENCY || "EUR", value: toMoneyValue(amountEur) },
      description,
      redirectUrl,
      webhookUrl,
      metadata,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail || json?.title || `Mollie create payment failed (${res.status})`);

  return {
    id: json.id,
    status: json.status,
    checkout_url: json._links?.checkout?.href || null,
    raw: json,
  };
}

export async function getMolliePayment(paymentId) {
  const res = await fetch(`${MOLLIE_BASE}/payments/${encodeURIComponent(paymentId)}`, { headers: getHeaders() });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.detail || json?.title || `Mollie get payment failed (${res.status})`);
  return json;
}
