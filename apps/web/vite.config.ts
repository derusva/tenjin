import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "generateSW",
      registerType: "autoUpdate",
      includeAssets: ["tenjin-mark.svg"],
      manifest: {
        name: "Tenjin 日语学习账本",
        short_name: "Tenjin",
        lang: "zh-Hans",
        description: "离线优先的个人日语学习账本",
        display: "standalone",
        start_url: "/",
        background_color: "#F3EFE6",
        theme_color: "#123F31",
        icons: [
          {
            src: "tenjin-mark.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
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
