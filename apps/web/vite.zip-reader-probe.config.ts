import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  define: {
    __TENJIN_COMMIT_SHA__: JSON.stringify(
      process.env.TENJIN_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local-uncommitted",
    ),
  },
  build: {
    emptyOutDir: true,
    outDir: "dist-zip-reader-probe",
    rollupOptions: {
      input: "zip-reader-probe.html",
    },
  },
});
