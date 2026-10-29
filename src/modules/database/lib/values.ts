import type { Cell, EditValue } from "./types";

export type Affinity = "integer" | "real" | "numeric" | "text" | "blob";

/** SQLite's column affinity rules (datatype3.html §3.1), in order. */
export function affinityOf(declType: string): Affinity {
  const t = declType.toUpperCase();
  if (t.includes("INT")) return "integer";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT"))
    return "text";
  if (t.includes("BLOB") || t.trim() === "") return "blob";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB"))
    return "real";
  return "numeric";
}

const INT_RE = /^[+-]?\d+$/;
const REAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const BLOB_RE = /^x'([0-9a-f\s]*)'$/i;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function asNumber(text: string): { t: "int" | "real"; v: string } | null {
  const s = text.trim();
  if (INT_RE.test(s)) {
    const n = BigInt(s);
    if (n >= I64_MIN && n <= I64_MAX) return { t: "int", v: n.toString() };
    return { t: "real", v: s };
  }
  if (REAL_RE.test(s)) return { t: "real", v: s };
  return null;
}

/**
 * Turns typed input into a value the way the column would store it. `x'..'`
 * is a blob literal in any column. NULL is never inferred from text: an empty
 * input is an empty string, NULL is an explicit action.
 */
export function parseInput(text: string, declType: string): EditValue {
  const blob = BLOB_RE.exec(text.trim());
  if (blob) {
    const hex = blob[1].replace(/\s+/g, "");
    if (hex.length % 2 === 0) return { t: "blob", hex: hex.toLowerCase() };
  }
  switch (affinityOf(declType)) {
    case "text":
      return { t: "text", v: text };
    case "real": {
      const n = asNumber(text);
      return n ? { t: "real", v: n.v } : { t: "text", v: text };
    }
    default:
      return asNumber(text) ?? { t: "text", v: text };
  }
}

/** The full value of a cell, or null when the cell only holds a preview. */
export function cellToEdit(cell: Cell): EditValue | null {
  switch (cell.t) {
    case "null":
      return { t: "null" };
    case "int":
    case "real":
      return { t: cell.t, v: cell.v };
    case "text":
      return cell.truncated ? null : { t: "text", v: cell.v };
    case "blob":
      return cell.size * 2 === cell.hex.length
        ? { t: "blob", hex: cell.hex }
        : null;
  }
}

export function editToCell(value: EditValue): Cell {
  switch (value.t) {
    case "null":
      return { t: "null" };
    case "int":
    case "real":
      return { t: value.t, v: value.v };
    case "text":
      return { t: "text", v: value.v, len: value.v.length, truncated: false };
    case "blob":
      return { t: "blob", size: value.hex.length / 2, hex: value.hex };
  }
}

export function sameValue(a: EditValue, b: EditValue): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "null") return true;
  if (a.t === "blob") return a.hex === (b as { hex: string }).hex;
  return a.v === (b as { v: string }).v;
}

/** Text placed in the inline editor for a value. */
export function editText(value: EditValue): string {
  switch (value.t) {
    case "null":
      return "";
    case "blob":
      return `x'${value.hex}'`;
    default:
      return value.v;
  }
}

/** Plain text for clipboard copies. */
export function cellText(cell: Cell): string {
  switch (cell.t) {
    case "null":
      return "NULL";
    case "blob":
      return `x'${cell.hex}'`;
    default:
      return cell.v;
  }
}

export function cellJson(cell: Cell): unknown {
  switch (cell.t) {
    case "null":
      return null;
    case "int": {
      const n = Number(cell.v);
      return Number.isSafeInteger(n) ? n : cell.v;
    }
    case "real": {
      const n = Number(cell.v);
      return Number.isFinite(n) ? n : cell.v;
    }
    case "text":
      return cell.v;
    case "blob":
      return `x'${cell.hex}'`;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Pretty JSON when the text is a JSON object or array, else null. */
export function prettyJson(text: string): string | null {
  const s = text.trim();
  if (!(s.startsWith("{") || s.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}
