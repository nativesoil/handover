import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "conformance/**/*.test.ts"],
    environment: "node",
  },
});
