import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  Cancel01Icon,
  Layers01Icon,
  Search01Icon,
  TableIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import type { RelationInfo } from "./lib/types";

type Props = {
  relations: readonly RelationInfo[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** Tables with unsaved edits. */
  dirty: ReadonlySet<string>;
};

function compactCount(n: number, capped: boolean): string {
  const s =
    n < 1000
      ? String(n)
      : n < 1_000_000
        ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`
        : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return capped ? `${s}+` : s;
}

export function DatabaseSidebar({
  relations,
  selected,
  onSelect,
  dirty,
}: Props) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: RelationInfo) => !q || r.name.toLowerCase().includes(q);
    const tables = relations.filter(
      (r) => r.kind !== "view" && r.kind !== "shadow" && match(r),
    );
    const views = relations.filter((r) => r.kind === "view" && match(r));
    const internal = relations.filter((r) => r.kind === "shadow" && match(r));
    return [
      { title: "Tables", items: tables },
      { title: "Views", items: views },
      { title: "Internal", items: internal },
    ].filter((g) => g.items.length > 0);
  }, [relations, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="shrink-0 p-2">
        <div className="flex h-7 items-center rounded-lg border border-border/60 bg-background/60 pl-2 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <HugeiconsIcon
            icon={Search01Icon}
            size={12}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground/70"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Find table"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {groups.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/70">
            {relations.length === 0 ? "No tables yet" : "No matches"}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.title} className="mb-2">
            <div className="flex items-center justify-between px-2 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/65">
              <span>{g.title}</span>
              <span className="tabular-nums">{g.items.length}</span>
            </div>
            {g.items.map((r) => {
              const active = r.name === selected;
              const icon =
                r.kind === "view"
                  ? ViewIcon
                  : r.kind === "virtual" || r.kind === "shadow"
                    ? Layers01Icon
                    : TableIcon;
              const item = (
                <button
                  key={r.name}
                  type="button"
                  onClick={() => onSelect(r.name)}
                  className={cn(
                    "group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/85 hover:bg-muted/60",
                  )}
                >
                  <HugeiconsIcon
                    icon={r.error ? Alert02Icon : icon}
                    size={13}
                    strokeWidth={1.8}
                    className={cn(
                      "shrink-0",
                      r.error
                        ? "text-destructive"
                        : active
                          ? "text-foreground/80"
                          : "text-muted-foreground/70",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {dirty.has(r.name) && (
                    <span className="size-1.5 shrink-0 rounded-full bg-amber-500">
                      <span className="sr-only">unsaved changes</span>
                    </span>
                  )}
                  {r.rowCount !== null && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                      {compactCount(r.rowCount, r.rowCountCapped)}
                    </span>
                  )}
                </button>
              );
              return r.error ? (
                <Tooltip key={r.name}>
                  <TooltipTrigger asChild>{item}</TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs text-[11px]">
                    {r.error}
                  </TooltipContent>
                </Tooltip>
              ) : (
                item
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
