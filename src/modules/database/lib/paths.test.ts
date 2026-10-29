import { describe, expect, it } from "vitest";
import { isDatabasePath } from "./paths";

describe("isDatabasePath", () => {
  it("matches database extensions case-insensitively", () => {
    for (const p of [
      "a.db",
      "/x/y/app.sqlite",
      "C:\\data\\b.SQLITE3",
      "c.db3",
      "warehouse.duckdb",
    ]) {
      expect(isDatabasePath(p)).toBe(true);
    }
  });

  it("ignores other files and dotfiles", () => {
    for (const p of ["a.sql", "db", "/x/.db", "notes.db.txt", "/x.db/file"]) {
      expect(isDatabasePath(p)).toBe(false);
    }
  });
});
