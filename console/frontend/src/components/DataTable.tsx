// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Skeleton from "@mui/material/Skeleton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import { EmptyState } from "./EmptyState";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Hide this column on screens narrower than this breakpoint, for columns
   * a phone can do without (the row still links to the full record). */
  hideBelow?: "sm" | "md";
}

function columnSx<T>(col: DataTableColumn<T>) {
  return col.hideBelow ? { display: { xs: "none", [col.hideBelow]: "table-cell" } } : undefined;
}

/**
 * The one table pattern every list page in this app should render
 * through -- consistent loading (skeleton rows, never a blank page while
 * data is in flight), consistent empty state, consistent row-hover/click
 * affordance. `rows === null` means "still loading"; `rows === []` means
 * "loaded, genuinely nothing here" -- those are different states and
 * render differently.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  emptyMessage = "Nothing to show yet.",
  skeletonRowCount = 5,
}: {
  columns: DataTableColumn<T>[];
  rows: T[] | null;
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: ReactNode;
  skeletonRowCount?: number;
}) {
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {columns.map((col) => (
              <TableCell key={col.key} align={col.align} sx={columnSx(col)}>
                {col.header}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows === null &&
            Array.from({ length: skeletonRowCount }).map((_, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell key={col.key} align={col.align} sx={columnSx(col)}>
                    <Skeleton variant="text" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {rows !== null && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length}>
                <EmptyState message={emptyMessage} />
              </TableCell>
            </TableRow>
          )}
          {rows?.map((row) => (
            <TableRow
              key={getRowKey(row)}
              hover={!!onRowClick}
              onClick={onRowClick ? () => { onRowClick(row); } : undefined}
              sx={onRowClick ? { cursor: "pointer" } : undefined}
            >
              {columns.map((col) => (
                <TableCell key={col.key} align={col.align} sx={columnSx(col)}>
                  {col.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
