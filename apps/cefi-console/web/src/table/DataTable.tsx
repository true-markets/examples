import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Columns3, Filter, RotateCcw, X } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Empty, PanelHeaderSlot, cx } from "../components/ui.tsx";
import { FilterEditor, type Facet } from "./FilterEditor.tsx";
import { describe, filterFnFor, isActive, type FilterMeta, type FilterValue } from "./filters.ts";
import { Popover } from "./Popover.tsx";
import { clearLayout, loadLayout, reconcileOrder, saveLayout, type TableLayout } from "./prefs.ts";

// What a column tells the table about itself, on top of TanStack's column definition.
export interface ColMeta {
  // The column's name in headers, menus and filter chips.
  label: string;
  align?: "right";
  title?: string;
  filter?: FilterMeta;
  // Pinned to an edge: always shown, never moved (row checkboxes, row actions).
  fixed?: "left" | "right";
  // Off until you turn it on in the column menu.
  hidden?: boolean;
}

const metaOf = <T,>(c: ColumnDef<T, unknown>) => (c.meta ?? { label: idOf(c) }) as ColMeta;
// A column's id: its explicit id, or the field it reads (TanStack derives the id from that later).
export const idOf = <T,>(c: ColumnDef<T, unknown>) => c.id ?? String((c as { accessorKey?: string }).accessorKey);
const STICKY_RIGHT = "sticky right-0 z-[1] bg-panel shadow-[-8px_0_8px_-8px_rgb(0_0_0/0.4)]";

export interface DataTableProps<T> {
  // Names this table's saved layout.
  id: string;
  data: T[];
  // Every column needs an id; it keys the saved layout.
  columns: ColumnDef<T, unknown>[];
  getRowId: (row: T) => string;
  defaultSorting: SortingState;
  filters: ColumnFiltersState;
  onFiltersChange: OnChangeFn<ColumnFiltersState>;
  // True when the rows arrive already filtered (by a TanStack DB live query).
  manualFiltering?: boolean;
  // Choices and counts for multi-select filters, by column id.
  facets?: Record<string, Facet[]>;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  canSelect?: (row: T) => boolean;
  pageSize?: number;
  rowClassName?: (row: T) => string | false | undefined;
  onRowClick?: (row: T) => void;
  // Flash a row when its key changes, if it changed in the last 1.5 s.
  flash?: { key: (row: T) => string; at: (row: T) => number };
  toolbar?: ReactNode;
  toolbarRight?: ReactNode;
  empty: ReactNode;
  // How many rows matched, out of how many, for the footer.
  total?: number;
}

export function DataTable<T>(p: DataTableProps<T>) {
  const fixedLeft = p.columns.filter((c) => metaOf(c).fixed === "left").map(idOf);
  const fixedRight = p.columns.filter((c) => metaOf(c).fixed === "right").map(idOf);
  const movable = p.columns.filter((c) => !metaOf(c).fixed).map(idOf);

  const defaults = useMemo<TableLayout>(
    () => ({
      visibility: Object.fromEntries(p.columns.filter((c) => metaOf(c).hidden).map((c) => [idOf(c), false])),
      order: movable,
      sizing: {},
      sorting: p.defaultSorting,
    }),
    // The column set is fixed per table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.id],
  );
  const [layout, setLayout] = useState<TableLayout>(() => {
    const saved = loadLayout(p.id);
    return {
      visibility: { ...defaults.visibility, ...saved?.visibility },
      order: reconcileOrder(saved?.order, defaults.order),
      sizing: saved?.sizing ?? {},
      sorting: saved?.sorting ?? defaults.sorting,
    };
  });
  // Saved only once you change something, so a later change to the defaults still reaches you.
  const touched = useRef(false);
  const update = (patch: (l: TableLayout) => Partial<TableLayout>) => {
    touched.current = true;
    setLayout((l) => ({ ...l, ...patch(l) }));
  };
  useEffect(() => {
    if (touched.current) saveLayout(p.id, layout);
  }, [p.id, layout]);
  const reset = () => {
    touched.current = false;
    clearLayout(p.id);
    setLayout(defaults);
  };

  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: p.pageSize ?? 1_000_000 });
  // Back to the first page whenever the filters change.
  useEffect(() => setPagination((s) => ({ ...s, pageIndex: 0 })), [p.filters]);

  // Tables filtered here (not by DB) use the shared filter rules for each column's kind. Every
  // column is also at least wide enough for its header, so labels never truncate.
  const columns = useMemo(
    () =>
      p.columns.map((c) => {
        const meta = metaOf(c);
        // Sized to the header as shown ("Liq"), not the longer menu label ("Liquidity").
        const floor = meta.fixed ? 0 : headerWidth(typeof c.header === "string" ? c.header : meta.label, !!meta.filter);
        return {
          ...c,
          size: Math.max(c.size ?? 110, floor),
          minSize: Math.max(c.minSize ?? 44, floor),
          // A column with its own filterFn (one value standing for several) keeps it.
          ...(meta.filter && !p.manualFiltering && !c.filterFn ? { filterFn: filterFnFor<T>(meta.filter) } : {}),
        };
      }),
    [p.columns, p.manualFiltering],
  );

  const table = useReactTable<T>({
    data: p.data,
    columns,
    getRowId: p.getRowId,
    state: {
      sorting: layout.sorting,
      columnVisibility: layout.visibility,
      columnOrder: [...fixedLeft, ...layout.order, ...fixedRight],
      columnSizing: layout.sizing,
      columnFilters: p.filters,
      rowSelection: p.rowSelection ?? {},
      pagination,
    },
    onSortingChange: (u: Updater<SortingState>) => update((l) => ({ sorting: functionalUpdate(u, l.sorting) })),
    onColumnVisibilityChange: (u) => update((l) => ({ visibility: functionalUpdate(u, l.visibility) })),
    onColumnSizingChange: (u) => update((l) => ({ sizing: functionalUpdate(u, l.sizing) })),
    onColumnFiltersChange: p.onFiltersChange,
    onRowSelectionChange: p.onRowSelectionChange,
    onPaginationChange: setPagination,
    enableRowSelection: p.canSelect ? (row) => p.canSelect!(row.original) : false,
    manualFiltering: p.manualFiltering,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    defaultColumn: { size: 110, minSize: 44, maxSize: 640 },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: p.manualFiltering ? undefined : getFilteredRowModel(),
    getPaginationRowModel: p.pageSize ? getPaginationRowModel() : undefined,
    autoResetPageIndex: false,
  });

  const [openFilter, setOpenFilter] = useState<{ id: string; anchor: HTMLElement }>();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const [dragging, setDragging] = useState<string>();
  const [dropOn, setDropOn] = useState<string>();

  const move = (id: string, to: number) =>
    update((l) => {
      const order = l.order.filter((x) => x !== id);
      order.splice(Math.max(0, Math.min(to, order.length)), 0, id);
      return { order };
    });

  const setFilter = (id: string, value: FilterValue | undefined) =>
    p.onFiltersChange((fs) => [...fs.filter((f) => f.id !== id), ...(value === undefined ? [] : [{ id, value }])]);

  const active = p.filters.flatMap((f) => {
    const col = p.columns.find((c) => idOf(c) === f.id);
    const meta = col && metaOf(col);
    return meta?.filter && isActive(meta.filter.kind, f.value as FilterValue) ? [{ id: f.id, text: describe(meta.label, meta.filter, f.value as FilterValue) }] : [];
  });

  const rows = table.getRowModel().rows;
  const matched = table.getFilteredRowModel().rows.length;
  const openCol = openFilter && p.columns.find((c) => idOf(c) === openFilter.id);
  const headerSlot = useContext(PanelHeaderSlot);
  const columnsButton = (
    <Button size="xs" tone="ghost" title="Show, hide and reorder columns" onClick={(e) => setMenuAnchor(menuAnchor ? undefined : e.currentTarget)}>
      <Columns3 size={13} /> Columns
    </Button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Up in the panel header when there is one; otherwise on the toolbar row. */}
      {headerSlot && createPortal(columnsButton, headerSlot)}
      {(p.toolbar || p.toolbarRight || !headerSlot) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          {p.toolbar}
          <span className="ml-auto flex items-center gap-1.5">
            {p.toolbarRight}
            {!headerSlot && columnsButton}
          </span>
        </div>
      )}

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          {active.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1 rounded bg-info-soft px-1.5 py-0.5 text-[11px] text-info">
              <button type="button" className="hover:underline" onClick={(e) => setOpenFilter({ id: f.id, anchor: e.currentTarget })}>
                {f.text}
              </button>
              <button type="button" aria-label={`Remove filter: ${f.text}`} className="hover:text-ink" onClick={() => setFilter(f.id, undefined)}>
                <X size={11} />
              </button>
            </span>
          ))}
          <button type="button" className="text-[11px] text-muted hover:text-ink hover:underline" onClick={() => p.onFiltersChange([])}>
            Clear all
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {/* At least as wide as its columns: on a narrow screen the panel scrolls sideways rather
            than squeezing them. (min-width isn't reliable on tables, so this is the width itself.) */}
        <table className="border-separate border-spacing-0 text-xs" style={{ width: `max(100%, ${table.getTotalSize()}px)`, tableLayout: "fixed" }}>
          <thead className="sticky top-0 z-10 bg-panel">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h, i) => {
                  const meta = metaOf(h.column.columnDef);
                  const sorted = h.column.getIsSorted();
                  const canMove = !meta.fixed;
                  const filtered = meta.filter && isActive(meta.filter.kind, h.column.getFilterValue() as FilterValue);
                  // The empty column that takes up spare width sits just before the right-pinned ones.
                  const fillerBefore = meta.fixed === "right" && hg.headers[i - 1] && metaOf(hg.headers[i - 1]!.column.columnDef).fixed !== "right";
                  return [
                    fillerBefore ? <th key="filler" className="border-b border-line" /> : null,
                    <th
                      key={h.id}
                      title={meta.title}
                      style={{ width: h.getSize() }}
                      className={cx(
                        "group relative h-8 border-b border-line px-2 text-[10px] font-semibold tracking-wider whitespace-nowrap text-faint uppercase select-none",
                        meta.align === "right" ? "text-right" : "text-left",
                        meta.fixed === "right" && STICKY_RIGHT,
                        dropOn === h.column.id && dragging !== h.column.id && "shadow-[inset_2px_0_0_var(--color-info)]",
                      )}
                      onDragOver={(e) => {
                        if (!dragging || !canMove) return;
                        e.preventDefault();
                        setDropOn(h.column.id);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragging && canMove && dragging !== h.column.id) move(dragging, layout.order.filter((x) => x !== dragging).indexOf(h.column.id));
                        setDragging(undefined);
                        setDropOn(undefined);
                      }}
                    >
                      <div className={cx("flex items-center gap-1", meta.align === "right" && "flex-row-reverse")}>
                        {/* Drag the label to move the column; click it to sort. */}
                        <span
                          draggable={canMove}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", h.column.id);
                            setDragging(h.column.id);
                          }}
                          onDragEnd={() => {
                            setDragging(undefined);
                            setDropOn(undefined);
                          }}
                          onClick={h.column.getToggleSortingHandler()}
                          className={cx("inline-flex min-w-0 items-center gap-1", h.column.getCanSort() && "cursor-pointer hover:text-ink", canMove && "cursor-grab")}
                        >
                          <span className="truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                          {sorted === "asc" && <ArrowUp size={11} className="shrink-0" />}
                          {sorted === "desc" && <ArrowDown size={11} className="shrink-0" />}
                        </span>
                        {meta.filter && (
                          <button
                            type="button"
                            aria-label={`Filter ${meta.label}`}
                            title={`Filter ${meta.label}`}
                            onClick={(e) => setOpenFilter(openFilter?.id === h.column.id ? undefined : { id: h.column.id, anchor: e.currentTarget })}
                            className={cx("shrink-0 rounded p-0.5", filtered ? "text-info" : "text-faint opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100")}
                          >
                            <Filter size={11} fill={filtered ? "currentColor" : "none"} />
                          </button>
                        )}
                      </div>
                      {h.column.getCanResize() && (
                        <div
                          onMouseDown={h.getResizeHandler()}
                          onTouchStart={h.getResizeHandler()}
                          onDoubleClick={() => h.column.resetSize()}
                          title="Drag to resize; double-click to reset"
                          className={cx("absolute top-0 right-0 h-full w-1.5 cursor-col-resize", h.column.getIsResizing() ? "bg-info" : "hover:bg-info/50")}
                        />
                      )}
                    </th>,
                  ];
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                key={row.id}
                flashKey={p.flash?.key(row.original)}
                flashAt={p.flash?.at(row.original) ?? 0}
                className={cx("group", p.onRowClick && "cursor-pointer", "hover:bg-raised", p.rowClassName?.(row.original))}
                onClick={p.onRowClick ? () => p.onRowClick!(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell, i, cells) => {
                  const meta = metaOf(cell.column.columnDef);
                  const fillerBefore = meta.fixed === "right" && cells[i - 1] && metaOf(cells[i - 1]!.column.columnDef).fixed !== "right";
                  return [
                    fillerBefore ? <td key="filler" className="border-b border-line/60" /> : null,
                    <td
                      key={cell.id}
                      className={cx(
                        "h-8 overflow-hidden border-b border-line/60 px-2 text-ellipsis whitespace-nowrap",
                        meta.align === "right" && "text-right",
                        meta.fixed === "right" && cx(STICKY_RIGHT, "group-hover:bg-raised"),
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>,
                  ];
                })}
              </Row>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty>{p.empty}</Empty>}
      </div>

      <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3 text-[11px] text-muted">
        <span>
          {matched}
          {p.total !== undefined && p.total !== matched ? ` of ${p.total}` : ""} {matched === 1 ? "row" : "rows"}
        </span>
        {p.pageSize && table.getPageCount() > 1 && (
          <>
            <span className="ml-auto">
              Page {pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button size="xs" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
              Prev
            </Button>
            <Button size="xs" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
              Next
            </Button>
          </>
        )}
      </footer>

      {openFilter && openCol && metaOf(openCol).filter && (
        <Popover anchor={openFilter.anchor} onClose={() => setOpenFilter(undefined)}>
          <FilterEditor
            key={openFilter.id}
            label={metaOf(openCol).label}
            meta={metaOf(openCol).filter!}
            value={p.filters.find((f) => f.id === openFilter.id)?.value as FilterValue | undefined}
            onChange={(v) => setFilter(openFilter.id, v)}
            facets={p.facets?.[openFilter.id]}
          />
        </Popover>
      )}

      {menuAnchor && (
        <Popover anchor={menuAnchor} onClose={() => setMenuAnchor(undefined)} width={250}>
          <div className="mb-1.5 font-semibold text-ink">Columns</div>
          <p className="mb-2 text-[10px] text-faint">Tick to show. Reorder here or by dragging a header; drag a header's edge to resize.</p>
          <div className="max-h-80 space-y-0.5 overflow-y-auto">
            {layout.order.map((id, idx) => {
              const col = table.getColumn(id);
              if (!col) return null;
              return (
                <div key={id} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-raised">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={col.getIsVisible()} onChange={col.getToggleVisibilityHandler()} />
                    <span className="truncate text-ink">{metaOf(col.columnDef).label}</span>
                  </label>
                  <button type="button" aria-label="Move up" className="rounded p-0.5 text-muted hover:text-ink disabled:opacity-30" disabled={idx === 0} onClick={() => move(id, idx - 1)}>
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="rounded p-0.5 text-muted hover:text-ink disabled:opacity-30"
                    disabled={idx === layout.order.length - 1}
                    onClick={() => move(id, idx + 1)}
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <Button
              size="xs"
              tone="ghost"
              className="w-full"
              title="Default columns, order, widths and sort"
              onClick={() => {
                reset();
                setMenuAnchor(undefined);
              }}
            >
              <RotateCcw size={12} /> Reset to default
            </Button>
          </div>
        </Popover>
      )}
    </div>
  );
}

// Room a header needs: its label in the 10px uppercase, letter-spaced header type (about 7.3px a
// character), the cell padding, the sort arrow, and the filter button if the column has one.
function headerWidth(text: string, filterable: boolean): number {
  return Math.ceil(text.length * 7.3 + 16 + 14 + (filterable ? 18 : 0));
}

// A row that flashes when its key changes. The animation starts from an effect rather than by
// re-keying, so the row (and any button under the cursor) is never re-created mid-click.
function Row({ flashKey, flashAt, children, ...rest }: { flashKey?: string; flashAt: number } & ComponentProps<"tr">) {
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!flashKey || Date.now() - flashAt > 1_500) return;
    ref.current?.animate([{ backgroundColor: "var(--color-accent-soft)" }, { backgroundColor: "transparent" }], { duration: 1_400, easing: "ease-out" });
  }, [flashKey, flashAt]);
  return (
    <tr ref={ref} {...rest}>
      {children}
    </tr>
  );
}
