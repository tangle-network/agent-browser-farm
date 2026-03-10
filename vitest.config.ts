import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/backends/browserless.ts",
        "src/backends/playwright.ts",
        "src/backends/android.ts",
        "src/backends/android-device.ts",
        "src/backends/ios-safari.ts",
        "src/backends/ios-device.ts",
        "src/backends/safari-desktop.ts",
        "src/main.ts",
        "src/index.ts",
      ],
    },
  },
});
