import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Portable static build: relative asset paths so the bundle can be served from
// Cloudflare Pages, Firebase Hosting, GitHub Pages, or any static host/subpath.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
