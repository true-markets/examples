# CeFi Console

A starting point for a web UI that watches and steers an automated trading strategy on the True Markets CeFi exchange. It streams your orders, fills, the order book and the trade tape over the CeFi WebSocket, and lets you act: cancel or modify one order, cancel everything in a symbol, cancel everything everywhere, and move wallet funds into and out of CeFi.

It runs out of the box against a built-in simulator, so you can see it working before you plug in a key.

> [!WARNING]
> - **With an API key, every action is real.** Orders, modifies, cancels, allocations and releases go to the live exchange. There is no test mode in production; set `TM_ENV=uat` to point at the UAT sandbox instead.
> - **Run it on your own machine only.** The server holds your API key and has no login. It listens on 127.0.0.1 by default. `API_HOST` in `.env` changes that: a LAN address such as `192.168.1.20`, or `0.0.0.0` for every interface, lets other devices on your network open it (`npm run dev` serves the web app on that address too, on port 5181). Anyone who can reach that address can trade with your key, so put your own access control in front of it.

## What's on the screen

One quoter runs every book, all on one shared view of the account's balances. The quoter bar along the top shows its mode, its connections and, on the right, the rate limit: new orders and modifies sent in the last second and the last minute against `ORDER_RATE_LIMIT` and `ORDER_RATE_LIMIT_PER_MIN` (each with a meter that turns amber at 70% and red at 90%), the busiest second in the last minute, and how many times the quoter hit the exchange's limit anyway, with the requests refused and when it was last hit. Books and shared balances run the full height on the left and always show. On the right are the All books and Activity bars, then the book you pick, or the breakdown one of the bars opened in its place; picking a book closes the breakdown. The instrument is shared with the trading view: pick a book here and the trading view shows it, and an instrument picked there shows here when the quoter has a book for it. The quoter's stop buttons sit in the header on both screens, to the right of the cancel buttons: **Stop and pull <base> quotes** for the selected book and **Stop and pull all quotes** for every book. Stopping keeps the quotes pulled, where a plain cancel would see the quoter put them back on its next cycle. So while the quoter is quoting a book, the cancel buttons leave its orders there alone: they count and cancel only your other orders (told apart by the quoter's client order id prefix, `cq` by default), and they hide when the quoter's quotes are all that's resting. Once a book is stopped, anything it left behind counts as an ordinary order again.

On a phone (anything under 768px wide) both screens show one pane at a time. The bar keeps the menu, the Trading / Quoter switch, the connection dot and, when there's a quoter, **Stop all**. The menu (☰) lists the screen's panes, then the actions that sit in the desktop header (stop a book, stop all, cancel orders, the sim strategy) and the display settings (units, help, theme). On the trading screen the market bar shrinks to the book picker with its bid and ask, and a **Markets** pane lists every book's tile one under another, with your order totals above them (tap a tile to open its book); clicking a price in the book opens the ticket, and clicking a fill opens its order. On the quoter screen the desk panes (overview, books, balances, trades, open PnL, all-books parameters) come first, then the selected book's panes; its ladder stacks asks over bids like an order book. To open it from your phone, set `API_HOST` (see above).

| Area | What it shows | What you can do |
| --- | --- | --- |
| **Quoter bar** | LIVE / UAT / PAPER, the number of books, and the health of order entry (REST or FIX), the drop copy, market data and the reference | Start all (production asks first); **Help** hides the explanations; **Parameters**, on the far right, opens the all-books editor in place of the selected book |
| **Books** | How many books are quoting and the orders they have resting, in the title bar; then every book with its state, orders, position and PnL, and how much of its bid and ask budgets are in use (colored as on the Budget card) | Pick one to see it; add a book from those the exchange offers, then choose its reference sources in an editor that previews them live |
| **Shared balances** | Per asset, in USD with the quantity under it: **Balance** (your CeFi balance the quoter can use), **Trading** (held by the quoter's orders), **Unused** (left for new orders), and **Other orders** when orders the quoter didn't place hold some. Totals on top | Sort and filter by any column, as in the trading view's tables |
| **All books** | Across every book: PnL (realized and open), volume, and edge at fill with its +30s and +300s mark-outs | **bps / $** shows edge, mark-outs, the spread and each quote's distance from the mid in bps or in dollars, across the screen (parameters stay in bps); **Open PnL** opens what makes up the open PnL in place of the selected book: each book whose position counts, with its position, average cost, mark (the reference mid), move from cost in bps and open PnL, then what adds nothing to it and why: flat books, books with no reference price yet, and holdings outside the books (in the account before a book started, or traded by hand) |
| **Activity** | Across every book: requests, fills (with takes and rejects) and the maker share of fills. **Reset rejects** (shown once there's something to reset) starts every book's reject, error and rate-limit counts from zero | **Trades** opens edge retention by book and every trade across the books, in place of the selected book. One breakdown is open at a time; close it, or pick a book, to get the book back as you left it |
| **Quoter settings** | Above the all-books grid: the quoter-wide settings, so far its order rate limits per second and per minute | Edit and **Apply**; they take effect at once and the quoter saves them, over its .env |
| **Parameters · all books** | Every book's parameters in one grid, one row per book; pick the columns with **Columns**. Changed cells show in amber (hover for the old value), invalid ones in red | Edit any cell, or use the top row on the ticked books: **=** sets a value, **+** adds to each book's own, **×** scales it. A size column whose books read sizes in different units (one in USD, one in BTC) only takes ×. **Apply** sends each changed book its own changes (production asks first); a book that rejects its changes keeps them in the grid to fix |
| **Trades** (from the All books bar) | Every fill this run: side, maker level or which taker, price, notional, fair value at the time, edge at fill, the +30s and +300s mark-outs, and how much edge was kept. A summary per book above it, with all books on its toolbar | Sort and filter by any column, as in the trading view's tables; drag the divider between the two |
| **Book bar** | Quoting, waiting (with the reason, e.g. "reference feed silent") or stopped, and the book's reference | Start quoting (production asks first), Remove a stopped book with nothing resting |
| **Book cards** | Three pairs: Prices and Reference sources, Position and Taking, Budget and Activity. Each pair sits side by side when there's room, and folds into one card with tabs when there isn't, so the screen needn't be wide. The cards fill their pane and scroll inside it, so they keep their height whichever tab shows | Pick a tab; it's remembered. Drag the divider under the cards to give them more or less room |
| **Prices** | The reference price and its age, the mid after inventory skew, the exchange's best bid and ask, and how far each sits from the reference mid in bps and dollars | |
| **Reference sources** | Each source in the book's blend: its price lined up by its multiplier, its share of the price, and any that's left out or looks like a split or multiplier. Under them, the exchange's own reference price for the book (from its instrument list), how far ours is from it, and the price band around it outside which the exchange rejects orders | **Edit…** changes sources, weights and multipliers, previewing each change against live prices before it's saved |
| **Position** | The change in holdings (bought minus sold) since the date shown, against the max position change, average cost, realized and unrealized PnL, volume. Carried across quoter restarts | **Reset** starts the position, PnL and counts from zero |
| **Taking** | Each side: the price a take would cross to and its size, the edge on offer against the edge needed (as a bar), and what's in the way: off, no edge (and how many bps away), below cost, too small, no funds, cool-down | |
| **Budget** | What this book's bids and asks hold, out of what they may hold, with the share in use: green, yellow from 75%, red above 90% (the next order on that side may not fit), and the shared free balance | |
| **Activity** | Creates, modifies and cancels sent, fills, rejects, takes (IOCs crossing the spread) sent and filled, the maker share of fills (resting orders hit, not takes), how many order changes were modifies, and how many times this book's requests hit the rate limit (with the requests refused). **Reset rejects** clears this book's reject, error and rate-limit counts | |
| **Ladder** | Each level's target next to the order resting there, with an arrow while a modify is in flight, and in the header the spread between the ladder's own best bid and ask, in bps and dollars. Before you start, it previews what would be quoted | |
| **Parameters** | Every strategy setting for this book, with its unit and what it does, including the profit taker and takeout switches under Taking | Edit any of them and press Apply; the book uses them on its next cycle, and the quoter saves them |
| **Events** | Fills, rejects, parameter changes and connection changes as they happen; the next tab is this book's trades, with the same columns as the all-books list | Sort and filter the trades |

The browser reads `/api/quoter/*` on this server, which calls the quoter (`server/quoter.ts`). If the quoter isn't running, the screen says so and how to start it.

## Tables

Orders, Fills and Balances share one table component (`web/src/table/DataTable.tsx`) on TanStack Table:

- **Filter any column** from the funnel in its header. The filter depends on the column:
  - **Numbers** (price, quantity, notional, % filled, USD values): a lower bound (`>` or `≥`), an upper bound (`<` or `≤`), or both for a band, e.g. price > $200 and < $210.
  - **Few distinct values** (symbol, side, type, status, event): multi-select with live counts.
  - **IDs** (order id, external id): partial, case-insensitive search. `%` and `_` act as wildcards.
  - **Times:** within the last N minutes.

  Active filters show as chips above the table; click one to edit it, or **Clear all**.
- **Columns** (top right of each table): tick to show or hide, and move up or down. You can also drag a header to move it, drag its edge to resize, or double-click the edge to reset its width.
- **Saved per browser:** column visibility, order, widths and sort go to `localStorage` per table. **Reset to default** in the Columns menu puts them back. Filters aren't saved, so a reload never silently hides orders.

Orders and Fills are queried with **TanStack DB** (`web/src/db.ts`). The stream store mirrors each order and fill into a collection once per frame, with numeric copies of the decimal fields (`priceN`, `qtyN`, `filledPct`...) so ranges compare numbers. The table's filters, tab and search become the `where` of a live query (`web/src/table/filters.ts`), so as DROPCOPY updates arrive only the changed orders are re-evaluated. TanStack Table still does sorting, paging, column layout and selection. Balances is small and comes from REST, so TanStack Table filters it directly with the same filter rules.

## How it works

```
browser ──/api, /ws──▶ this server ──REST──▶ api.truex.co/v1/cefi          (orders, balances)
                          │         ──REST──▶ api.truemarkets.co/v1/gateway  (wallet balances, allocations)
                          │         ──WS────▶ wss://api.truemarkets.co/v1/cefi/market
                          └─ holds the API key, mints tokens, signs every request
```

The browser never sees a credential. It talks only to this server, which:

- **Mints tokens** (`server/tm/auth.ts`): signs `{key_id}.{timestamp}` with ES256 (raw `r||s`, base64url) and posts it to `POST /v1/auth/api-key/token`, then mints again two minutes before expiry.
- **Calls REST** (`server/live.ts`): CeFi calls carry `Authorization: Bearer` and a fresh `x-truex-auth-timestamp`; list reads are unwrapped from the `{ data, pagination }` envelope.
- **Relays the WebSocket** (`server/relay.ts`): each browser socket gets its own exchange connection. The browser sends plain `{ type, channels, item_names }`; the server adds `timestamp`, `key`, `organization_id` and a signature over `timestamp + "TRUEXWS" + key + "/v1/cefi/market"` right before sending, and fills in your client id for `DROPCOPY`. Exchange messages are passed through untouched, so the browser parses the real wire format (`shared/wire.ts`).

In the browser, `web/src/feed.ts` keeps a desired set of subscriptions, fills in whatever the exchange's confirmations show is missing, re-sends everything after a reconnect, subscribes to `HEARTBEAT`, and treats 30 seconds of silence as a dead line. `web/src/store.ts` folds messages into state and redraws at most once per frame:

- **Orders**: seeded from `GET /orders` (last 24h) and `/orders/active`, then kept current by `DROPCOPY`. Each update replaces the order only if it is newer (`shared/orders.ts`), so a slow REST page can't roll back a fill. After a reconnect the REST list is read again to catch anything that finished while disconnected.
- **Book**: `DEPTH` snapshots replace the book and updates carry only changed levels, with `qty: "0"` meaning the level is gone (`shared/book.ts`). A skipped `seqnum` asks for a fresh snapshot, at most once every 5 seconds per symbol.

### Which API backs which button

| Action | Call |
| --- | --- |
| Cancel one | `DELETE /v1/cefi/orders/{id}` |
| Modify | `PATCH /v1/cefi/orders` with `new_qty` (the order's new total) and `new_price` |
| Cancel all in a symbol | No single call exists, so the server reads `GET /v1/cefi/orders/active`, filters by instrument, and cancels each, five at a time |
| Cancel all everywhere | `DELETE /v1/cefi/orders/all` ([docs](https://docs.truemarkets.co/api/institutional/cancel-all-orders-cefi/)) — asynchronous; the cancels show up on DROPCOPY |
| New order (CeFi) | `POST /v1/cefi/orders` |
| New order (DeFi) | `POST /v1/gateway/orders` with `venue: "defi"` for a quote and payloads, then `POST /v1/gateway/orders/{id}/execute` with the signed payloads, then `GET /v1/gateway/orders/{id}` until it completes |
| Allocate / release | `POST /v1/gateway/custody/allocations` / `releases` ([docs](https://docs.truemarkets.co/api/gateway/create-allocation/)), then the UI polls the list every second until the move is `completed`, `rejected` or `stranded` |
| Balances | `GET /v1/gateway/balances` for wallet rows (`allocated` per listing) and `GET /v1/cefi/balances` for exchange balances and holds. Tradable is `balance + unsettled − order_hold − transfer_hold`, less the fee holds for USDC |

### DeFi orders

The ticket's **CeFi | DeFi** switch sends an order to the exchange's book or to the asset's DeFi listing. Each CeFi book's DeFi listing comes from the public asset catalog (`GET /v1/gateway/assets`), matched on `economic_asset_id`; today that is a Base or Robinhood-chain token for every active book. DeFi takes market orders only: a buy is sized in USDC to spend, a sell in the asset. The CeFi increments below don't apply to DeFi; the only limit is each token's on-chain decimals (from the catalog's `decimals`, 6 for USDC).

1. **Quote.** `POST /v1/gateway/orders` with the DeFi listing's `asset_id`, `venue: "defi"`, `type: "market"` and `qty_unit` `quote` for a buy or `base` for a sell. The gateway creates the order and returns a quote (what you pay, what you get, the fee, any `issues`) and the unsigned payloads. The payloads stay on the server; the browser sees only the quote. A quote with `Insufficient balance` has no order to execute.
2. **Execute.** If you confirm within 60 seconds, the server stamps each payload with the API key (the same key is registered on your wallet): an ECDSA P-256 / SHA-256 DER signature over the payload's exact bytes, wrapped as base64url JSON `{ publicKey, signature, scheme: "SIGNATURE_SCHEME_TK_API_P256" }` (`stampPayload` in `server/tm/auth.ts`), and posts them with `auth_type: "api_key"`.
3. **Follow.** The ticket polls `GET /v1/gateway/orders/{id}` until `complete` or `failed`, and shows the fill and the transaction.

Creating a DeFi order can free funds you had allocated to CeFi to pay for it; funds held by open CeFi orders are never used (the gateway answers `422 funds_allocated` instead). So asking for a quote can change your allocation even if you then cancel.

### Notes from the live feed

Things the exchange does that the spec doesn't spell out, all handled in the code:

- **One signed request at a time.** A signed `SUBSCRIBE` sent while an earlier one is still authenticating is refused with `Authentication already in progress`. The relay (`openFeed` in `server/live.ts`) sends one request, waits for its confirmation, then sends the next.
- **Subscription changes are rate limited.** A request for too many topics at once is cut short with `SUBSCRIPTION_CHANGE_RATE_LIMIT_EXCEEDED`. The UI subscribes `EBBO` for every symbol, but `DEPTH` and `TRADE` only for the symbol on screen, and refreshes instrument stats over REST. The feed client compares what it wants with each confirmation's `subscriptions` list and asks again, with backoff, for anything missing.
- **The first update repeats the snapshot's seqnum.** After a `DEPTH` snapshot with seqnum N, the first update is also N. Only a jump past the next number counts as a gap.
- **List endpoints page at 10 rows.** `GET /instruments`, `/assets` and `/orders/active` return `pagination.next_cursor`; pass it back as `timestamp`, with `size` up to 100.
- Depth levels carry `order_count`; the AsyncAPI spec calls the field `depth`. The code reads either.
- **The gateway confirms allocations late.** An allocation's exchange transfer finishes in about 0.2 s, but the gateway marks the allocation `completed` 2–27 s later (about 20 s typically, from 25 real allocations). The CeFi WebSocket has no balance or transfer channel to signal it, so while a move is pending the server reads the exchange's own transfers (`GET /v1/cefi/transfers`, a CeFi call outside the gateway's limit) once a second. A move shows as **credited** (or **debited**) the moment the exchange completes it, balances refresh then, and the gateway's own status follows as "gateway confirming".
- **Minimum increments aren't in the API.** Tick, lot and minimum notional depend on the price and are kept in `shared/increments.ts`, from the exchange's table. The ticket rounds USD amounts down to the lot and checks the tick and the $1 minimum before sending. One deliberate difference: the table gives a 0.01 lot for prices from $10 to $999.999, but the live exchange accepts 0.001 there (most open orders in that range use it), so the code uses 0.001.

## Building on it

- **Your strategy's own state.** Tag orders with `external_id` from your strategy (strategy name, leg, signal id) and it shows in the table and search. A column per tag is a few lines in `OrdersTable.tsx`.
- **Risk limits and alerts.** `store.ts` sees every order and fill as it happens; that's the place to compute exposure or fill rate and flag breaches.
- **More channels.** `AUCTION` and `INDEX` are typed in `shared/wire.ts` and pass through the relay already; add a `feed.want([...])` and a component.

## Project structure

```
server/
  index.ts       picks the live or simulated backend and starts the server
  app.ts         HTTP routes, input checks, cancel-by-symbol
  relay.ts       /ws: one exchange connection per browser socket
  live.ts        the True Markets backend: REST calls, WebSocket signing
  quoter.ts      calls a running cefi-quoter's management API
  tm/            key file, ES256 signing, token minting, errors
  sim/           the in-process exchange used by demo mode and the tests
shared/          wire types, API types, order and book logic used by both sides
web/src/
  feed.ts        WebSocket client: subscriptions, reconnect, heartbeat watchdog
  store.ts       live state and the hooks that read it
  api.ts         REST reads and actions (TanStack Query)
  db.ts          TanStack DB collections for orders and fills, mirrored from the store
  table/         the shared table: filters, column menu, resizing, saved layout
  components/    Orders, Book, Ticket, Trades, Balances, Header, Quoter
```

## Tests

```bash
npm test
```

The tests never touch the network: routes run against the simulator, and the live backend runs against a stubbed `fetch` that checks the exact URLs, headers, bodies and signatures it sends.
