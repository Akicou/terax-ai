import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Cancel01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { type GridColumn, type GridRow, typeTint } from "./DataGrid";
import type { Cell, EditValue } from "./lib/types";
import {
  cellToEdit,
  editText,
  formatBytes,
  parseInput,
  prettyJson,
} from "./lib/values";

type Props = {
  columns: readonly GridColumn[];
  row: GridRow | null;
  rowLabel: string;
  editable: boolean;
  onEdit: (col: number, value: EditValue) => void;
  onClose: () => void;
};

/** Full view of one row: long text, JSON and blobs, each field editable. */
export function RowInspector({
  columns,
  row,
  rowLabel,
  editable,
  onEdit,
  onClose,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 pl-3 pr-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
          Row
        </span>
        <span className="font-mono text-[11px] tabular-nums text-foreground/80">
          {rowLabel}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
        </Button>
      </div>
      {!row ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[11.5px] text-muted-foreground">
          Select a row to see all of its values.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {columns.map((col, i) => (
            <Field
              // Remount on row change so drafts never leak across rows.
              key={`${rowLabel}:${col.name}`}
              column={col}
              cell={row.cells[i] ?? { t: "null" }}
              edited={row.edited?.has(col.name) ?? false}
              editable={editable && col.editable && row.state !== "deleted"}
              onEdit={(v) => onEdit(i, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  column,
  cell,
  edited,
  editable,
  onEdit,
}: {
  column: GridColumn;
  cell: Cell;
  edited: boolean;
  editable: boolean;
  onEdit: (v: EditValue) => void;
}) {
  const full = cellToEdit(cell);
  const [draft, setDraft] = useState<string | null>(null);
  const canEdit = editable && full !== null;

  const commit = () => {
    if (draft === null) return;
    onEdit(parseInput(draft, column.declType));
    setDraft(null);
  };

  return (
    <div
      className={cn(
        "group border-b border-border/40 px-3 py-2.5",
        edited && "bg-amber-400/[0.08]",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {column.pk && (
          <HugeiconsIcon
            icon={Key01Icon}
            size={10}
            strokeWidth={2}
            className="text-amber-500"
          />
        )}
        <span className="min-w-0 truncate text-[11px] font-semibold text-foreground/85">
          {column.name}
        </span>
        {column.declType && (
          <span
            className={cn(
              "font-mono text-[9px] uppercase tracking-wide",
              typeTint(column.declType),
            )}
          >
            {column.declType.toLowerCase()}
          </span>
        )}
        {canEdit && draft === null && (
          <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {cell.t !== "null" && (
              <Button
                variant="ghost"
                size="xs"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => onEdit({ t: "null" })}
              >
                Set NULL
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => setDraft(full ? editText(full) : "")}
            >
              Edit
            </Button>
          </span>
        )}
      </div>
      {draft !== null ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit Edit click.
            autoFocus
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            className="w-full resize-y rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
          />
          <div className="flex items-center justify-end gap-1">
            <span className="mr-auto text-[10px] text-muted-foreground/70">
              ⌘↵ to stage · Esc to cancel
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="h-6 text-[11px]"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button size="xs" className="h-6 text-[11px]" onClick={commit}>
              Stage
            </Button>
          </div>
        </div>
      ) : (
        <FieldValue cell={cell} />
      )}
    </div>
  );
}

function FieldValue({ cell }: { cell: Cell }) {
  switch (cell.t) {
    case "null":
      return (
        <span className="rounded-[4px] bg-muted/70 px-1.5 py-px text-[10px] font-medium italic text-muted-foreground/70">
          NULL
        </span>
      );
    case "int":
    case "real":
      return (
        <div className="select-text font-mono text-[12px] tabular-nums text-foreground">
          {cell.v}
        </div>
      );
    case "text": {
      const json = cell.truncated ? null : prettyJson(cell.v);
      return (
        <div>
          <pre
            className={cn(
              "max-h-72 select-text overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground",
              json && "rounded-md bg-muted/40 p-2 font-mono text-[11px]",
            )}
          >
            {json ?? (cell.v === "" ? <EmptyString /> : cell.v)}
          </pre>
          {cell.truncated && (
            <div className="mt-1 text-[10px] text-muted-foreground/70">
              Showing {formatBytes(cell.v.length)} of {formatBytes(cell.len)}.
              Edit long values with the SQL console.
            </div>
          )}
        </div>
      );
    }
    case "blob":
      return (
        <div className="flex flex-col gap-1">
          <code className="select-text break-all rounded-md bg-muted/40 p-2 font-mono text-[10.5px] leading-relaxed text-foreground/85">
            {cell.hex.replace(/(.{2})/g, "$1 ").trim()}
            {cell.size * 2 > cell.hex.length && " …"}
          </code>
          <span className="text-[10px] text-muted-foreground/70">
            {formatBytes(cell.size)} binary
          </span>
        </div>
      );
  }
}

function EmptyString() {
  return (
    <span className="text-[10.5px] italic text-muted-foreground/60">
      empty string
    </span>
  );
}
