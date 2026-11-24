import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The server reads API_PORT and API_HOST from .env, so the dev proxy and the dev server follow them.
  const env = loadEnv(mode, process.cwd(), "");
  const port = env.API_PORT || process.env.API_PORT || "4850";
  const host = env.API_HOST || process.env.API_HOST || "127.0.0.1";
  // The proxy reaches the API server on this machine, whatever address it listens on.
  const local = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const target = `http://${local}:${port}`;
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react(), tailwindcss()],
    build: { outDir: "../dist", emptyOutDir: true },
    server: {
      port: 5181,
      host,
      proxy: { "/api": target, "/ws": { target, ws: true } },
    },
  };
});
