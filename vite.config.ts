import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "/diorama/",
  plugins: [react()],
  worker: { format: "es" },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
  build: { target: "es2022" },
});
