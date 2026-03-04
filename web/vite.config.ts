import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3080",
      "/health": "http://localhost:3080",
    },
  },
});
