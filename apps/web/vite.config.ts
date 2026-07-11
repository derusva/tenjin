import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "generateSW",
      registerType: "autoUpdate",
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
        start_url: "/",
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
