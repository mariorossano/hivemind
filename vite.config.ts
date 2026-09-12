import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hive = process.env.HIVEMIND_URL ?? "http://127.0.0.1:7420";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 7421,
    strictPort: true,
    proxy: {
      "/api": hive,
      "/ws": { target: hive.replace("http", "ws"), ws: true },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
