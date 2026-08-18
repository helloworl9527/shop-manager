import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时把 /api 代理到后端，避免跨域顾虑（后端也已开 CORS）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_BASE || "http://127.0.0.1:3000", changeOrigin: true },
    },
  },
});
