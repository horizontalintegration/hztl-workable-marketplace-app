# 🏪 HZTL Workable Marketplace App

Sitecore Marketplace app for the HZTL Digital Workable integration. Scaffolded from
[`Sitecore/marketplace-starter`](https://github.com/Sitecore/marketplace-starter), pruned down
to the one extension point this app needs.

## 🧩 Extension Points

### Pages Context Panel Extension

- **Location:** `app/pages-contextpanel-extension/page.tsx`
- **Description:**  
  Displays context information about the current page in the XM Cloud Pages editor.
  - Initializes the Marketplace SDK client.
  - Subscribes to `pages.context` using the SDK to handle events.
  - Shows page ID, title, language, and path.
  - Updates data automatically as the user changes selected page.
  - **Planned:** read the current item's `careerJobId` field and add a button that force-syncs
    that Career Detail Page stub from Workable, via `hztl-digital-2026`'s
    `POST /api/workable/sync` endpoint.

The starter's other four extension points (Custom Field, Dashboard Widget, Fullscreen,
Standalone) were removed - this app only needs a Pages Context Panel.

# 📦 Getting Started

Note: You cannot access extension point routes directly in the browser (e.g., localhost:3000/...). These routes must be invoked within the Sitecore XM Cloud environment through the configured extension points.To learn how to properly configure and hook up your app to extension points, refer to the official [Sitecore Marketplace documentation](https://doc.sitecore.com/mp/en/developers/marketplace/extension-points.html)


1. Create Your Own Repository:
   - You can either fork this repository or create a new template based on it.
   - This gives you a clean starting point with all the necessary scaffolding for Marketplace extension development.

2. Remove the endpoints you dont require
   - Remove any extension points you don't plan to support by deleting their respective folders inside the app directory.
   - Each folder in app corresponds to a specific extension point (e.g., custom-field-extension, dashboard-widget-extension, etc.).

3. Install dependencies:
   ```sh
   npm install
   ```

4. Run the development server:
   ```sh
   npm run dev
   ```

5. Install the application and test in the different extension points by following the [Sitecore documentation](https://doc.sitecore.com/mp/en/developers/marketplace/introduction-to-sitecore-marketplace.html)

## 📝 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🐛 Issues

If you encounter any issues or have suggestions for improvements, please open an issue on the repository.