import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发期把 /api 代理到 Fastify，前端代码里不用写死端口。
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
