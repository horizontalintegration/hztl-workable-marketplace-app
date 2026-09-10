# 🏪 Workable Marketplace App

A reusable Sitecore Marketplace app: an in-context "Force Sync" button for an editor viewing a
Workable-backed content item in Sitecore Pages, so they don't have to wait for the next
scheduled batch sync. First built for `hztl-digital-2026`, but every part of it that's specific
to one project's content model or one project's sync endpoint is configuration, not code - see
**Reusing this app for another project** below. Scaffolded from
[`Sitecore/marketplace-starter`](https://github.com/Sitecore/marketplace-starter), pruned down
to the one extension point this app needs.

## 🧩 Extension Points

### Page Builder Context Panel Extension

- **Location:** `app/pages-contextpanel-extension/page.tsx`
- **Renders inside:** SitecoreAI Page Builder only, as a left-side panel next to the page
  canvas - not the classic Content Editor ribbon, and not any other extension point surface.
- **Description:**
  - Subscribes to `pages.context` to get the open item's id/language.
  - Looks up that item via Authoring GraphQL (`xmc.authoring.graphql`), matching it against the
    configured item type (`NEXT_PUBLIC_SITECORE_ITEM_GRAPHQL_TYPE`, default `CareerDetailPage`)
    - an item that isn't one simply doesn't populate the configured id field, which the panel
    treats as "not applicable" and shows no button.
  - If the item matches, shows its Workable id and a **Force Sync** button.
  - The button calls this app's own `POST /api/force-sync`, which is the only place in this app
    holding `WORKABLE_FORCE_UPDATE_SECRET`, and proxies to whatever endpoint
    `WORKABLE_SYNC_ENDPOINT_URL` names. Rate-limited to 5 requests/minute per client IP
    (best-effort, per serverless instance) since this route has no inbound auth of its own -
    see the route's header comment for the accepted threat model.
  - On the **Careers root page** specifically (resolved from the Site Settings item's
    `NEXT_PUBLIC_SITECORE_CAREERS_ROOT_FIELD` Droplink, default `careersRootPage`), shows a
    **Bulk Import** button instead - triggers the project's full scheduled Workable sync
    on demand, via `POST /api/bulk-import` (the only place holding
    `CRON_SECRET`), proxying to `WORKABLE_BULK_IMPORT_ENDPOINT_URL`.
    Rate-limited to 2 requests/5 minutes per client IP - this triggers a heavy, account-wide
    operation, not a single item.
  - On success, calls `pages.reloadCanvas` so the editor sees the refreshed content without a
    manual reload.

The starter's other four extension points (Custom Field, Dashboard Widget, Fullscreen,
Standalone) were removed - this app only needs the Page Builder Context Panel.

## 🚀 Getting Started (local dev)

Note: extension point routes only render inside Sitecore's own UI, not by visiting
`localhost:3000/pages-contextpanel-extension` directly in a browser - the SDK client's
handshake needs a real Sitecore Pages iframe host.

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in at least the two required values (see
   **Configuration** below)
3. `npm run dev`
4. Register/configure the app in the Cloud Portal (see **Deployment**) pointing its Deployment
   URL at this dev server, then open Sitecore Pages on a matching content item to see the panel
   render for real

Other scripts: `npm run lint` (ESLint), `npm run test` (Vitest, covers `/api/force-sync`'s and
`/api/bulk-import`'s error paths and rate limiting).

## ⚙️ Configuration

Secrets and endpoint URLs are read only by their respective server routes; `NEXT_PUBLIC_*`
values are inlined at build time for the client panel - never both, and the client panel never
sees either secret.

| Variable | Required? | Notes |
|---|---|---|
| `WORKABLE_FORCE_UPDATE_SECRET` | Always | Generate once (e.g. `openssl rand -hex 32`). Must be the **exact same value** the downstream sync endpoint checks - it's a shared secret between two apps, not something this app owns independently |
| `WORKABLE_SYNC_ENDPOINT_URL` | Always | The downstream project's force-sync endpoint - the **full URL, path included** (e.g. `https://hztl-digital.vercel.app/api/workable/sync`), not just a hostname. See the downstream contract below |
| `CRON_SECRET` | Always | Must be the **exact same value** as the downstream project's own `CRON_SECRET` - this reuses that secret rather than minting a dedicated one, since the downstream route doesn't distinguish its own scheduler from any other caller presenting the right bearer token |
| `WORKABLE_BULK_IMPORT_ENDPOINT_URL` | Always | The downstream project's scheduled bulk-import endpoint - full URL, path included (e.g. `https://hztl-digital.vercel.app/api/workable/import`) |
| `NEXT_PUBLIC_SITECORE_ITEM_GRAPHQL_TYPE` | Only if your content model differs | GraphQL type name of the template this app should recognize. Default: `CareerDetailPage`. Client-side (`NEXT_PUBLIC_`) - changing it means redeploying, not just restarting |
| `NEXT_PUBLIC_SITECORE_ITEM_ID_FIELD` | Only if your content model differs | Field on that template holding the id to sync by. Default: `careerJobId`. Same build-time caveat as above |
| `NEXT_PUBLIC_SITECORE_CAREERS_ROOT_SETTINGS_PATH` | Only if your content model differs | Path to the Site Settings item naming the Careers root. Default: `/sitecore/content/HztlFoundation/HztlDigital/Settings/Site Settings` |
| `NEXT_PUBLIC_SITECORE_CAREERS_ROOT_FIELD` | Only if your content model differs | Field on that Site Settings item holding the Careers root reference. Default: `careersRootPage` |

Local dev: put these in `.env.local` (already gitignored - never commit it).

### Downstream contracts

Any project's endpoint named by `WORKABLE_SYNC_ENDPOINT_URL` must accept:

```
POST <WORKABLE_SYNC_ENDPOINT_URL>?shortcode=<id>
Header: x-workable-sync-secret: <WORKABLE_FORCE_UPDATE_SECRET>
```

...and respond with JSON `{ ok: boolean, operation?: string, error?: string }`. See
`hztl-digital-2026`'s `src/app/api/workable/sync/route.ts` for a reference implementation.

Any project's endpoint named by `WORKABLE_BULK_IMPORT_ENDPOINT_URL` must accept:

```
GET <WORKABLE_BULK_IMPORT_ENDPOINT_URL>
Header: Authorization: Bearer <CRON_SECRET>
```

...and respond with JSON
`{ ok: boolean, publishedJobCount?, created?, updated?, skipped?, failed?, staleRecycled?,
staleRecycleFailed?, reconciliationSkipped?, error? }`. See `hztl-digital-2026`'s
`src/app/api/workable/import/route.ts` for a reference implementation - it's the same route
that project's own Vercel Cron already calls on a schedule.

## 📤 Deployment

1. Deploy this app to hosting with a public HTTPS URL (Vercel is the natural default -
   zero-config for a plain Next.js app, no `vercel.json` needed since this app has no cron
   jobs).
2. In that hosting project's environment variables, add the variables from **Configuration**
   above. Mark the secret as sensitive/encrypted if the platform offers that (Vercel: Project →
   Settings → Environment Variables → toggle "Sensitive").
3. Register the app in the Sitecore Cloud Portal (App Studio → Studio → Create app → Custom),
   configure the **Page Builder Context Panel** extension point with Route URL
   `/pages-contextpanel-extension`, and set its Deployment URL to this app's real hosted URL.
   See [Register a custom app](https://doc.sitecore.com/mp/en/developers/marketplace/register-a-custom-app.html)
   and [Configure and activate a custom app](https://doc.sitecore.com/mp/en/developers/marketplace/configure-and-activate-a-custom-app.html).
4. Activate the app for the target environment, then verify on a real matching content item in
   Sitecore Pages.

## ♻️ Reusing this app for another project

This app is a per-project deployment, not a single multi-tenant instance - each project that
wants the Force Sync panel deploys and registers its own copy, configured for its own content
model and its own sync endpoint. To reuse it:

1. Fork or copy this repo.
2. Implement endpoints in your project matching the **downstream contracts** above (or point
   `WORKABLE_SYNC_ENDPOINT_URL`/`WORKABLE_BULK_IMPORT_ENDPOINT_URL` at existing ones if your
   project already has them).
3. If your content model's type/field names differ from `CareerDetailPage`/`careerJobId`/
   `careersRootPage`, set the relevant `NEXT_PUBLIC_*` variables - otherwise leave them unset
   and the defaults apply.
4. Deploy and register a **separate** app entry in your own org's Cloud Portal (Deployment URLs
   and Route URLs are per-app-registration, not shared across projects) - follow **Deployment**
   above with your own values.

Nothing about the UI copy, button text, or app name assumes any one project - "Workable Force
Sync" and "Force Sync" are deliberately generic.

## 📝 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🐛 Issues

If you encounter any issues or have suggestions for improvements, please open an issue on the repository.
