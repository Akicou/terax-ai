import type { EditorPaneHandle } from "@/modules/editor/EditorPane";
import type { ComponentProps } from "react";
import { forwardRef, lazy, Suspense } from "react";
import type { DatabasePane as DatabasePaneType } from "./DatabasePane";

// The database view (grid, SQL console) loads only when a database is opened.
const DatabasePaneInner = lazy(() =>
  import("./DatabasePane").then((m) => ({ default: m.DatabasePane })),
);

type Props = Omit<ComponentProps<typeof DatabasePaneType>, "ref">;

export const DatabasePane = forwardRef<EditorPaneHandle, Props>(
  function DatabasePane(props, ref) {
    return (
      <Suspense fallback={null}>
        <DatabasePaneInner ref={ref} {...props} />
      </Suspense>
    );
  },
);
