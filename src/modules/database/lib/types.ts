// Mirrors src-tauri/src/modules/db. Integers and reals travel as strings so
// 64-bit values keep their precision.

export type Cell =
  | { t: "null" }
  | { t: "int"; v: string }
  | { t: "real"; v: string }
  | { t: "text"; v: string; len: number; truncated: boolean }
  | { t: "blob"; size: number; hex: string };

export type EditValue =
  | { t: "null" }
  | { t: "int"; v: string }
  | { t: "real"; v: string }
  | { t: "text"; v: string }
  | { t: "blob"; hex: string };

export type ColumnInfo = {
  name: string;
  declType: string;
  notNull: boolean;
  defaultValue: string | null;
  /** 1-based position in the primary key, 0 when not part of it. */
  pk: number;
  generated: boolean;
};

export type IndexInfo = {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
};

export type ForeignKey = {
  from: string;
  table: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
};

export type RelationInfo = {
  name: string;
  kind: "table" | "view" | "virtual" | "shadow" | (string & {});
  withoutRowid: boolean;
  editable: boolean;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKey[];
  sql: string | null;
  rowCount: number | null;
  rowCountCapped: boolean;
  error: string | null;
};

export type Row = { key: EditValue[]; cells: Cell[] };

export type Page = {
  columns: string[];
  rows: Row[];
  total: number | null;
};

export type PageRequest = {
  table: string;
  offset: number;
  limit: number;
  sortColumn?: string | null;
  sortDesc?: boolean;
  filterText?: string | null;
  filterColumn?: string | null;
  withTotal?: boolean;
};

export type ColumnValue = { column: string; value: EditValue };

export type Change =
  | { op: "update"; key: EditValue[]; values: ColumnValue[] }
  | { op: "insert"; values: ColumnValue[] }
  | { op: "delete"; key: EditValue[] };

export type ApplyOutcome =
  | { status: "applied"; count: number }
  | { status: "failed"; index: number; message: string };

export type QueryResult = {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
  changes: number;
  statements: number;
  wrote: boolean;
  elapsedMs: number;
};

export type OpenResult =
  | {
      status: "ready";
      handle: number;
      engine: string;
      readOnly: boolean;
      size: number;
    }
  | { status: "unsupported"; format: string }
  | { status: "not_a_database"; message: string };
