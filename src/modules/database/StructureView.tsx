import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { cn } from "@/lib/utils";
import { Key01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useMemo } from "react";
import { typeTint } from "./DataGrid";
import { sqliteLanguage } from "./lib/sqlLanguage";
import type { RelationInfo } from "./lib/types";
import { formatCount } from "./lib/values";

export function StructureView({ relation }: { relation: RelationInfo }) {
  const themeExt = useEditorThemeExt();
  const extensions = useMemo(
    () => [
      sqliteLanguage,
      EditorView.lineWrapping,
      EditorView.editable.of(false),
    ],
    [],
  );
  const fkByColumn = useMemo(
    () => new Map(relation.foreignKeys.map((f) => [f.from, f])),
    [relation.foreignKeys],
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-7 px-6 py-5">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-semibold text-foreground">
            {relation.name}
          </h2>
          <span className="text-[11.5px] text-muted-foreground">
            {relation.kind}
            {relation.withoutRowid && " · without rowid"}
            {" · "}
            {relation.columns.length}{" "}
            {relation.columns.length === 1 ? "column" : "columns"}
            {relation.rowCount !== null &&
              ` · ${formatCount(relation.rowCount)}${relation.rowCountCapped ? "+" : ""} rows`}
          </span>
        </header>

        {relation.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-[11px] text-destructive">
            {relation.error}
          </div>
        )}

        <Section title="Columns">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-border/70 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
                <th className="w-8 py-1.5 pr-2 font-semibold">#</th>
                <th className="py-1.5 pr-4 font-semibold">Name</th>
                <th className="py-1.5 pr-4 font-semibold">Type</th>
                <th className="py-1.5 pr-4 font-semibold">Nullable</th>
                <th className="py-1.5 pr-4 font-semibold">Default</th>
                <th className="py-1.5 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {relation.columns.map((c, i) => {
                const fk = fkByColumn.get(c.name);
                return (
                  <tr
                    key={c.name}
                    className="border-b border-border/35 hover:bg-muted/30"
                  >
                    <td className="py-1.5 pr-2 font-mono text-[10.5px] tabular-nums text-muted-foreground/60">
                      {i + 1}
                    </td>
                    <td className="py-1.5 pr-4">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        {c.pk > 0 && (
                          <HugeiconsIcon
                            icon={Key01Icon}
                            size={11}
                            strokeWidth={2}
                            className="text-amber-500"
                          />
                        )}
                        {c.name}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "py-1.5 pr-4 font-mono text-[11px] uppercase",
                        c.declType
                          ? typeTint(c.declType)
                          : "text-muted-foreground/50",
                      )}
                    >
                      {c.declType || "any"}
                    </td>
                    <td className="py-1.5 pr-4 text-muted-foreground">
                      {c.notNull ? (
                        <span className="text-foreground/80">NOT NULL</span>
                      ) : (
                        "yes"
                      )}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-[11px] text-muted-foreground">
                      {c.defaultValue ?? (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="py-1.5 text-[11px] text-muted-foreground">
                      <span className="flex flex-wrap gap-1">
                        {c.pk > 0 && (
                          <Tag>
                            primary key
                            {relation.columns.filter((x) => x.pk > 0).length > 1
                              ? ` (${c.pk})`
                              : ""}
                          </Tag>
                        )}
                        {c.generated && <Tag>generated</Tag>}
                        {fk && (
                          <Tag>
                            <HugeiconsIcon
                              icon={Link01Icon}
                              size={10}
                              strokeWidth={2}
                            />
                            {fk.table}
                            {fk.to ? `.${fk.to}` : ""}
                          </Tag>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        {relation.indexes.length > 0 && (
          <Section title="Indexes">
            <ul className="flex flex-col">
              {relation.indexes.map((idx) => (
                <li
                  key={idx.name}
                  className="flex items-center gap-3 border-b border-border/35 py-1.5 text-[12px]"
                >
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {idx.name}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    ({idx.columns.join(", ")})
                  </span>
                  <span className="ml-auto flex gap-1">
                    {idx.unique && <Tag>unique</Tag>}
                    {idx.partial && <Tag>partial</Tag>}
                    {idx.origin === "pk" && <Tag>primary key</Tag>}
                    {idx.origin === "u" && <Tag>constraint</Tag>}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {relation.foreignKeys.length > 0 && (
          <Section title="Foreign keys">
            <ul className="flex flex-col">
              {relation.foreignKeys.map((fk, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list.
                  key={i}
                  className="flex items-center gap-2 border-b border-border/35 py-1.5 text-[12px]"
                >
                  <span className="font-medium text-foreground">{fk.from}</span>
                  <span className="text-muted-foreground/60">→</span>
                  <span className="font-mono text-[11.5px] text-foreground/85">
                    {fk.table}
                    {fk.to ? `.${fk.to}` : ""}
                  </span>
                  <span className="ml-auto text-[10.5px] text-muted-foreground">
                    on update {fk.onUpdate.toLowerCase()} · on delete{" "}
                    {fk.onDelete.toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {relation.sql && (
          <Section title="Definition">
            <div className="overflow-hidden rounded-lg border border-border/60">
              <CodeMirror
                value={relation.sql}
                theme={themeExt}
                extensions={extensions}
                readOnly
                className="text-[12px]"
                basicSetup={{
                  lineNumbers: false,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                }}
              />
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}
