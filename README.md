# 🏪 HZTL Workable Marketplace App

Sitecore Marketplace app for the HZTL Digital Workable integration. Scaffolded from
[`Sitecore/marketplace-starter`](https://github.com/Sitecore/marketplace-starter), pruned down
to the one extension point this app needs.

## 🧩 Extension Points

### Page Builder Context Panel Extension

- **Location:** `app/pages-contextpanel-extension/page.tsx`
- **Renders inside:** SitecoreAI Page Builder only, as a left-side panel next to the page
  canvas - not the classic Content Editor ribbon, and not any other extension point surface.
- **Description:**
  - Subscribes to `pages.context` to get the open item's id/language.
  - Looks up that item via Authoring GraphQL (`xmc.authoring.graphql`), matching it against
    the `CareerDetailPage` type - an item that isn't one simply doesn't populate `careerJobId`,
    which the panel treats as "not a Career Detail Page" and shows no button.
  - If the item is a Career Detail Page, shows its Workable job shortcode and a **Force Sync**
    button.
  - The button calls this app's own `POST /api/force-sync`, which is the only place in this
    app holding `WORKABLE_FORCE_UPDATE_SECRET`, and proxies to `hztl-digital-2026`'s existing
    `POST /api/workable/sync?shortcode=...`.
  - On success, calls `pages.reloadCanvas` so the editor sees the refreshed content without a
    manual reload.

The starter's other four extension points (Custom Field, Dashboard Widget, Fullscreen,
Standalone) were removed - this app only needs the Page Builder Context Panel.

## 🚀 Getting Started (local dev)

Note: extension point routes only render inside Sitecore's own UI, not by visiting
`localhost:3000/pages-contextpanel-extension` directly in a browser - the SDK client's
handshake needs a real Sitecore Pages iframe host.

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in both values (see **Configuration** below)
3. `npm run dev`
4. Register/configure the app in the Cloud Portal (see **Deployment**) pointing its Deployment
   URL at this dev server, then open Sitecore Pages on a Career Detail Page item to see the
   panel render for real

## ⚙️ Configuration

Two environment variables, both read only by the server-side `/api/force-sync` route - never
by the client panel:

| Variable | Where it comes from | Notes |
|---|---|---|
| `WORKABLE_FORCE_UPDATE_SECRET` | Generate once (e.g. `openssl rand -hex 32`) | Must be the **exact same value** configured as `WORKABLE_FORCE_UPDATE_SECRET` on the `hztl-digital-2026` deployment - it's a shared secret between the two apps, not something this app owns independently |
| `HZTL_SYNC_ENDPOINT_URL` | The `hztl-digital-2026` deployment's own public URL | Absolute URL, no trailing slash, e.g. `https://hztl-digital.vercel.app` |

Local dev: put both in `.env.local` (already gitignored - never commit it).

## 📤 Deployment

1. Deploy this app to hosting with a public HTTPS URL (Vercel, matching how
   `hztl-digital-2026` is hosted, is the natural default - zero-config for a plain Next.js app,
   no `vercel.json` needed since this app has no cron jobs).
2. In that hosting project's environment variables, add `WORKABLE_FORCE_UPDATE_SECRET` and
   `HZTL_SYNC_ENDPOINT_URL` from the table above. Mark the secret as sensitive/encrypted if the
   platform offers that (Vercel: Project → Settings → Environment Variables → toggle
   "Sensitive").
3. Register the app in the Sitecore Cloud Portal (App Studio → Studio → Create app → Custom),
   configure the **Page Builder Context Panel** extension point with Route URL
   `/pages-contextpanel-extension`, and set its Deployment URL to this app's real hosted URL.
   See [Register a custom app](https://doc.sitecore.com/mp/en/developers/marketplace/register-a-custom-app.html)
   and [Configure and activate a custom app](https://doc.sitecore.com/mp/en/developers/marketplace/configure-and-activate-a-custom-app.html).
4. Activate the app for the target environment, then verify on a real Career Detail Page item
   in Sitecore Pages.

## 📝 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🐛 Issues

If you encounter any issues or have suggestions for improvements, please open an issue on the repository.