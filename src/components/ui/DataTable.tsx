import type { CSSProperties, ReactNode } from "react";

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  width?: CSSProperties["width"];
  align?: "left" | "right" | "center";
}

export interface DataTableProps<Row> {
  rows: Row[];
  columns: Array<DataTableColumn<Row>>;
  getRowKey: (row: Row) => string;
  ariaLabel: string;
  emptyState?: string;
}

export function DataTable<Row>({ rows, columns, getRowKey, ariaLabel, emptyState = "No records found." }: DataTableProps<Row>) {
  return (
    <div className="data-table__scroll">
      <table className="data-table" aria-label={ariaLabel}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align ? `is-${column.align}` : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? (
            rows.map((row) => (
              <tr key={getRowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key} className={column.align ? `is-${column.align}` : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="data-table__empty">
                {emptyState}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
