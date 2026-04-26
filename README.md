# @openverduurzamen/tenant-runtime

Shared runtime for OpenVerduurzamen tenant apps. Each tenant runs as its own Render service; they all import this package via a git URL pin in their `package.json`.

## What's in here

- `index.js` — exports `createTenantApp(config)`. Returns a fully configured Express app: tenant-branded pages, Mid → checkout handoff, Mollie payment, PDFBolt PDF, Resend email, recovery loop.
- `lib/` — orders store, prefill store, Mollie client, Resend client, PDFBolt client.
- `scripts/update-all-tenants.sh` — fleet update script.

## How tenant apps consume it

```json
// In each tenant's package.json
{
  "dependencies": {
    "@openverduurzamen/tenant-runtime": "github:OpenVerduurzamen/tenant-runtime#v1.0.0"
  }
}
```

```js
// In each tenant's server.js
import { createTenantApp } from "@openverduurzamen/tenant-runtime";
import config from "./tenant.config.js";

const app = createTenantApp(config);
app.listen(process.env.PORT || 3000);
```

## Releasing a new version

1. Make changes in this repo, commit, push.
2. Tag and push: `git tag v1.0.1 && git push origin v1.0.1`
3. Roll out to every tenant: `./scripts/update-all-tenants.sh v1.0.1`

The script clones each tenant repo, bumps the runtime pin in its `package.json`, commits, pushes. Render auto-deploys each tenant.

## Public API

`createTenantApp(config)` — accepts a config object with this shape:

```js
{
  id: "woonwijzerwinkel",            // stable identifier
  publicDir: "/abs/path/to/public",  // where templates/ and assets/ live
  brand:    { name, legalName, accentColor, accentDark, coverSubtitle, runningHeader, logoPath },
  contact:  { phone, email, address1, address2, coverage, website },
  followUp: { enabled, chapterTitle, chapterIntro, services[], approachSteps[[t,b]], sealLine, ... },
  product:  { name, redirectAfterPaymentPath, termsPath, fullReportUrl },
  mail:     { fromAddress, subjectTemplate, signOff, bodyIntro, contactLine },
  payment:  { priceEur, description },
  prompts:  { systemRoleOverlay, adviceOverlay },
  reportApi:{ renderUrl, lookupUrl }
}
```

See `tenant-woonwijzerwinkel/tenant.config.js` for a fully-populated example.

## Required env vars (set on each tenant's Render service)

- `APP_BASE_URL` — that tenant's public URL
- `MOLLIE_API_KEY`
- `RESEND_API_KEY`
- `MAIL_BCC_ADDRESSES` (optional)
- `PDFBOLT_API_KEY`
- `FULL_APP_RENDER_URL`
- `FULL_APP_RENDER_API_KEY`
- `FULL_HANDOFF_API_KEY` (optional, required if Mid is doing handoffs)
- `ADMIN_API_KEY`
- `ORDERS_DATA_DIR=/var/data` (mount Render disk here)
