import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCESS_TOKEN: "test-rw-token",
          READ_ONLY_ACCESS_TOKEN: "test-ro-token",
        },
      },
    }),
  ],
});
