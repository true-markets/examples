import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The server reads API_PORT from .env, so the dev proxy follows it.
  const port = loadEnv(mode, process.cwd(), "").API_PORT || process.env.API_PORT || "4850";
  const target = `http://localhost:${port}`;
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react(), tailwindcss()],
    build: { outDir: "../dist", emptyOutDir: true },
    server: {
      port: 5181,
      proxy: { "/api": target, "/ws": { target, ws: true } },
    },
  };
});
