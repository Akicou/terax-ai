import { describe, expect, it } from "vitest";
import {
  EMPTY_PENDING,
  type Pending,
  type PendingAction,
  pendingCount,
  pendingReducer,
  rowIdOf,
  toChanges,
} from "./pendingEdits";
import type { EditValue } from "./types";

const k1: EditValue[] = [{ t: "int", v: "1" }];
const k2: EditValue[] = [{ t: "int", v: "2" }];
const text = (v: string): EditValue => ({ t: "text", v });

function run(...actions: PendingAction[]): Pending {
  return actions.reduce(pendingReducer, EMPTY_PENDING);
}

describe("pendingReducer", () => {
  it("stages cell edits and drops edits back to the original", () => {
    let p = run(
      {
        type: "set",
        key: k1,
        column: "name",
        value: text("b"),
        original: text("a"),
      },
      { type: "set", key: k1, column: "age", value: text("3"), original: null },
    );
    expect(pendingCount(p)).toBe(2);
    p = pendingReducer(p, {
      type: "set",
      key: k1,
      column: "name",
      value: text("a"),
      original: text("a"),
    });
    expect(pendingCount(p)).toBe(1);
    p = pendingReducer(p, { type: "revertCell", key: k1, column: "age" });
    expect(p.updates.size).toBe(0);
  });

  it("handles column names that look like object internals", () => {
    const p = run({
      type: "set",
      key: k1,
      column: "__proto__",
      value: text("x"),
      original: text("y"),
    });
    expect(p.updates.get(rowIdOf(k1))?.values.get("__proto__")).toEqual(
      text("x"),
    );
  });

  it("deleting a row discards its edits and blocks new ones", () => {
    let p = run(
      {
        type: "set",
        key: k1,
        column: "name",
        value: text("b"),
        original: text("a"),
      },
      { type: "toggleDelete", key: k1 },
    );
    expect(p.updates.size).toBe(0);
    expect(pendingCount(p)).toBe(1);
    p = pendingReducer(p, {
      type: "set",
      key: k1,
      column: "name",
      value: text("c"),
      original: text("a"),
    });
    expect(p.updates.size).toBe(0);
    p = pendingReducer(p, { type: "toggleDelete", key: k1 });
    expect(pendingCount(p)).toBe(0);
  });

  it("stages inserts newest first and applies them oldest first", () => {
    const p = run(
      { type: "insert", id: "a" },
      { type: "insert", id: "b" },
      { type: "setInsert", id: "a", column: "name", value: text("first") },
      { type: "removeInsert", id: "missing" },
    );
    expect(p.inserts.map((r) => r.id)).toEqual(["b", "a"]);
    const { changes, targets } = toChanges(p);
    expect(targets).toEqual([
      { kind: "insert", id: "a" },
      { kind: "insert", id: "b" },
    ]);
    expect(changes[0]).toEqual({
      op: "insert",
      values: [{ column: "name", value: text("first") }],
    });
    expect(changes[1]).toEqual({ op: "insert", values: [] });
  });

  it("orders changes updates, inserts, deletes", () => {
    const p = run(
      { type: "toggleDelete", key: k2 },
      { type: "insert", id: "n" },
      {
        type: "set",
        key: k1,
        column: "x",
        value: { t: "null" },
        original: text("a"),
      },
    );
    expect(toChanges(p).changes.map((c) => c.op)).toEqual([
      "update",
      "insert",
      "delete",
    ]);
    expect(pendingReducer(p, { type: "reset" })).toBe(EMPTY_PENDING);
  });

  it("reverts a whole row", () => {
    const p = run(
      { type: "set", key: k1, column: "x", value: text("1"), original: null },
      { type: "revertRow", key: k1 },
    );
    expect(pendingCount(p)).toBe(0);
  });
});
