import { createColumnHelper, type ColumnDef, type ColumnFiltersState } from "@tanstack/react-table";
import { ArrowDownToLine, ArrowUpFromLine, LoaderCircle } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { CefiBalance, CustodyMove } from "../../../shared/api.ts";
import { isCustodyPending, isCustodySettled } from "../../../shared/api.ts";
import { useBalances, useCustody, useCustodyMove } from "../api.ts";
import { custodyAmount, floorDecimals, toRows, trimZeros, type AmountUnit, type AssetRow } from "../balances.ts";
import { ago, price as fmtPrice, qty, usd } from "../format.ts";
import { DataTable, type ColMeta } from "../table/DataTable.tsx";
import { Button, Empty, Field, Modal, Panel, Segmented, cx, inputClass, selectClass } from "./ui.tsx";

type Action = (kind: "allocations" | "releases", row: AssetRow) => void;

// Wallet balances next to what is committed to CeFi. Allocating doesn't move tokens: they stay in
// the wallet but can't leave until released, and the same amount becomes tradable on CeFi.
export function Balances() {
  const { data, error, dataUpdatedAt } = useBalances();
  const { data: moves } = useCustody();
  const [tab, setTab] = useState<"assets" | "activity">("assets");
  const [hideSmall, setHideSmall] = useState(true);
  const [dialog, setDialog] = useState<{ kind: "allocations" | "releases"; row: AssetRow }>();
  const pending = moves?.filter((m) => !isCustodySettled(m)).length ?? 0;
  // Stable, so the table's columns (and every cell) aren't rebuilt on each render.
  const onAction = useCallback<Action>((kind, row) => setDialog({ kind, row }), []);

  const allRows = useMemo(() => toRows(data), [data]);
  const rows = useMemo(() => (hideSmall ? allRows.filter((r) => r.valueUsd === null || r.valueUsd >= 1) : allRows), [allRows, hideSmall]);
  const totalUsd = allRows.reduce((s, r) => s + (r.valueUsd ?? 0), 0);

  return (
    <Panel
      className="h-full"
      title={
        <span className="flex items-center gap-2">
          Balances
          {totalUsd > 0 && <span className="num rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-ink normal-case">{usd(totalUsd)}</span>}
        </span>
      }
      actions={
        <>
          {tab === "assets" && (
            <label className="mr-1 flex items-center gap-1 text-[11px] text-muted" title="Hide assets worth less than $1">
              <input type="checkbox" checked={hideSmall} onChange={(e) => setHideSmall(e.target.checked)} /> Hide &lt; $1
            </label>
          )}
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "assets", label: "Assets" },
              { value: "activity", label: pending ? `Moves (${pending} pending)` : "Moves" },
            ]}
          />
        </>
      }
    >
      {/* The banner and the table share the panel's height, so only the table scrolls. */}
      <div className="flex h-full flex-col">
        {error && (
          <div className="shrink-0 border-b border-line bg-sell-soft px-3 py-1 text-[11px] text-sell">
            {data ? `Couldn't refresh balances (${error.message}); showing data from ${ago(dataUpdatedAt)}.` : error.message}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tab === "assets" ? (
            !data ? (
              <Empty>{error ? "Balances unavailable." : "Loading balances…"}</Empty>
            ) : (
              <AssetTable rows={rows} unsettledFees={Number(data.unsettledFees)} onAction={onAction} />
            )
          ) : (
            <Moves moves={moves} />
          )}
        </div>
      </div>
      {dialog && <CustodyDialog {...dialog} onClose={() => setDialog(undefined)} />}
    </Panel>
  );
}

const col = createColumnHelper<AssetRow>();
const nullsLast = (a: number | null, b: number | null) => (a ?? -Infinity) - (b ?? -Infinity);

// USD value of a quantity of this row's asset; null without a price or a quantity.
function usdOf(r: AssetRow, q: string | number | undefined): number | null {
  if (q === undefined || r.price === null) return null;
  return Number(q) * r.price;
}

function usdText(v: number | null): string {
  return v === null ? "—" : usd(v);
}

// Two lines in one cell: the figure you sort by on top, the quantity it comes from underneath.
function Stack({ top, bottom, topClass, strong }: { top: ReactNode; bottom: ReactNode; topClass?: string; strong?: boolean }) {
  return (
    <div className="leading-tight">
      <div className={cx("num", strong && "font-medium", topClass ?? "text-ink")}>{top}</div>
      <div className="num text-[10px] text-faint">{bottom}</div>
    </div>
  );
}

// A CeFi balance column: USD on top, quantity below, sorted by USD.
function cefiColumn(id: string, header: string, pick: (c: CefiBalance) => string, title: string, strong = false) {
  return col.accessor((r) => usdOf(r, r.cefi ? pick(r.cefi) : undefined), {
    id,
    header,
    cell: (c) => {
      const r = c.row.original;
      if (!r.cefi) return <span className="num text-muted">—</span>;
      const q = Number(pick(r.cefi));
      return <Stack top={q ? usdText(c.getValue()) : "—"} topClass={q ? undefined : "text-muted"} bottom={qty(q, 6)} strong={strong} />;
    },
    sortingFn: (a, b) => nullsLast(a.getValue(id), b.getValue(id)),
    size: 112,
    meta: { label: header, align: "right", title: `${title}; USD on top, quantity below`, filter: { kind: "range", unit: "$" } } satisfies ColMeta,
  });
}

function AssetTable({ rows, unsettledFees, onAction }: { rows: AssetRow[]; unsettledFees: number; onAction: Action }) {
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const columns = useMemo(
    () => [
      col.accessor("symbol", {
        id: "symbol",
        header: "Asset",
        size: 96,
        meta: { label: "Asset", filter: { kind: "multi" } } satisfies ColMeta,
        cell: (c) => (
          <div className="leading-tight">
            <div className="font-semibold text-ink">{c.getValue()}</div>
            <div className="num text-[10px] text-faint">{c.row.original.price !== null ? `$${fmtPrice(c.row.original.price, c.row.original.price >= 1 ? 2 : 6)}` : "no price"}</div>
          </div>
        ),
      }),
      // Every column below shows USD on top and the quantity under it, and sorts by the top line.
      col.accessor("valueUsd", {
        id: "value",
        header: "Value",
        cell: (c) => <Stack top={usdText(c.getValue())} bottom={qty(c.row.original.wallet, 6)} strong />,
        sortingFn: (a, b) => nullsLast(a.original.valueUsd, b.original.valueUsd),
        size: 112,
        meta: {
          label: "Value",
          align: "right",
          title: "USD value of everything you hold of the asset (wallet and CeFi, priced by the portfolio); below it, the wallet balance across chains",
          filter: { kind: "range", unit: "$" },
        } satisfies ColMeta,
      }),
      col.accessor("allocatedPct", {
        id: "allocated",
        header: "Allocated",
        cell: (c) => {
          const r = c.row.original;
          return (
            <Stack
              top={r.allocatedPct === null ? "—" : `${(r.allocatedPct * 100).toFixed(1)}%`}
              topClass={r.allocated > 0 ? "text-info" : "text-muted"}
              bottom={qty(r.allocated, 6)}
            />
          );
        },
        sortingFn: (a, b) => nullsLast(a.original.allocatedPct, b.original.allocatedPct),
        size: 104,
        meta: { label: "Allocated", align: "right", title: "Share of the wallet committed to CeFi; below it, the quantity", filter: { kind: "range", scale: 100, unit: "%" } } satisfies ColMeta,
      }),
      cefiColumn("cefi", "CeFi bal", (c) => c.balance, "Balance on the exchange"),
      cefiColumn("orders", "In orders", (c) => c.orderHold, "Held against open orders"),
      col.accessor((r) => usdOf(r, r.cefi?.unsettled), {
        id: "unsettled",
        header: "Unsettled",
        cell: (c) => {
          const r = c.row.original;
          const v = r.cefi ? Number(r.cefi.unsettled) : 0;
          const fees = r.symbol === "USDC" && unsettledFees > 0;
          const usdV = c.getValue();
          const signed = (n: number, text: string) => (n > 0 ? `+${text}` : n < 0 ? `−${text.replace("-", "")}` : text);
          return (
            <Stack
              top={v ? signed(v, usdText(usdV)) : "—"}
              topClass={!v ? "text-muted" : v > 0 ? "text-buy" : "text-sell"}
              bottom={
                <>
                  {v ? signed(v, qty(v, 6)) : "—"}
                  {fees && <span className="ml-1 text-sell" title={`${qty(unsettledFees, 6)} USDC of fees on the account are not yet settled`}>fees −{qty(unsettledFees, 4)}</span>}
                </>
              }
            />
          );
        },
        sortingFn: (a, b) => nullsLast(a.getValue("unsettled"), b.getValue("unsettled")),
        size: 112,
        meta: { label: "Unsettled", align: "right", title: "Traded but not yet settled by the custodian: + inbound, − outbound", filter: { kind: "range", unit: "$" } } satisfies ColMeta,
      }),
      cefiColumn("tradable", "Tradable", (c) => c.tradable, "balance + unsettled − holds", true),
      col.display({
        id: "actions",
        header: "",
        size: 170,
        enableSorting: false,
        enableResizing: false,
        meta: { label: "Actions", fixed: "right" } satisfies ColMeta,
        cell: ({ row }) => {
          const r = row.original;
          const free = r.wallets.reduce((s, w) => s + Number(w.available), 0);
          return (
            <div className="flex justify-end gap-1">
              <Button
                size="xs"
                disabled={!r.canAllocate || !(free > 0)}
                title={r.canAllocate ? "Commit wallet funds to CeFi trading" : `${r.symbol} doesn't trade on CeFi`}
                onClick={() => onAction("allocations", r)}
              >
                <ArrowUpFromLine size={11} /> Allocate
              </Button>
              <Button size="xs" disabled={!(r.allocated > 0)} title="Free funds from CeFi back to the wallet" onClick={() => onAction("releases", r)}>
                <ArrowDownToLine size={11} /> Release
              </Button>
            </div>
          );
        },
      }),
    ],
    [onAction, unsettledFees],
  );

  // Choices for the Asset filter, from the rows shown before filtering.
  const facets = useMemo(() => ({ symbol: rows.map((r) => ({ value: r.symbol, count: r.wallets.length || 1 })).sort((a, b) => a.value.localeCompare(b.value)) }), [rows]);

  return (
    <DataTable<AssetRow>
      id="balances"
      data={rows}
      columns={columns as ColumnDef<AssetRow, unknown>[]}
      getRowId={(r) => r.symbol}
      // Biggest holdings first.
      defaultSorting={[{ id: "value", desc: true }]}
      filters={filters}
      onFiltersChange={setFilters}
      facets={facets}
      empty="No balances match."
    />
  );
}

function CustodyDialog({ kind, row, onClose }: { kind: "allocations" | "releases"; row: AssetRow; onClose: () => void }) {
  const allocating = kind === "allocations";
  // The wallet listings (one per chain) this move can use, biggest first.
  const choices = row.wallets
    .filter((w) => Number(allocating ? w.available : w.allocated) > 0)
    .sort((a, b) => Number(allocating ? b.available : b.allocated) - Number(allocating ? a.available : a.allocated));
  const [assetId, setAssetId] = useState(choices[0]?.assetId ?? "");
  const [amount, setAmount] = useState("");
  // Type the amount in USD (the default when the asset has a price) or as a quantity.
  const [unit, setUnit] = useState<AmountUnit>(row.price !== null ? "USD" : "QTY");
  const move = useCustodyMove();
  const w = choices.find((c) => c.assetId === assetId);
  // A release can't take what open orders are holding on CeFi.
  const max = !w ? 0 : allocating ? Number(w.available) : Math.min(Number(w.allocated), Math.max(0, Number(row.cefi?.tradable ?? w.allocated)));
  const decimals = w?.decimals ?? 6;
  const parsed = custodyAmount({ unit, input: amount, price: row.price, decimals, max, symbol: row.symbol });
  const valid = !!w && parsed.ok;
  // Max is exact, so it switches to quantity rather than a rounded USD figure.
  const setMax = () => {
    setUnit("QTY");
    setAmount(trimZeros(floorDecimals(max, Math.min(decimals, 12))));
  };
  const switchUnit = (u: AmountUnit) => {
    // Carry the amount across so switching shows the same size in the other unit.
    if (parsed.ok && u !== unit) setAmount(u === "QTY" ? parsed.qty : parsed.usdValue !== null ? parsed.usdValue.toFixed(2) : "");
    setUnit(u);
  };

  return (
    <Modal
      title={`${allocating ? "Allocate" : "Release"} ${row.symbol}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button tone="primary" disabled={!valid || move.isPending} onClick={() => parsed.ok && move.mutate({ kind, assetId, amount: parsed.qty, symbol: row.symbol }, { onSuccess: onClose })}>
            {move.isPending ? "Sending…" : allocating ? "Allocate to CeFi" : "Release to wallet"}
          </Button>
        </>
      }
    >
      {choices.length > 1 && (
        <Field label={allocating ? "From the wallet on" : "Back to the wallet on"}>
          <select className={cx(selectClass, "h-8 w-full")} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {choices.map((c) => (
              <option key={c.assetId} value={c.assetId}>
                {c.chain ?? "wallet"} · {qty(allocating ? c.available : c.allocated, 6)} {allocating ? "free" : "allocated"}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted">{unit === "USD" ? "Amount (USD)" : `Quantity (${row.symbol})`}</span>
          <button type="button" className="text-[11px] text-info hover:underline" onClick={setMax} title="Fills in the exact quantity available">
            Max {qty(max, 6)} {row.symbol}
            {row.price !== null ? ` (${usd(max * row.price)})` : ""}
          </button>
          <span className="ml-auto">
            <Segmented<AmountUnit>
              value={unit}
              onChange={(u) => (u === "USD" && row.price === null ? undefined : switchUnit(u))}
              options={[
                { value: "USD", label: <span className={cx(row.price === null && "opacity-40")}>USD</span> },
                { value: "QTY", label: row.symbol },
              ]}
            />
          </span>
        </div>
        <input
          className={inputClass}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={unit === "USD" ? "$0.00" : "0.00"}
          inputMode="decimal"
          aria-label={unit === "USD" ? "Amount in USD" : `Quantity of ${row.symbol}`}
          autoFocus
        />
        {/* The other unit: the quantity a USD amount comes to, or the USD value of a quantity. */}
        <p className={cx("num mt-1 min-h-4 text-[11px]", parsed.ok ? "text-muted" : "text-accent")}>{parsed.describe}</p>
      </div>
      <p className="text-[11px] leading-relaxed text-faint">
        {allocating
          ? "The tokens stay in your wallet but are committed to CeFi until released, and the same amount becomes tradable on the exchange. It takes a few seconds; the status shows under Moves."
          : "Frees allocated funds so they can leave your wallet again. Funds held by open CeFi orders can't be released until those orders are canceled or filled."}
      </p>
    </Modal>
  );
}

// The gateway's status, plus the exchange's: an allocation is tradable (a release is free) as soon as
// the exchange's transfer completes, typically within a second, while the gateway can take 20 s or
// more to confirm. So a move done on the exchange shows as credited (or debited) right away.
function MoveStatus({ m }: { m: CustodyMove }) {
  const pending = isCustodyPending(m);
  const settled = isCustodySettled(m);
  const exchangeDone = m.exchange?.status === "COMPLETED";
  const label = pending && settled ? (m.kind === "allocation" ? "credited" : "debited") : m.status;
  const elapsed = (to: number) => Math.max(0, Math.round((to - Date.parse(m.createdAt)) / 100) / 10);
  const title = [
    exchangeDone && m.exchange?.doneAt ? `Exchange transfer completed after ${elapsed(Date.parse(m.exchange.doneAt))}s` : m.exchange ? `Exchange transfer: ${m.exchange.status}` : undefined,
    pending ? `Gateway status: ${m.status}` : `Gateway marked ${m.status} after ${elapsed(Date.parse(m.updatedAt))}s`,
    m.failureReason,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
        settled && m.status !== "rejected" && m.status !== "stranded" ? "bg-buy-soft text-buy" : m.status === "rejected" || m.status === "stranded" ? "bg-sell-soft text-sell" : "bg-accent-soft text-accent",
      )}
      title={title}
    >
      {!settled && <LoaderCircle size={10} className="animate-spin" />}
      {label}
      {pending && (
        <span className="font-normal normal-case">
          {settled ? "· gateway confirming" : `· ${Math.max(0, Math.round((Date.now() - Date.parse(m.createdAt)) / 1000))}s`}
        </span>
      )}
    </span>
  );
}

function Moves({ moves }: { moves: CustodyMove[] | undefined }) {
  if (!moves?.length) return <Empty>No allocations or releases yet.</Empty>;
  return (
    <div className="h-full overflow-auto">
      {moves.map((m) => (
        <div key={m.id} className="flex h-9 items-center gap-3 border-b border-line/60 px-3 text-xs">
          {m.kind === "allocation" ? <ArrowUpFromLine size={13} className="text-info" /> : <ArrowDownToLine size={13} className="text-accent" />}
          <span className="w-16 text-muted capitalize">{m.kind}</span>
          <span className="num w-28 text-right">{qty(m.amount, 6)}</span>
          <span className="w-14 font-medium">{m.symbol}</span>
          <MoveStatus m={m} />
          {m.failureReason && <span className="truncate text-[11px] text-sell">{m.failureReason}</span>}
          <span className="ml-auto text-[11px] text-faint">{ago(Date.parse(m.updatedAt))}</span>
        </div>
      ))}
    </div>
  );
}

