import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.toml" },
    miniflare: {
      d1Databases: ["DB"],
      bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations"), D1_ADMIN_DEV: "true" }
    }
  }))]
});
