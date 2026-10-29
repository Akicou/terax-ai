import { completeFromList, type Completion } from "@codemirror/autocomplete";
import { StreamLanguage } from "@codemirror/language";
import { sqlite } from "@codemirror/legacy-modes/mode/sql";
import type { RelationInfo } from "./types";

export const sqliteLanguage = StreamLanguage.define(sqlite);

const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
  "IN",
  "LIKE",
  "GLOB",
  "BETWEEN",
  "DISTINCT",
  "COUNT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CREATE TABLE",
  "CREATE INDEX",
  "ALTER TABLE",
  "DROP TABLE",
  "PRAGMA",
  "WITH",
  "RETURNING",
  "EXPLAIN QUERY PLAN",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "VACUUM",
];

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/** Keyword, table and column completions for the SQL console. */
export function schemaCompletions(relations: readonly RelationInfo[]) {
  const options: Completion[] = KEYWORDS.map((k) => ({
    label: k,
    type: "keyword",
    boost: -1,
  }));
  const seen = new Set<string>();
  for (const r of relations) {
    options.push({
      label: quoteIfNeeded(r.name),
      type: r.kind === "view" ? "interface" : "class",
      detail: r.kind,
    });
    for (const c of r.columns) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      options.push({
        label: quoteIfNeeded(c.name),
        type: "property",
        detail: c.declType.toLowerCase() || undefined,
      });
    }
  }
  return completeFromList(options);
}
