import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Key01Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Cell, EditValue } from "./lib/types";
import {
  affinityOf,
  cellJson,
  cellText,
  cellToEdit,
  editText,
  formatBytes,
  parseInput,
} from "./lib/values";

export type GridColumn = {
  name: string;
  declType: string;
  pk?: boolean;
  fk?: boolean;
  /** False for generated columns and read-only relations. */
  editable: boolean;
};

export type RowState = "normal" | "inserted" | "deleted";

/** One displayed row. `null` while its page is loading. */
export type GridRow = {
  cells: readonly Cell[];
  state: RowState;
  /** Columns with a staged edit. */
  edited?: ReadonlySet<string>;
  /** New-row columns left to the column default. */
  defaults?: ReadonlySet<string>;
  /** Column (or whole row with `"*"`) that failed to save. */
  failed?: string | null;
};

export type GridPos = { row: number; col: number };

export type DataGridHandle = {
  focus: () => void;
  scrollToTop: () => void;
};

type Props = {
  columns: readonly GridColumn[];
  rowCount: number;
  getRow: (index: number) => GridRow | null;
  /** Label in the gutter; defaults to the 1-based index. */
  rowLabel?: (index: number) => string;
  onVisibleRange?: (start: number, end: number) => void;
  selection: GridPos | null;
  onSelect: (pos: GridPos | null) => void;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  /** Absent for read-only grids. */
  onEdit?: (pos: GridPos, value: EditValue) => void;
  onRevertCell?: (pos: GridPos) => void;
  onToggleDelete?: (row: number) => void;
  onInspect?: () => void;
  /** Re-render signal for data held outside props (page cache). */
  version?: unknown;
  /** Widths reset when this changes (e.g. another table). */
  layoutKey?: string;
};

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 30;
const GUTTER = 56;
const MIN_COL = 56;
const MAX_COL = 640;

function initialWidth(col: GridColumn): number {
  const byType: Record<string, number> = {
    integer: 96,
    real: 112,
    numeric: 112,
    text: 200,
    blob: 140,
  };
  const base = col.declType ? byType[affinityOf(col.declType)] : 160;
  const forName = col.name.length * 7.5 + (col.pk || col.fk ? 56 : 40);
  return Math.round(Math.min(320, Math.max(base, forName)));
}

const TYPE_TINT: Record<string, string> = {
  integer: "text-sky-600/80 dark:text-sky-400/80",
  real: "text-violet-600/80 dark:text-violet-400/80",
  numeric: "text-orange-600/80 dark:text-orange-400/80",
  text: "text-emerald-600/80 dark:text-emerald-400/80",
  blob: "text-amber-600/80 dark:text-amber-400/80",
};

export function typeTint(declType: string): string {
  return TYPE_TINT[affinityOf(declType)];
}

function CellContent({ cell }: { cell: Cell }) {
  switch (cell.t) {
    case "null":
      return (
        <span className="rounded-[4px] bg-muted/70 px-1 py-px font-sans text-[9.5px] font-medium italic tracking-wide text-muted-foreground/70">
          NULL
        </span>
      );
    case "int":
    case "real":
      return (
        <span className="block w-full truncate text-right font-mono tabular-nums">
          {cell.v}
        </span>
      );
    case "text": {
      const shown = cell.v.length > 400 ? cell.v.slice(0, 400) : cell.v;
      return (
        <span className="block truncate">
          {shown.replace(/\r?\n/g, " ↵ ")}
          {cell.truncated && (
            <span className="text-muted-foreground/60"> …</span>
          )}
        </span>
      );
    }
    case "blob":
      return (
        <span className="inline-flex items-center gap-1 rounded-[4px] bg-amber-500/10 px-1 py-px font-mono text-[10px] text-amber-700 dark:text-amber-300/90">
          BLOB · {formatBytes(cell.size)}
        </span>
      );
  }
}

function isPrintableKey(e: React.KeyboardEvent): boolean {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
}

export const DataGrid = memo(
  forwardRef<DataGridHandle, Props>(function DataGrid(props, ref) {
    const {
      columns,
      rowCount,
      getRow,
      rowLabel,
      onVisibleRange,
      selection,
      onSelect,
      sort,
      onSort,
      onEdit,
      onRevertCell,
      onToggleDelete,
      onInspect,
      layoutKey,
    } = props;
    const scrollRef = useRef<HTMLDivElement>(null);
    const [widths, setWidths] = useState<Record<string, number>>({});
    const [editing, setEditing] = useState<{
      pos: GridPos;
      text: string;
    } | null>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset per layout.
    useEffect(() => {
      setWidths({});
      setEditing(null);
    }, [layoutKey]);

    const colWidths = useMemo(
      () => columns.map((c) => widths[c.name] ?? initialWidth(c)),
      [columns, widths],
    );
    const colOffsets = useMemo(() => {
      const out: number[] = [];
      let x = GUTTER;
      for (const w of colWidths) {
        out.push(x);
        x += w;
      }
      return out;
    }, [colWidths]);
    const totalWidth = GUTTER + colWidths.reduce((a, b) => a + b, 0);

    const virtualizer = useVirtualizer({
      count: rowCount,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 12,
      // Rows start below the sticky header, and scrolling to a row keeps it
      // clear of the header.
      paddingStart: HEADER_HEIGHT,
      scrollPaddingStart: HEADER_HEIGHT,
    });
    const items = virtualizer.getVirtualItems();
    const firstIndex = items[0]?.index ?? 0;
    const lastIndex = items[items.length - 1]?.index ?? 0;

    useEffect(() => {
      if (rowCount > 0) onVisibleRange?.(firstIndex, lastIndex);
    }, [firstIndex, lastIndex, rowCount, onVisibleRange]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => scrollRef.current?.focus({ preventScroll: true }),
        scrollToTop: () => {
          scrollRef.current?.scrollTo({ top: 0 });
        },
      }),
      [],
    );

    const reveal = useCallback(
      (pos: GridPos) => {
        virtualizer.scrollToIndex(pos.row, { align: "auto" });
        const el = scrollRef.current;
        if (!el) return;
        const left = colOffsets[pos.col] - GUTTER;
        const right = colOffsets[pos.col] + colWidths[pos.col];
        if (left < el.scrollLeft) el.scrollLeft = left;
        else if (right > el.scrollLeft + el.clientWidth)
          el.scrollLeft = right - el.clientWidth;
      },
      [virtualizer, colOffsets, colWidths],
    );

    const canEdit = useCallback(
      (pos: GridPos) => {
        if (!onEdit || !columns[pos.col]?.editable) return false;
        const row = getRow(pos.row);
        const cell = row?.cells[pos.col];
        // Truncated text and long blobs only hold a preview.
        return !!cell && row?.state !== "deleted" && cellToEdit(cell) !== null;
      },
      [onEdit, getRow, columns],
    );

    const startEdit = useCallback(
      (pos: GridPos, initial?: string) => {
        if (!canEdit(pos)) return;
        const cell = getRow(pos.row)?.cells[pos.col];
        const value = cell ? cellToEdit(cell) : null;
        setEditing({ pos, text: initial ?? (value ? editText(value) : "") });
      },
      [canEdit, getRow],
    );

    const commitEdit = useCallback(
      (move?: "down" | "right" | "left") => {
        if (!editing) return;
        const { pos, text } = editing;
        setEditing(null);
        onEdit?.(pos, parseInput(text, columns[pos.col]?.declType ?? ""));
        if (move) {
          const next =
            move === "down"
              ? { row: Math.min(rowCount - 1, pos.row + 1), col: pos.col }
              : move === "right"
                ? {
                    row: pos.row,
                    col: Math.min(columns.length - 1, pos.col + 1),
                  }
                : { row: pos.row, col: Math.max(0, pos.col - 1) };
          onSelect(next);
          reveal(next);
        }
        scrollRef.current?.focus({ preventScroll: true });
      },
      [editing, onEdit, columns, rowCount, onSelect, reveal],
    );

    const cancelEdit = useCallback(() => {
      setEditing(null);
      scrollRef.current?.focus({ preventScroll: true });
    }, []);

    const copy = useCallback(
      (what: "cell" | "row") => {
        if (!selection) return;
        const row = getRow(selection.row);
        if (!row) return;
        const text =
          what === "cell"
            ? cellText(row.cells[selection.col] ?? { t: "null" })
            : JSON.stringify(
                Object.fromEntries(
                  columns.map((c, i) => [c.name, cellJson(row.cells[i])]),
                ),
                null,
                2,
              );
        void navigator.clipboard.writeText(text);
      },
      [selection, getRow, columns],
    );

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (editing || e.target !== e.currentTarget) return;
      if (rowCount === 0 || columns.length === 0) return;
      const mod = e.metaKey || e.ctrlKey;
      const pos = selection ?? { row: 0, col: 0 };
      const pageRows = Math.max(
        1,
        Math.floor(
          ((scrollRef.current?.clientHeight ?? 0) - HEADER_HEIGHT) / ROW_HEIGHT,
        ) - 1,
      );
      let next: GridPos | null = null;
      switch (e.key) {
        case "ArrowDown":
          next = {
            ...pos,
            row: mod ? rowCount - 1 : Math.min(rowCount - 1, pos.row + 1),
          };
          break;
        case "ArrowUp":
          next = { ...pos, row: mod ? 0 : Math.max(0, pos.row - 1) };
          break;
        case "ArrowRight":
          next = {
            ...pos,
            col: mod
              ? columns.length - 1
              : Math.min(columns.length - 1, pos.col + 1),
          };
          break;
        case "ArrowLeft":
          next = { ...pos, col: mod ? 0 : Math.max(0, pos.col - 1) };
          break;
        case "Tab":
          next = {
            ...pos,
            col: e.shiftKey
              ? Math.max(0, pos.col - 1)
              : Math.min(columns.length - 1, pos.col + 1),
          };
          break;
        case "PageDown":
          next = { ...pos, row: Math.min(rowCount - 1, pos.row + pageRows) };
          break;
        case "PageUp":
          next = { ...pos, row: Math.max(0, pos.row - pageRows) };
          break;
        case "Home":
          next = mod ? { row: 0, col: 0 } : { ...pos, col: 0 };
          break;
        case "End":
          next = mod
            ? { row: rowCount - 1, col: columns.length - 1 }
            : { ...pos, col: columns.length - 1 };
          break;
        case "Enter":
        case "F2":
          if (selection) {
            e.preventDefault();
            startEdit(selection);
          }
          return;
        case "Escape":
          if (selection) {
            e.preventDefault();
            e.stopPropagation();
            onSelect(null);
          }
          return;
        case "Delete":
          if (selection && onToggleDelete) {
            e.preventDefault();
            onToggleDelete(selection.row);
          }
          return;
        case " ":
          if (onInspect) {
            e.preventDefault();
            onInspect();
          }
          return;
        default:
          if (mod && e.key.toLowerCase() === "c" && selection) {
            e.preventDefault();
            copy(e.shiftKey ? "row" : "cell");
            return;
          }
          if (selection && isPrintableKey(e) && canEdit(selection)) {
            e.preventDefault();
            startEdit(selection, e.key);
          }
          return;
      }
      e.preventDefault();
      onSelect(next);
      reveal(next);
    };

    const posFromEvent = (e: React.MouseEvent): GridPos | null => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
      if (!el) return null;
      return { row: Number(el.dataset.row), col: Number(el.dataset.col) };
    };

    const resizeColumn =
      (col: GridColumn, start: number) =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => {
          const w = Math.min(
            MAX_COL,
            Math.max(MIN_COL, start + ev.clientX - x0),
          );
          setWidths((prev) => ({ ...prev, [col.name]: Math.round(w) }));
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      };

    const selectedRow = selection ? getRow(selection.row) : null;
    const selectedEdited =
      selection && selectedRow?.edited?.has(columns[selection.col]?.name ?? "");

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: a virtualized grid cannot be a <table>. */}
          <div
            ref={scrollRef}
            role="grid"
            tabIndex={0}
            aria-label="Table rows"
            aria-rowcount={rowCount}
            aria-colcount={columns.length}
            onKeyDown={onKeyDown}
            onMouseDown={(e) => {
              const pos = posFromEvent(e);
              if (
                pos &&
                !(
                  editing &&
                  editing.pos.row === pos.row &&
                  editing.pos.col === pos.col
                )
              ) {
                if (editing) commitEdit();
                onSelect(pos);
              }
            }}
            onDoubleClick={(e) => {
              const pos = posFromEvent(e);
              if (pos) startEdit(pos);
            }}
            onContextMenu={(e) => {
              const pos = posFromEvent(e);
              if (pos) onSelect(pos);
            }}
            className="terax-data-grid relative h-full min-h-0 w-full overflow-auto text-[12px] outline-none"
          >
            <div
              style={{
                width: totalWidth,
                height: virtualizer.getTotalSize(),
              }}
              className="relative"
            >
              {/* Header */}
              <div
                className="sticky top-0 z-20 flex border-b border-border/70 bg-card"
                style={{ height: HEADER_HEIGHT, width: totalWidth }}
              >
                <div
                  className="sticky left-0 z-10 shrink-0 border-r border-border/50 bg-card"
                  style={{ width: GUTTER }}
                />
                {columns.map((col, i) => {
                  const sorted = sort?.column === col.name ? sort : null;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: sorting is a pointer shortcut; the grid is keyboard-driven.
                    // biome-ignore lint/a11y/noStaticElementInteractions: see above.
                    <div
                      key={col.name}
                      className={cn(
                        "group/h relative flex shrink-0 items-center gap-1.5 border-r border-border/40 px-2 select-none",
                        onSort && "cursor-pointer hover:bg-muted/50",
                      )}
                      style={{ width: colWidths[i] }}
                      onClick={() => onSort?.(col.name)}
                      title={`${col.name}${col.declType ? ` · ${col.declType}` : ""}`}
                    >
                      {col.pk && (
                        <HugeiconsIcon
                          icon={Key01Icon}
                          size={11}
                          strokeWidth={2}
                          className="shrink-0 text-amber-500"
                        />
                      )}
                      {col.fk && !col.pk && (
                        <HugeiconsIcon
                          icon={Link01Icon}
                          size={11}
                          strokeWidth={2}
                          className="shrink-0 text-sky-500"
                        />
                      )}
                      <span className="min-w-0 truncate text-[11.5px] font-semibold text-foreground/90">
                        {col.name}
                      </span>
                      {col.declType && (
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[9px] uppercase tracking-wide",
                            typeTint(col.declType),
                          )}
                        >
                          {col.declType
                            .toLowerCase()
                            .replace(/\s+/g, " ")
                            .slice(0, 14)}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {sorted && (
                          <HugeiconsIcon
                            icon={sorted.desc ? ArrowDown01Icon : ArrowUp01Icon}
                            size={12}
                            strokeWidth={2.2}
                          />
                        )}
                      </span>
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: column resize grip. */}
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: column resize grip. */}
                      <div
                        onPointerDown={resizeColumn(col, colWidths[i])}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setWidths((prev) => {
                            const next = { ...prev };
                            delete next[col.name];
                            return next;
                          });
                        }}
                        className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize after:absolute after:inset-y-1.5 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-ring/60"
                      />
                    </div>
                  );
                })}
              </div>

              {items.map((item) => {
                const row = getRow(item.index);
                const rowSelected = selection?.row === item.index;
                return (
                  <div
                    key={item.key}
                    className={cn(
                      "absolute left-0 flex border-b border-border/30",
                      !row && "text-muted-foreground/40",
                      row?.state === "inserted" && "bg-emerald-500/[0.07]",
                      row?.state === "deleted" &&
                        "bg-rose-500/[0.07] text-muted-foreground line-through decoration-rose-500/60",
                      row?.failed === "*" && "bg-destructive/10",
                      rowSelected ? "bg-primary/[0.06]" : "hover:bg-muted/40",
                    )}
                    style={{
                      top: item.start,
                      height: ROW_HEIGHT,
                      width: totalWidth,
                    }}
                  >
                    <div
                      className={cn(
                        "sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border/50 bg-background pr-2 font-mono text-[10px] tabular-nums text-muted-foreground/55",
                        rowSelected && "text-foreground/80",
                      )}
                      style={{ width: GUTTER }}
                    >
                      {row?.state === "inserted" ? (
                        <span className="font-sans text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                          NEW
                        </span>
                      ) : (
                        (rowLabel?.(item.index) ?? item.index + 1)
                      )}
                    </div>
                    {columns.map((col, c) => {
                      const cell = row?.cells[c];
                      const selected = rowSelected && selection?.col === c;
                      const isEditing =
                        editing?.pos.row === item.index &&
                        editing.pos.col === c;
                      const edited = row?.edited?.has(col.name);
                      return (
                        <div
                          key={col.name}
                          data-cell=""
                          data-row={item.index}
                          data-col={c}
                          className={cn(
                            "relative flex shrink-0 items-center overflow-hidden border-r border-border/25 px-2",
                            edited && "bg-amber-400/[0.14]",
                            row?.failed === col.name && "bg-destructive/15",
                            selected &&
                              "z-[1] bg-primary/10 shadow-[inset_0_0_0_1.5px_var(--ring)]",
                          )}
                          style={{ width: colWidths[c] }}
                        >
                          {isEditing ? (
                            <CellEditor
                              text={editing.text}
                              numeric={["integer", "real", "numeric"].includes(
                                affinityOf(col.declType),
                              )}
                              onChange={(text) =>
                                setEditing((s) => (s ? { ...s, text } : s))
                              }
                              onCommit={commitEdit}
                              onCancel={cancelEdit}
                            />
                          ) : row?.defaults?.has(col.name) ? (
                            <span className="rounded-[4px] border border-dashed border-emerald-500/40 px-1 font-sans text-[9.5px] font-medium tracking-wide text-emerald-700/80 dark:text-emerald-300/70">
                              DEFAULT
                            </span>
                          ) : cell ? (
                            <CellContent cell={cell} />
                          ) : (
                            <span className="h-2 w-2/3 rounded-full bg-muted/60" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem
            disabled={!selectedRow}
            onSelect={() => copy("cell")}
          >
            Copy value
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!selectedRow} onSelect={() => copy("row")}>
            Copy row as JSON
            <ContextMenuShortcut>⇧⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          {onInspect && (
            <ContextMenuItem onSelect={onInspect}>
              Inspect row
              <ContextMenuShortcut>Space</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          {onEdit && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!selection || !canEdit(selection)}
                onSelect={() => selection && startEdit(selection)}
              >
                Edit cell
                <ContextMenuShortcut>↵</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!selection || !canEdit(selection)}
                onSelect={() => selection && onEdit(selection, { t: "null" })}
              >
                Set to NULL
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!selectedEdited}
                onSelect={() => selection && onRevertCell?.(selection)}
              >
                Revert cell
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={!selectedRow}
                onSelect={() => selection && onToggleDelete?.(selection.row)}
              >
                {selectedRow?.state === "deleted"
                  ? "Restore row"
                  : selectedRow?.state === "inserted"
                    ? "Discard new row"
                    : "Delete row"}
                <ContextMenuShortcut>Del</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }),
);

function CellEditor({
  text,
  numeric,
  onChange,
  onCommit,
  onCancel,
}: {
  text: string;
  numeric: boolean;
  onChange: (text: string) => void;
  onCommit: (move?: "down" | "right" | "left") => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Blur also fires after Enter/Escape unmount the input; act only once.
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  return (
    <input
      ref={inputRef}
      value={text}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => finish(() => onCommit())}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(() => onCommit("down"));
        } else if (e.key === "Tab") {
          e.preventDefault();
          finish(() => onCommit(e.shiftKey ? "left" : "right"));
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(onCancel);
        }
      }}
      className={cn(
        "absolute inset-0 h-full w-full bg-background px-2 text-[12px] text-foreground outline-none ring-2 ring-inset ring-ring",
        numeric && "text-right font-mono tabular-nums",
      )}
    />
  );
}
