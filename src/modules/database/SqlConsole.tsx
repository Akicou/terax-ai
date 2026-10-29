import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { cn } from "@/lib/utils";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  Alert02Icon,
  PlayIcon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataGrid,
  type GridColumn,
  type GridPos,
  type GridRow,
} from "./DataGrid";
import { dbApi, errorMessage } from "./lib/api";
import { schemaCompletions, sqliteLanguage } from "./lib/sqlLanguage";
import type { QueryResult, RelationInfo } from "./lib/types";
import { formatCount } from "./lib/values";

/** Console text per database, kept while the app runs. */
const drafts = new Map<string, string>();

const isMac =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

type Props = {
  handle: number;
  path: string;
  relations: readonly RelationInfo[];
  /** A statement may have changed data or schema. */
  onWrote: () => void;
};

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: QueryResult }
  | { status: "error"; message: string };

export function SqlConsole({ handle, path, relations, onWrote }: Props) {
  const themeExt = useEditorThemeExt();
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const [text, setText] = useState(
    () => drafts.get(path) ?? defaultQuery(relations),
  );
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [selection, setSelection] = useState<GridPos | null>(null);
  const runningRef = useRef(false);

  const execute = useCallback(async () => {
    if (runningRef.current) return;
    const view = cmRef.current?.view;
    const doc = view?.state.doc.toString() ?? text;
    const sel = view?.state.selection.main;
    const sql = sel && !sel.empty ? view.state.sliceDoc(sel.from, sel.to) : doc;
    if (!sql.trim()) return;
    runningRef.current = true;
    setRun({ status: "running" });
    setSelection(null);
    try {
      const result = await dbApi.query(handle, sql);
      setRun({ status: "done", result });
      if (result.wrote) onWrote();
    } catch (e) {
      setRun({ status: "error", message: errorMessage(e) });
      // A failing batch may have applied the statements before the error.
      onWrote();
    } finally {
      runningRef.current = false;
    }
  }, [handle, text, onWrote]);

  const executeRef = useRef(execute);
  executeRef.current = execute;

  const extensions = useMemo(
    () => [
      sqliteLanguage,
      sqliteLanguage.data.of({ autocomplete: schemaCompletions(relations) }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              void executeRef.current();
              return true;
            },
          },
        ]),
      ),
    ],
    [relations],
  );

  const result = run.status === "done" ? run.result : null;
  const columns: GridColumn[] = useMemo(
    () =>
      (result?.columns ?? []).map((name) => ({
        name,
        declType: "",
        editable: false,
      })),
    [result],
  );
  const getRow = useCallback(
    (i: number): GridRow | null => {
      const cells = result?.rows[i];
      return cells ? { cells, state: "normal" } : null;
    },
    [result],
  );

  return (
    <ResizablePanelGroup orientation="vertical" className="h-full min-h-0">
      <ResizablePanel id="sql-editor" defaultSize="38%" minSize="15%">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75">
              Query
            </span>
            <span className="text-[10.5px] text-muted-foreground/60">
              Runs the selection, or everything
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {run.status === "running" ? (
                <Button
                  size="xs"
                  variant="destructive"
                  className="h-6 gap-1 rounded-lg text-[11px]"
                  onClick={() => void dbApi.interrupt(handle)}
                >
                  <HugeiconsIcon icon={StopIcon} size={11} strokeWidth={2} />
                  Stop
                </Button>
              ) : (
                <Button
                  size="xs"
                  className="h-6 gap-1.5 rounded-lg pl-2 pr-1.5 text-[11px]"
                  onClick={() => void execute()}
                >
                  <HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={2.2} />
                  Run
                  <Kbd className="h-4 bg-primary-foreground/15 px-1 text-[9.5px] text-primary-foreground">
                    {isMac ? "⌘↵" : "Ctrl↵"}
                  </Kbd>
                </Button>
              )}
            </div>
          </div>
          <CodeMirror
            ref={cmRef}
            value={text}
            onChange={(v) => {
              setText(v);
              drafts.set(path, v);
            }}
            theme={themeExt}
            extensions={extensions}
            height="100%"
            className="terax-code-editor min-h-0 flex-1 overflow-hidden text-[12.5px]"
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
            }}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="sql-results" minSize="20%">
        <div className="flex h-full min-h-0 flex-col">
          <ResultBar run={run} />
          <div className="relative min-h-0 flex-1">
            {run.status === "error" && (
              <div className="m-3 flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  size={14}
                  strokeWidth={2}
                  className="mt-px shrink-0 text-destructive"
                />
                <pre className="min-w-0 select-text whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-destructive">
                  {run.message}
                </pre>
              </div>
            )}
            {run.status === "idle" && (
              <div className="flex h-full items-center justify-center text-[11.5px] text-muted-foreground/70">
                Results appear here.
              </div>
            )}
            {result && result.columns.length > 0 && (
              <DataGrid
                columns={columns}
                rowCount={result.rows.length}
                getRow={getRow}
                selection={selection}
                onSelect={setSelection}
                layoutKey={
                  String(result.elapsedMs) + result.columns.join("\u0000")
                }
              />
            )}
            {result && result.columns.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                <div className="text-[12.5px] font-medium text-foreground/85">
                  {result.statements === 1
                    ? "Statement executed"
                    : `${result.statements} statements executed`}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {result.changes > 0
                    ? `${formatCount(result.changes)} ${result.changes === 1 ? "row" : "rows"} changed`
                    : "No rows returned"}
                </div>
              </div>
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ResultBar({ run }: { run: RunState }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[11px] text-muted-foreground">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75">
        Results
      </span>
      {run.status === "running" && (
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" /> Running…
        </span>
      )}
      {run.status === "error" && (
        <span className="text-destructive">Failed</span>
      )}
      {run.status === "done" && (
        <span className="flex items-center gap-2 tabular-nums">
          <HugeiconsIcon
            icon={Tick02Icon}
            size={12}
            strokeWidth={2.2}
            className="text-emerald-500"
          />
          {run.result.columns.length > 0 && (
            <Chip>
              {formatCount(run.result.rows.length)}
              {run.result.truncated ? "+" : ""}{" "}
              {run.result.rows.length === 1 ? "row" : "rows"}
            </Chip>
          )}
          {run.result.changes > 0 && (
            <Chip>{formatCount(run.result.changes)} changed</Chip>
          )}
          <Chip>{formatMs(run.result.elapsedMs)}</Chip>
          {run.result.truncated && (
            <span className="text-muted-foreground/70">
              showing the first {formatCount(run.result.rows.length)}; add a
              LIMIT to page
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-[4px] bg-muted px-1.5 py-px text-[10.5px] text-foreground/75",
      )}
    >
      {children}
    </span>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function defaultQuery(relations: readonly RelationInfo[]): string {
  const first = relations.find((r) => r.kind === "table") ?? relations[0];
  if (!first) return "SELECT sqlite_version();\n";
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(first.name)
    ? first.name
    : `"${first.name.replace(/"/g, '""')}"`;
  return `SELECT * FROM ${name} LIMIT 100;\n`;
}
