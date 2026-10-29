import { sameValue } from "./values";
import type { Change, EditValue } from "./types";

/** Stable identity of a row: its key values, serialized. */
export type RowId = string;

export function rowIdOf(key: readonly EditValue[]): RowId {
  return JSON.stringify(key);
}

export type PendingUpdate = {
  key: EditValue[];
  /** Column name to new value. A Map, since column names are arbitrary text. */
  values: ReadonlyMap<string, EditValue>;
};

export type PendingInsert = {
  id: string;
  values: ReadonlyMap<string, EditValue>;
};

/** Staged, unsaved changes to one table. Never mutated; every action copies. */
export type Pending = {
  updates: ReadonlyMap<RowId, PendingUpdate>;
  inserts: readonly PendingInsert[];
  deletes: ReadonlyMap<RowId, EditValue[]>;
};

export const EMPTY_PENDING: Pending = {
  updates: new Map(),
  inserts: [],
  deletes: new Map(),
};

export type PendingAction =
  | {
      type: "set";
      key: EditValue[];
      column: string;
      value: EditValue;
      /** The stored value; setting it back drops the edit. */
      original: EditValue | null;
    }
  | { type: "revertCell"; key: EditValue[]; column: string }
  | { type: "revertRow"; key: EditValue[] }
  | { type: "toggleDelete"; key: EditValue[] }
  | { type: "insert"; id: string }
  | { type: "setInsert"; id: string; column: string; value: EditValue }
  | { type: "removeInsert"; id: string }
  | { type: "reset" };

function withUpdate(
  p: Pending,
  id: RowId,
  next: PendingUpdate | null,
): Pending {
  const updates = new Map(p.updates);
  if (next && next.values.size > 0) updates.set(id, next);
  else updates.delete(id);
  return { ...p, updates };
}

export function pendingReducer(p: Pending, a: PendingAction): Pending {
  switch (a.type) {
    case "set": {
      const id = rowIdOf(a.key);
      if (p.deletes.has(id)) return p;
      const prev = p.updates.get(id);
      const values = new Map(prev?.values);
      if (a.original && sameValue(a.original, a.value)) values.delete(a.column);
      else values.set(a.column, a.value);
      return withUpdate(p, id, { key: a.key, values });
    }
    case "revertCell": {
      const id = rowIdOf(a.key);
      const prev = p.updates.get(id);
      if (!prev?.values.has(a.column)) return p;
      const values = new Map(prev.values);
      values.delete(a.column);
      return withUpdate(p, id, { key: prev.key, values });
    }
    case "revertRow": {
      const id = rowIdOf(a.key);
      if (!p.updates.has(id) && !p.deletes.has(id)) return p;
      const deletes = new Map(p.deletes);
      deletes.delete(id);
      return { ...withUpdate(p, id, null), deletes };
    }
    case "toggleDelete": {
      const id = rowIdOf(a.key);
      const deletes = new Map(p.deletes);
      if (deletes.has(id)) {
        deletes.delete(id);
        return { ...p, deletes };
      }
      deletes.set(id, a.key);
      // A deleted row's edits are moot.
      return { ...withUpdate(p, id, null), deletes };
    }
    case "insert":
      return { ...p, inserts: [{ id: a.id, values: new Map() }, ...p.inserts] };
    case "setInsert":
      return {
        ...p,
        inserts: p.inserts.map((r) => {
          if (r.id !== a.id) return r;
          const values = new Map(r.values);
          values.set(a.column, a.value);
          return { ...r, values };
        }),
      };
    case "removeInsert":
      return { ...p, inserts: p.inserts.filter((r) => r.id !== a.id) };
    case "reset":
      return EMPTY_PENDING;
  }
}

export function pendingCount(p: Pending): number {
  let n = p.inserts.length + p.deletes.size;
  for (const u of p.updates.values()) n += u.values.size;
  return n;
}

export type ChangeTarget =
  | { kind: "update"; rowId: RowId }
  | { kind: "insert"; id: string }
  | { kind: "delete"; rowId: RowId };

/** The changes to send, and what each one came from (to point at a failure). */
export function toChanges(p: Pending): {
  changes: Change[];
  targets: ChangeTarget[];
} {
  const changes: Change[] = [];
  const targets: ChangeTarget[] = [];
  const values = (m: ReadonlyMap<string, EditValue>) =>
    [...m].map(([column, value]) => ({ column, value }));
  for (const [rowId, u] of p.updates) {
    changes.push({ op: "update", key: u.key, values: values(u.values) });
    targets.push({ kind: "update", rowId });
  }
  // Inserts are listed newest first; apply them in the order they were added.
  for (const r of [...p.inserts].reverse()) {
    changes.push({ op: "insert", values: values(r.values) });
    targets.push({ kind: "insert", id: r.id });
  }
  for (const [rowId, key] of p.deletes) {
    changes.push({ op: "delete", key });
    targets.push({ kind: "delete", rowId });
  }
  return { changes, targets };
}
