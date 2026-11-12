import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The server reads PORT from .env, so the dev proxy follows it and a changed port needs no second edit.
  const port = loadEnv(mode, process.cwd(), "").PORT || process.env.PORT || "4848";
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react(), tailwindcss()],
    build: { outDir: "../dist", emptyOutDir: true },
    server: { port: 5180, proxy: { "/api": `http://localhost:${port}` } },
  };
});
