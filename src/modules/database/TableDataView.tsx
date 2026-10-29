import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  Search01Icon,
  SidebarRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DataGrid,
  type DataGridHandle,
  type GridColumn,
  type GridPos,
  type GridRow,
} from "./DataGrid";
import { RowInspector } from "./RowInspector";
import {
  type ChangeTarget,
  type Pending,
  type PendingAction,
  rowIdOf,
} from "./lib/pendingEdits";
import type { Cell, EditValue, RelationInfo, Row } from "./lib/types";
import { useTablePages } from "./lib/useTablePages";
import { cellToEdit, editToCell, formatCount } from "./lib/values";

export type SaveFailure = {
  table: string;
  target: ChangeTarget;
  message: string;
};

export type TableDataViewHandle = {
  focusGrid: () => void;
  focusFilter: () => void;
};

type Props = {
  handle: number;
  relation: RelationInfo;
  /** The whole database is read-only. */
  readOnly: boolean;
  pending: Pending;
  dispatch: (action: PendingAction) => void;
  failure: SaveFailure | null;
  reloadToken: number;
};

const NULL_CELL: Cell = { t: "null" };
let insertSeq = 0;

export const TableDataView = forwardRef<TableDataViewHandle, Props>(
  function TableDataView(
    { handle, relation, readOnly, pending, dispatch, failure, reloadToken },
    ref,
  ) {
    const gridRef = useRef<DataGridHandle>(null);
    const filterRef = useRef<HTMLInputElement>(null);
    const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(
      null,
    );
    const [filterInput, setFilterInput] = useState("");
    const [filterText, setFilterText] = useState("");
    const [filterColumn, setFilterColumn] = useState<string | null>(null);
    const [selection, setSelection] = useState<GridPos | null>(null);
    const [inspector, setInspector] = useState(false);

    useImperativeHandle(ref, () => ({
      focusGrid: () => gridRef.current?.focus(),
      focusFilter: () => filterRef.current?.focus(),
    }));

    useEffect(() => {
      const t = setTimeout(() => setFilterText(filterInput.trim()), 220);
      return () => clearTimeout(t);
    }, [filterInput]);

    // A different query starts at the top.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change.
    useEffect(() => {
      setSelection(null);
      gridRef.current?.scrollToTop();
    }, [sort, filterText, filterColumn]);

    const editable = relation.editable && !readOnly;
    const fkColumns = useMemo(
      () => new Set(relation.foreignKeys.map((f) => f.from)),
      [relation.foreignKeys],
    );
    const columns: GridColumn[] = useMemo(
      () =>
        relation.columns.map((c) => ({
          name: c.name,
          declType: c.declType,
          pk: c.pk > 0,
          fk: fkColumns.has(c.name),
          editable: editable && !c.generated,
        })),
      [relation.columns, fkColumns, editable],
    );

    const query = useMemo(
      () => ({
        table: relation.name,
        sortColumn: sort?.column ?? null,
        sortDesc: sort?.desc ?? false,
        filterText,
        filterColumn,
      }),
      [relation.name, sort, filterText, filterColumn],
    );
    const pages = useTablePages(handle, query, reloadToken);
    const total = pages.total ?? 0;
    const inserts = pending.inserts;
    const rowCount = inserts.length + total;

    const failedRowId =
      failure?.table === relation.name ? failure.target : null;

    const getRow = useCallback(
      (index: number): GridRow | null => {
        if (index < inserts.length) {
          const ins = inserts[index];
          const defaults = new Set<string>();
          const cells = relation.columns.map((c) => {
            const v = ins.values.get(c.name);
            if (!v) defaults.add(c.name);
            return v ? editToCell(v) : NULL_CELL;
          });
          return {
            cells,
            state: "inserted",
            defaults,
            failed:
              failedRowId?.kind === "insert" && failedRowId.id === ins.id
                ? "*"
                : null,
          };
        }
        const row = pages.getRow(index - inserts.length);
        if (!row) return null;
        const id = rowIdOf(row.key);
        const update = pending.updates.get(id);
        const failed =
          failedRowId &&
          failedRowId.kind !== "insert" &&
          failedRowId.rowId === id
            ? "*"
            : null;
        if (pending.deletes.has(id)) {
          return { cells: row.cells, state: "deleted", failed };
        }
        if (!update) return { cells: row.cells, state: "normal", failed };
        const cells = relation.columns.map((c, i) => {
          const v = update.values.get(c.name);
          return v ? editToCell(v) : row.cells[i];
        });
        return {
          cells,
          state: "normal",
          edited: new Set(update.values.keys()),
          failed,
        };
      },
      [inserts, pages.getRow, pending, relation.columns, failedRowId],
    );

    const rawRow = useCallback(
      (index: number): Row | null =>
        index < inserts.length
          ? null
          : (pages.getRow(index - inserts.length) ?? null),
      [inserts.length, pages.getRow],
    );

    const onEdit = useCallback(
      (pos: GridPos, value: EditValue) => {
        const column = relation.columns[pos.col]?.name;
        if (column === undefined) return;
        if (pos.row < inserts.length) {
          dispatch({
            type: "setInsert",
            id: inserts[pos.row].id,
            column,
            value,
          });
          return;
        }
        const row = rawRow(pos.row);
        if (!row) return;
        dispatch({
          type: "set",
          key: row.key,
          column,
          value,
          original: cellToEdit(row.cells[pos.col]),
        });
      },
      [relation.columns, inserts, rawRow, dispatch],
    );

    const onRevertCell = useCallback(
      (pos: GridPos) => {
        const row = rawRow(pos.row);
        const column = relation.columns[pos.col]?.name;
        if (row && column !== undefined)
          dispatch({ type: "revertCell", key: row.key, column });
      },
      [rawRow, relation.columns, dispatch],
    );

    const onToggleDelete = useCallback(
      (index: number) => {
        if (!editable) return;
        if (index < inserts.length) {
          dispatch({ type: "removeInsert", id: inserts[index].id });
          return;
        }
        const row = rawRow(index);
        if (row) dispatch({ type: "toggleDelete", key: row.key });
      },
      [editable, inserts, rawRow, dispatch],
    );

    const onSort = useCallback((column: string) => {
      setSort((s) =>
        s?.column !== column
          ? { column, desc: false }
          : !s.desc
            ? { column, desc: true }
            : null,
      );
    }, []);

    const addRow = () => {
      dispatch({ type: "insert", id: `new-${++insertSeq}` });
      gridRef.current?.scrollToTop();
      setSelection({ row: 0, col: Math.max(0, firstEditableCol(columns)) });
      gridRef.current?.focus();
    };

    const toggleInspector = useCallback(() => setInspector((v) => !v), []);

    const selectedRow = selection ? getRow(selection.row) : null;
    const rowLabel = useCallback(
      (index: number) =>
        index < inserts.length ? "new" : String(index - inserts.length + 1),
      [inserts.length],
    );
    const { ensureRange } = pages;
    const onVisibleRange = useCallback(
      (start: number, end: number) =>
        ensureRange(
          Math.max(0, start - inserts.length),
          Math.max(0, end - inserts.length),
        ),
      [ensureRange, inserts.length],
    );
    const filtered = filterText !== "";

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-foreground">
              {relation.name}
            </span>
            {relation.kind !== "table" && (
              <span className="rounded-[4px] bg-muted px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                {relation.kind}
              </span>
            )}
            {relation.withoutRowid && (
              <span className="rounded-[4px] bg-muted px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                without rowid
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <div className="flex h-7 w-60 items-center rounded-lg border border-border/70 bg-muted/30 pl-2 transition-colors focus-within:border-ring focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/20">
              <HugeiconsIcon
                icon={Search01Icon}
                size={12}
                strokeWidth={2}
                className="shrink-0 text-muted-foreground/70"
              />
              <input
                ref={filterRef}
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    if (filterInput) setFilterInput("");
                    else gridRef.current?.focus();
                  } else if (e.key === "ArrowDown" || e.key === "Enter") {
                    e.preventDefault();
                    gridRef.current?.focus();
                  }
                }}
                placeholder="Filter rows…"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
              {filterInput && (
                <button
                  type="button"
                  onClick={() => setFilterInput("")}
                  className="mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Clear filter"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    size={11}
                    strokeWidth={2}
                  />
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-full max-w-28 shrink-0 items-center gap-1 rounded-r-lg border-l border-border/60 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <span className="truncate">{filterColumn ?? "All"}</span>
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="max-h-80 w-52 overflow-y-auto"
                >
                  <DropdownMenuLabel className="text-[11px]">
                    Search in
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filterColumn ?? ""}
                    onValueChange={(v) => setFilterColumn(v === "" ? null : v)}
                  >
                    <DropdownMenuRadioItem value="" className="text-[12px]">
                      All columns
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    {relation.columns.map((c) => (
                      <DropdownMenuRadioItem
                        key={c.name}
                        value={c.name}
                        className="text-[12px]"
                      >
                        <span className="truncate">{c.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {editable && (
              <>
                <ToolbarButton label="Add row" onClick={addRow}>
                  <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
                </ToolbarButton>
                <ToolbarButton
                  label={
                    selectedRow?.state === "deleted"
                      ? "Restore row (Del)"
                      : "Delete row (Del)"
                  }
                  disabled={!selectedRow}
                  onClick={() => selection && onToggleDelete(selection.row)}
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={14}
                    strokeWidth={2}
                  />
                </ToolbarButton>
              </>
            )}
            <ToolbarButton
              label="Row inspector (Space)"
              active={inspector}
              onClick={toggleInspector}
            >
              <HugeiconsIcon
                icon={SidebarRight01Icon}
                size={14}
                strokeWidth={2}
              />
            </ToolbarButton>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            {pages.error ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
                <div className="text-[13px] font-medium text-destructive">
                  Couldn't read {relation.name}
                </div>
                <div className="max-w-md font-mono text-[11px] text-muted-foreground">
                  {pages.error}
                </div>
              </div>
            ) : (
              <>
                <DataGrid
                  ref={gridRef}
                  columns={columns}
                  rowCount={rowCount}
                  getRow={getRow}
                  rowLabel={rowLabel}
                  onVisibleRange={onVisibleRange}
                  selection={selection}
                  onSelect={setSelection}
                  sort={sort}
                  onSort={onSort}
                  onEdit={editable ? onEdit : undefined}
                  onRevertCell={onRevertCell}
                  onToggleDelete={editable ? onToggleDelete : undefined}
                  onInspect={toggleInspector}
                  layoutKey={relation.name}
                />
                {!pages.loading && rowCount === 0 && (
                  <div className="pointer-events-none absolute inset-x-0 top-[30px] bottom-0 flex flex-col items-center justify-center gap-1 text-center">
                    <div className="text-[12.5px] font-medium text-foreground/80">
                      {filtered ? "No matching rows" : "This table is empty"}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {filtered
                        ? "Try a different filter or column."
                        : editable
                          ? "Add a row with + or insert data from the SQL tab."
                          : "There is nothing to show yet."}
                    </div>
                  </div>
                )}
                {pages.loading && (
                  <div className="pointer-events-none absolute right-3 top-[38px] flex items-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-2 py-0.5 text-[10.5px] text-muted-foreground shadow-sm">
                    <Spinner className="size-3" />
                    Loading
                  </div>
                )}
              </>
            )}
          </div>
          {inspector && (
            <div className="w-80 shrink-0 border-l border-border/60">
              <RowInspector
                columns={columns}
                row={selectedRow}
                rowLabel={selection ? rowLabel(selection.row) : "—"}
                editable={editable}
                onEdit={(col, value) =>
                  selection && onEdit({ row: selection.row, col }, value)
                }
                onClose={() => setInspector(false)}
              />
            </div>
          )}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border/60 px-3 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {pages.total === null
              ? "Counting rows…"
              : filtered
                ? `${formatCount(total)} matching ${total === 1 ? "row" : "rows"}`
                : `${formatCount(total)} ${total === 1 ? "row" : "rows"}`}
          </span>
          {sort && (
            <span className="truncate">
              sorted by{" "}
              <span className="text-foreground/80">{sort.column}</span>{" "}
              {sort.desc ? "↓" : "↑"}
            </span>
          )}
          {selection && columns[selection.col] && (
            <span className="truncate tabular-nums">
              row {rowLabel(selection.row)} ·{" "}
              <span className="text-foreground/80">
                {columns[selection.col].name}
              </span>
            </span>
          )}
          {!editable && (
            <span className="ml-auto">
              {readOnly
                ? "Read-only database"
                : relation.kind === "view"
                  ? "Views are read-only"
                  : "Read-only"}
            </span>
          )}
        </div>
      </div>
    );
  },
);

function firstEditableCol(columns: readonly GridColumn[]): number {
  // Skip an auto-assigned integer primary key when it leads.
  const i = columns.findIndex((c) => c.editable && !c.pk);
  return i === -1 ? 0 : i;
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "size-7 rounded-lg text-muted-foreground hover:text-foreground",
            active && "bg-muted text-foreground",
          )}
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
