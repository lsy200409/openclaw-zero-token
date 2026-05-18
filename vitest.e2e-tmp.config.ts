import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts", "src/**/*.node.test.ts"],
    environment: "jsdom",
    testTimeout: 30_000,
  },
});