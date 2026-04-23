import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@":       path.resolve(__dirname, "./client/src"),
    },
  },
  test: {
    root: ".",
    include: ["server/**/__tests__/**/*.test.ts", "server/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
