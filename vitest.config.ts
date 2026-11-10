import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    maxWorkers: 4,
    coverage: {
      include: ["src/**/*.ts"],
    },
  },
});
