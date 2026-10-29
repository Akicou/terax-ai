// Imported eagerly by the editor stack: keep this file dependency-free.

const DATABASE_EXT = new Set(["db", "sqlite", "sqlite3", "db3", "duckdb"]);

/** Files opened in the database view instead of the text editor. */
export function isDatabasePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return DATABASE_EXT.has(name.slice(dot + 1).toLowerCase());
}
