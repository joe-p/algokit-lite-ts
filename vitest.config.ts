import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test files share LocalNet accounts, so run them one at a time
    fileParallelism: false,
  },
});
