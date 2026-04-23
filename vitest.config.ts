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
    include: ["server/**/*.test.ts"],
    environment: "node",
  },
});
