import { defineConfig } from "vitest/config";

const packages = ["composer", "app-client", "localnet", "generator"];

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their sources via the tsconfig paths
    tsconfigPaths: true,
  },
  test: {
    // Test files share LocalNet accounts, so run them one at a time
    fileParallelism: false,
    projects: packages.map((name) => ({
      extends: true,
      test: { name, root: `packages/${name}` },
    })),
  },
});
