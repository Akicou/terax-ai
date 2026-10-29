import { useCallback, useEffect, useRef, useState } from "react";
import { dbApi, errorMessage } from "./api";
import type { Row } from "./types";

export const PAGE_SIZE = 200;
/** Pages kept in memory; the ones farthest from the viewport go first. */
const MAX_PAGES = 24;

export type TableQuery = {
  table: string;
  sortColumn: string | null;
  sortDesc: boolean;
  filterText: string;
  filterColumn: string | null;
};

type Meta = {
  total: number | null;
  loading: boolean;
  error: string | null;
};

/**
 * Windowed access to a table's rows. Pages load on demand as the grid
 * scrolls; a query change or `reloadToken` bump refetches, keeping the
 * current rows on screen until the first new page arrives.
 */
export function useTablePages(
  handle: number | null,
  query: TableQuery,
  reloadToken: number,
) {
  const pages = useRef(new Map<number, Row[]>());
  const inflight = useRef(new Set<number>());
  const generation = useRef(0);
  /** Pages the grid last asked for; refetched after a reload. */
  const visible = useRef<[number, number]>([0, 0]);
  const [meta, setMeta] = useState<Meta>({
    total: null,
    loading: true,
    error: null,
  });
  // Bumped when a page lands so the grid re-reads rows.
  const [version, setVersion] = useState(0);
  const { table, sortColumn, sortDesc, filterText, filterColumn } = query;

  const fetchPage = useCallback(
    (index: number, gen: number, withTotal: boolean): Promise<void> => {
      if (handle == null) return Promise.resolve();
      inflight.current.add(index);
      return dbApi
        .rows(handle, {
          table,
          offset: index * PAGE_SIZE,
          limit: PAGE_SIZE,
          sortColumn,
          sortDesc,
          filterText: filterText || null,
          filterColumn,
          withTotal,
        })
        .then((page) => {
          if (gen !== generation.current) return;
          if (withTotal) {
            // Visible pages stay on screen until their fresh copy lands.
            const [first, last] = visible.current;
            const kept = new Map<number, Row[]>();
            for (const [i, rows] of pages.current) {
              if (i >= first && i <= last) kept.set(i, rows);
            }
            pages.current = kept;
            setMeta({ total: page.total ?? 0, loading: false, error: null });
            for (let i = Math.max(first, 1); i <= last; i++) {
              void fetchPage(i, gen, false);
            }
          }
          pages.current.set(index, page.rows);
          setVersion((v) => v + 1);
        })
        .catch((e) => {
          if (gen !== generation.current) return;
          setMeta((m) => ({ ...m, loading: false, error: errorMessage(e) }));
        })
        .finally(() => {
          if (gen === generation.current) inflight.current.delete(index);
        });
    },
    [handle, table, sortColumn, sortDesc, filterText, filterColumn],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` refetches.
  useEffect(() => {
    const gen = ++generation.current;
    inflight.current = new Set();
    setMeta((m) => ({ ...m, loading: true, error: null }));
    void fetchPage(0, gen, true);
  }, [fetchPage, reloadToken]);

  const ensureRange = useCallback(
    (start: number, end: number) => {
      const first = Math.floor(Math.max(0, start) / PAGE_SIZE);
      const last = Math.floor(Math.max(0, end) / PAGE_SIZE);
      visible.current = [first, last];
      for (let i = first; i <= last; i++) {
        // Page 0 always comes from the query's first fetch (it carries the total).
        if (i > 0 && !pages.current.has(i) && !inflight.current.has(i)) {
          void fetchPage(i, generation.current, false);
        }
      }
      if (pages.current.size > MAX_PAGES) {
        const center = (first + last) / 2;
        const far = [...pages.current.keys()]
          .filter((i) => i < first || i > last)
          .sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
        for (const i of far.slice(0, pages.current.size - MAX_PAGES)) {
          pages.current.delete(i);
        }
      }
    },
    [fetchPage],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` signals a cache change.
  const getRow = useCallback(
    (index: number): Row | undefined =>
      pages.current.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE],
    [version],
  );

  return { ...meta, getRow, ensureRange, version };
}
