import { defineConfig } from "vitest/config"

// The lab config keeps mutation suites out and moves caches and coverage inside the sandbox.
export default defineConfig({
  cacheDir: ".lab-cache",
  test: {
    include: ["tools/test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/coverage/**",
      "**/reports/**",
      "**/*-mutation.test.ts",
      "**/*-mutation-*.test.ts",
      "**/*-kill-survivors.test.ts",
      "**/*-kill.test.ts",
    ],
    testTimeout: 15000,
  },
})
