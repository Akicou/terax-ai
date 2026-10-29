import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyOutcome,
  Change,
  OpenResult,
  Page,
  PageRequest,
  QueryResult,
  RelationInfo,
} from "./types";

export const dbApi = {
  open: (path: string, readOnly = false) =>
    invoke<OpenResult>("db_open", {
      path,
      workspace: currentWorkspaceEnv(),
      readOnly,
    }),
  close: (handle: number) => invoke<void>("db_close", { handle }),
  schema: (handle: number) => invoke<RelationInfo[]>("db_schema", { handle }),
  rows: (handle: number, request: PageRequest) =>
    invoke<Page>("db_rows", { handle, request }),
  apply: (handle: number, table: string, changes: Change[]) =>
    invoke<ApplyOutcome>("db_apply", { handle, table, changes }),
  query: (handle: number, sql: string) =>
    invoke<QueryResult>("db_query", { handle, sql }),
  interrupt: (handle: number) => invoke<void>("db_interrupt", { handle }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
