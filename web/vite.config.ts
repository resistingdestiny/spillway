import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// The commit the site was built from, shown on the Verify page.
const commit = (() => {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig({
  server: { host: "127.0.0.1", port: 5179 },
  preview: { host: "127.0.0.1", port: 4179 },
  build: { target: "es2022" },
  define: { __COMMIT__: JSON.stringify(commit) },
});
