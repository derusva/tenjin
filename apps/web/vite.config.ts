import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

const PAGES_BASE = "/tenjin/";

export default defineConfig({
  base: PAGES_BASE,
  plugins: [
    react(),
    VitePWA({
      strategies: "generateSW",
      // A waiting worker activates after every client closes, so an in-memory
      // capture draft is never discarded by an automatic reload.
      registerType: "prompt",
      includeAssets: [
        "apple-touch-icon.png",
        "tenjin-192.png",
        "tenjin-512.png",
        "tenjin-maskable.svg",
        "tenjin-maskable-512.png",
        "tenjin-mark.svg",
      ],
      manifest: {
        name: "Tenjin 日语学习账本",
        short_name: "Tenjin",
        lang: "zh-Hans",
        description: "离线优先的个人日语学习账本",
        display: "standalone",
        scope: PAGES_BASE,
        start_url: PAGES_BASE,
        background_color: "#F3EFE6",
        theme_color: "#123F31",
        icons: [
          {
            src: "tenjin-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "tenjin-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "tenjin-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{css,html,js}"],
        navigateFallback: "index.html",
      },
    }),
  ],
  test: {
    clearMocks: true,
    environment: "jsdom",
    restoreMocks: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
