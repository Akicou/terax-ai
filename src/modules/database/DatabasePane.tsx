import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import {
  Database01Icon,
  FileNotFoundIcon,
  LockIcon,
  RefreshIcon,
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
import { toast } from "sonner";
import { DatabaseSidebar } from "./DatabaseSidebar";
import { SqlConsole } from "./SqlConsole";
import { StructureView } from "./StructureView";
import {
  type SaveFailure,
  TableDataView,
  type TableDataViewHandle,
} from "./TableDataView";
import { dbApi, errorMessage } from "./lib/api";
import {
  EMPTY_PENDING,
  type Pending,
  type PendingAction,
  pendingCount,
  pendingReducer,
  toChanges,
} from "./lib/pendingEdits";
import type { OpenResult, RelationInfo } from "./lib/types";
import { formatBytes } from "./lib/values";

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** Show the file in the text editor instead. */
  onOpenAsText?: () => void;
};

type Session =
  | { status: "loading" }
  | { status: "error"; message: string }
  | OpenResult;

type Mode = "data" | "structure" | "sql";

const MODES: { id: Mode; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "structure", label: "Structure" },
  { id: "sql", label: "SQL" },
];

export const DatabasePane = forwardRef<EditorPaneHandle, Props>(
  function DatabasePane({ path, onDirtyChange, onOpenAsText }, ref) {
    const [session, setSession] = useState<Session>({ status: "loading" });
    const [attempt, setAttempt] = useState(0);
    const handle = session.status === "ready" ? session.handle : null;

    // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` retries the open.
    useEffect(() => {
      let alive = true;
      let opened: number | null = null;
      setSession({ status: "loading" });
      dbApi
        .open(path)
        .then((r) => {
          if (r.status === "ready") {
            if (!alive) {
              void dbApi.close(r.handle);
              return;
            }
            opened = r.handle;
          }
          if (alive) setSession(r);
        })
        .catch((e) => {
          if (alive) setSession({ status: "error", message: errorMessage(e) });
        });
      return () => {
        alive = false;
        if (opened !== null) void dbApi.close(opened);
      };
    }, [path, attempt]);

    const [relations, setRelations] = useState<RelationInfo[] | null>(null);
    const [schemaError, setSchemaError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);
    const [selected, setSelected] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>("data");

    // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` refetches.
    useEffect(() => {
      if (handle === null) return;
      let alive = true;
      dbApi
        .schema(handle)
        .then((s) => {
          if (!alive) return;
          setRelations(s);
          setSchemaError(null);
          setSelected((cur) =>
            cur && s.some((r) => r.name === cur)
              ? cur
              : (s.find((r) => r.kind !== "shadow")?.name ?? null),
          );
        })
        .catch((e) => alive && setSchemaError(errorMessage(e)));
      return () => {
        alive = false;
      };
    }, [handle, reloadToken]);

    // ---- staged edits, per table --------------------------------------
    const [pendingMap, setPendingMap] = useState<ReadonlyMap<string, Pending>>(
      () => new Map(),
    );
    const pendingRef = useRef(pendingMap);
    pendingRef.current = pendingMap;
    const [failure, setFailure] = useState<SaveFailure | null>(null);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);

    const totalPending = useMemo(() => {
      let n = 0;
      for (const p of pendingMap.values()) n += pendingCount(p);
      return n;
    }, [pendingMap]);
    const dirtyTables = useMemo(
      () => new Set([...pendingMap.keys()]),
      [pendingMap],
    );

    const onDirtyRef = useRef(onDirtyChange);
    onDirtyRef.current = onDirtyChange;
    const dirty = totalPending > 0;
    useEffect(() => {
      onDirtyRef.current?.(dirty);
    }, [dirty]);

    const dispatch = useCallback(
      (action: PendingAction) => {
        // Edits wait for an in-flight save, which would otherwise drop them.
        if (savingRef.current || !selected) return;
        setFailure((f) => (f?.table === selected ? null : f));
        setPendingMap((m) => {
          const next = new Map(m);
          const p = pendingReducer(m.get(selected) ?? EMPTY_PENDING, action);
          if (pendingCount(p) === 0) next.delete(selected);
          else next.set(selected, p);
          return next;
        });
      },
      [selected],
    );

    const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

    const discard = useCallback(() => {
      setPendingMap(new Map());
      setFailure(null);
    }, []);

    const save = useCallback(async () => {
      if (savingRef.current || handle === null) return;
      const entries = [...pendingRef.current].filter(
        ([, p]) => pendingCount(p) > 0,
      );
      if (entries.length === 0) return;
      savingRef.current = true;
      setSaving(true);
      setFailure(null);
      let saved = 0;
      try {
        for (const [table, p] of entries) {
          const { changes, targets } = toChanges(p);
          const out = await dbApi.apply(handle, table, changes);
          if (out.status === "failed") {
            setFailure({
              table,
              target: targets[out.index],
              message: out.message,
            });
            setSelected(table);
            setMode("data");
            toast.error(`Couldn't save changes to ${table}`, {
              description: `${out.message}. Nothing in ${table} was written.`,
            });
            return;
          }
          saved += out.count;
          setPendingMap((m) => {
            const next = new Map(m);
            next.delete(table);
            return next;
          });
        }
        toast.success(`Saved ${saved} ${saved === 1 ? "change" : "changes"}`);
      } catch (e) {
        toast.error("Couldn't save changes", { description: errorMessage(e) });
      } finally {
        savingRef.current = false;
        setSaving(false);
        if (saved > 0) refresh();
      }
    }, [handle, refresh]);

    // ---- editor-tab integration ---------------------------------------
    const dataRef = useRef<TableDataViewHandle>(null);
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const saveRef = useRef(save);
    saveRef.current = save;

    useImperativeHandle(
      ref,
      (): EditorPaneHandle => ({
        setQuery: () => {},
        findNext: () => {},
        findPrevious: () => {},
        clearQuery: () => {},
        openSearch: () => {
          setMode("data");
          requestAnimationFrame(() => dataRef.current?.focusFilter());
        },
        focus: () => dataRef.current?.focusGrid(),
        getSelection: () => null,
        getPath: () => path,
        reload: () => {
          // Changed on disk. Staged edits are keyed by row, so refreshing
          // under them is safe, but keep the user's view stable while dirty.
          if (dirtyRef.current) return false;
          refresh();
          return true;
        },
        gotoLine: () => {},
        undo: () => {},
        redo: () => {},
        save: () => saveRef.current(),
        triggerAiComplete: () => {},
        triggerCodeComplete: () => {},
      }),
      [path, refresh],
    );

    const relation = relations?.find((r) => r.name === selected) ?? null;
    const name = path.split(/[\\/]/).pop() ?? path;

    if (session.status === "loading") {
      return (
        <Centered>
          <Spinner className="size-4" />
          <span className="text-[11.5px] text-muted-foreground">
            Opening {name}…
          </span>
        </Centered>
      );
    }
    if (session.status === "unsupported") {
      return (
        <Notice
          icon={Database01Icon}
          title="DuckDB databases aren't supported yet"
          body={`${name} is a DuckDB database. Terax currently opens SQLite databases; DuckDB support is planned.`}
          action={
            onOpenAsText && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                onClick={onOpenAsText}
              >
                Open as file
              </Button>
            )
          }
        />
      );
    }
    if (session.status === "not_a_database" || session.status === "error") {
      return (
        <Notice
          icon={FileNotFoundIcon}
          title={
            session.status === "error"
              ? "Couldn't open this database"
              : "Not a SQLite database"
          }
          body={session.message}
          action={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                onClick={() => setAttempt((a) => a + 1)}
              >
                Try again
              </Button>
              {onOpenAsText && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={onOpenAsText}
                >
                  Open as file
                </Button>
              )}
            </div>
          }
        />
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {/* Header */}
        <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border/60 px-3">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400">
            <HugeiconsIcon icon={Database01Icon} size={14} strokeWidth={1.8} />
          </div>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground">
            {name}
          </span>
          <span className="shrink-0 rounded-[4px] border border-border/70 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            {session.engine}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {formatBytes(session.size)}
          </span>
          {session.readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-amber-500/12 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  <HugeiconsIcon icon={LockIcon} size={10} strokeWidth={2} />
                  Read-only
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64 text-[11px]">
                The file or its folder isn't writable, so changes can't be
                saved.
              </TooltipContent>
            </Tooltip>
          )}

          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <div className="flex items-center gap-1.5 animate-in fade-in-0 slide-in-from-right-1">
                <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-amber-700 dark:text-amber-300">
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  {totalPending} unsaved
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 rounded-lg text-[11px]"
                  disabled={saving}
                  onClick={discard}
                >
                  Discard
                </Button>
                <Button
                  size="xs"
                  className="h-6 gap-1.5 rounded-lg text-[11px]"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving && <Spinner className="size-3" />}
                  Save
                </Button>
              </div>
            )}
            <div
              role="tablist"
              aria-label="View"
              className="flex items-center rounded-lg bg-muted/70 p-0.5"
            >
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    "h-6 rounded-md px-2.5 text-[11.5px] font-medium transition-all",
                    mode === m.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                  onClick={refresh}
                  aria-label="Refresh"
                >
                  <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Refresh
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {schemaError ? (
          <Notice
            icon={FileNotFoundIcon}
            title="Couldn't read the schema"
            body={schemaError}
            action={
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                onClick={refresh}
              >
                Try again
              </Button>
            }
          />
        ) : relations === null ? (
          <Centered>
            <Spinner className="size-4" />
          </Centered>
        ) : (
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              id="db-sidebar"
              defaultSize="20%"
              minSize="12%"
              maxSize="45%"
            >
              <DatabaseSidebar
                relations={relations}
                selected={selected}
                onSelect={(n) => {
                  setSelected(n);
                  if (mode === "sql") setMode("data");
                }}
                dirty={dirtyTables}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="db-main" minSize="40%">
              <div className="h-full min-h-0">
                {mode === "sql" ? (
                  <SqlConsole
                    handle={session.handle}
                    path={path}
                    relations={relations}
                    onWrote={refresh}
                  />
                ) : !relation ? (
                  <Centered>
                    <div className="text-[12.5px] font-medium text-foreground/85">
                      This database has no tables
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Create one from the{" "}
                      <button
                        type="button"
                        className="text-foreground underline underline-offset-2"
                        onClick={() => setMode("sql")}
                      >
                        SQL tab
                      </button>
                      .
                    </div>
                  </Centered>
                ) : mode === "structure" ? (
                  <StructureView relation={relation} />
                ) : (
                  <TableDataView
                    // Sort, filter and selection belong to one table.
                    key={relation.name}
                    ref={dataRef}
                    handle={session.handle}
                    relation={relation}
                    readOnly={session.readOnly}
                    pending={pendingMap.get(relation.name) ?? EMPTY_PENDING}
                    dispatch={dispatch}
                    failure={failure}
                    reloadToken={reloadToken}
                  />
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    );
  },
);

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {children}
    </div>
  );
}

function Notice({
  icon,
  title,
  body,
  action,
}: {
  icon: typeof Database01Icon;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Centered>
      <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <HugeiconsIcon icon={icon} size={20} strokeWidth={1.6} />
      </div>
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      <div className="max-w-md text-[11.5px] leading-relaxed text-muted-foreground">
        {body}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </Centered>
  );
}
