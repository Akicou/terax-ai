import { describe, expect, it } from "vitest";
import {
  affinityOf,
  cellJson,
  cellToEdit,
  parseInput,
  prettyJson,
  sameValue,
} from "./values";

describe("affinityOf", () => {
  it("follows SQLite's rules in order", () => {
    expect(affinityOf("INTEGER")).toBe("integer");
    expect(affinityOf("BIGINT UNSIGNED")).toBe("integer");
    expect(affinityOf("VARCHAR(20)")).toBe("text");
    expect(affinityOf("CHARINT")).toBe("integer"); // INT wins over CHAR
    expect(affinityOf("")).toBe("blob");
    expect(affinityOf("BLOB")).toBe("blob");
    expect(affinityOf("DOUBLE PRECISION")).toBe("real");
    expect(affinityOf("DECIMAL(10,2)")).toBe("numeric");
    expect(affinityOf("BOOLEAN")).toBe("numeric");
  });
});

describe("parseInput", () => {
  it("parses numbers for numeric affinities", () => {
    expect(parseInput("42", "INTEGER")).toEqual({ t: "int", v: "42" });
    expect(parseInput(" -7 ", "NUMERIC")).toEqual({ t: "int", v: "-7" });
    expect(parseInput("1.5", "INTEGER")).toEqual({ t: "real", v: "1.5" });
    expect(parseInput("2", "REAL")).toEqual({ t: "real", v: "2" });
    expect(parseInput("1e3", "")).toEqual({ t: "real", v: "1e3" });
  });

  it("keeps 64-bit integers exact and overflows to real", () => {
    expect(parseInput("9223372036854775807", "INT")).toEqual({
      t: "int",
      v: "9223372036854775807",
    });
    expect(parseInput("9223372036854775808", "INT")).toEqual({
      t: "real",
      v: "9223372036854775808",
    });
  });

  it("keeps text as typed", () => {
    expect(parseInput("42", "TEXT")).toEqual({ t: "text", v: "42" });
    expect(parseInput("abc", "INTEGER")).toEqual({ t: "text", v: "abc" });
    expect(parseInput("", "INTEGER")).toEqual({ t: "text", v: "" });
    expect(parseInput(" padded ", "TEXT")).toEqual({
      t: "text",
      v: " padded ",
    });
  });

  it("reads blob literals in any column", () => {
    expect(parseInput("x'DEAD beef'", "TEXT")).toEqual({
      t: "blob",
      hex: "deadbeef",
    });
    expect(parseInput("x'abc'", "BLOB")).toEqual({ t: "text", v: "x'abc'" });
  });
});

describe("cellToEdit", () => {
  it("refuses previews", () => {
    expect(
      cellToEdit({ t: "text", v: "abc", len: 100_000, truncated: true }),
    ).toBeNull();
    expect(cellToEdit({ t: "blob", size: 100, hex: "00ff" })).toBeNull();
    expect(cellToEdit({ t: "blob", size: 2, hex: "00ff" })).toEqual({
      t: "blob",
      hex: "00ff",
    });
    expect(cellToEdit({ t: "int", v: "1" })).toEqual({ t: "int", v: "1" });
  });
});

describe("helpers", () => {
  it("compares values by type and content", () => {
    expect(sameValue({ t: "int", v: "1" }, { t: "int", v: "1" })).toBe(true);
    expect(sameValue({ t: "int", v: "1" }, { t: "text", v: "1" })).toBe(false);
    expect(sameValue({ t: "null" }, { t: "null" })).toBe(true);
  });

  it("converts cells to JSON without losing precision", () => {
    expect(cellJson({ t: "int", v: "12" })).toBe(12);
    expect(cellJson({ t: "int", v: "9223372036854775807" })).toBe(
      "9223372036854775807",
    );
    expect(cellJson({ t: "null" })).toBeNull();
  });

  it("pretty-prints JSON objects only", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("42")).toBeNull();
    expect(prettyJson("{nope")).toBeNull();
  });
});
