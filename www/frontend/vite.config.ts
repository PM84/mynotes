/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "robots.txt", "apple-touch-icon.png"],
      manifest: {
        name: "MyNotes",
        short_name: "MyNotes",
        description: "KI-gestützte Notiz-PWA",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,wasm}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: "/index.html",
        // SPA-Routen wie /notes/<uuid> oder /search dürfen NICHT vom SW
        // an's Backend weitergereicht werden – sie werden von index.html
        // gerendert. navigateFallbackDenylist schließt API + WS aus.
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        runtimeCaching: [
          {
            // Nur echte API-GETs (nicht die gleichnamigen SPA-Routen).
            urlPattern: ({ url, request, sameOrigin }) =>
              sameOrigin &&
              request.method === "GET" &&
              (url.pathname.startsWith("/api/notes") ||
                url.pathname.startsWith("/api/search")),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "api-get", expiration: { maxAgeSeconds: 7 * 24 * 3600 } },
          },
          {
            urlPattern: ({ url, request, sameOrigin }) =>
              sameOrigin &&
              request.method === "GET" &&
              url.pathname.startsWith("/api/assets"),
            handler: "CacheFirst",
            options: {
              cacheName: "asset-files",
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
      devOptions: { enabled: true, type: "module" },
    }),
  ],
  server: { host: "0.0.0.0", port: 5173 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: false,
  },
});
