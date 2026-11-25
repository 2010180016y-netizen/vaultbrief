import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Portable static build: relative asset paths so the bundle can be served from
// Cloudflare Pages, Firebase Hosting, GitHub Pages, or any static host/subpath.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      // onnxruntime-web is loaded from jsDelivr at run time (see
      // src/engine/embeddings.ts), so the 26 MB WASM copy must not be deployed:
      // static hosts such as Cloudflare Pages reject files above 25 MiB.
      name: "drop-ort-wasm",
      generateBundle(_options, bundle) {
        for (const name of Object.keys(bundle)) {
          if (name.endsWith(".wasm")) delete bundle[name];
        }
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
