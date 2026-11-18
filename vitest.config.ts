import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several tests write a few hundred transactions to a real SQLite file, each one synced to
    // disk. On a busy disk a commit can take 20-50 ms, which is over the 5 s default for those tests.
    testTimeout: 30_000,
  },
});
