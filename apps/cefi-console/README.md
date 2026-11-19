# CeFi Console

A starting point for a web UI that watches and steers an automated trading strategy on the True Markets CeFi exchange. It streams your orders, fills, the order book and the trade tape over the CeFi WebSocket, and lets you act: cancel or modify one order, cancel everything in a symbol, cancel everything everywhere, and move wallet funds into and out of CeFi.

It runs out of the box against a built-in simulator, so you can see it working before you plug in a key.

> [!WARNING]
> - **With an API key, every action is real.** Orders, modifies, cancels, allocations and releases go to the live exchange. There is no test mode in production; set `TM_ENV=uat` to point at the UAT sandbox instead.
> - **Run it on your own machine only.** The server holds your API key and has no login. It listens on 127.0.0.1; don't expose it.

## What's on the screen

| Area | What it shows | What you can do |
| --- | --- | --- |
| **Markets** | A tile per instrument: last, best bid/ask, 24h volume, how many of your orders are open there | Click to focus that symbol |
| **Orders** | Every order from the last 24 hours, updated live from DROPCOPY. Sorted by last update, newest first, so anything just modified, filled or canceled floats up and flashes. Filter by Open / Filled / Canceled, symbol, side, and free-text search on order id, external id or symbol; sort by any column | Modify price/qty, cancel one, cancel a selection, cancel all in the filtered symbol |
| **Book** | L2 depth for the focused symbol, 10/20/50 levels, with **your resting orders marked on their levels**: your size, how many orders, and what share of the level is yours. A footer counts any of your orders priced deeper than shown | Click a level to load its price into the ticket; cancel your orders at a level |
| **Ticket** | Size in USD (the default) or as a quantity, with a line saying exactly what will be sent. CeFi: limit or market, GTC or IOC, post-only (ALO); a USD market order uses the exchange's `QUOTE_QTY` flag, a USD limit order is converted at the limit price and rounded down. DeFi: a market swap on the asset's DeFi listing, with a quote to confirm first | Place an order (in live mode, CeFi asks for a second click; DeFi asks you to confirm the quote) |
| **Fills / Tape** | Your fills (REST history plus live DROPCOPY trades), and the public trade tape with your prints highlighted | Click a fill to focus its order |
| **Balances** | Each asset split between your wallet and CeFi: free in wallet, allocated, CeFi balance, held by orders, tradable. Per wallet listing (per chain) | Allocate wallet funds to CeFi, release them back; watch each move go through its states under **Moves** |
| **Header** | Connection health (heartbeat-backed), DEMO/UAT/LIVE badge | **Cancel all orders** (the exchange's own cancel-all) |

## Run it

Node 22 or newer.

```bash
npm install
```

```bash
npm run demo
```

Open http://localhost:5181. Demo mode runs a simulated exchange in the server process: market makers keep the books moving, and a stand-in "strategy" places, moves and cancels your orders so there is something to watch. Pause it from the header.

### Against True Markets

1. Create an API key at [app.truemarkets.co](https://app.truemarkets.co) (Settings, API keys) on an account enabled for CeFi trading. The browser downloads a JSON file with `key_id` and a P-256 `private_key`.
2. Move that file into `.secrets/`. Everything in that folder is gitignored. To keep it elsewhere, set `TM_API_KEY_PATH`.
3. `npm run dev`. With a key present the server runs live; without one it falls back to demo.

Optional settings go in `.env` next to `package.json`:

| Variable | Default | What it does |
| --- | --- | --- |
| `TM_MODE` | `live` if a key is found, else `demo` | Force `demo` or `live` |
| `TM_ENV` | `production` | `uat` points every call at the UAT sandbox hosts |
| `TM_API_KEY_PATH` | `.secrets` | The key file, or a folder holding exactly one |
| `TM_CLIENT_ID` | from the token | Your CeFi client id, if the token doesn't carry one |
| `TM_ORGANIZATION_ID` | from the token | Organization keys only, sent on signed WebSocket requests. A personal key doesn't need it |
| `TM_ACCOUNT_LABEL` | your email, from the token's `sub` claim | What the header calls your account. Without an email in the token it falls back to the CeFi client's mnemonic, or the client id when the mnemonic is an opaque hash |
| `API_PORT` | `4850` | The server's port; the dev web server proxies `/api` and `/ws` to it |

For day-to-day use, run the production build: `npm run build && npm start`, then open http://localhost:4850. It serves the UI and the API from one port, and React's production mode is several times faster than `npm run dev`, which is for editing the code.

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
  tm/            key file, ES256 signing, token minting, errors
  sim/           the in-process exchange used by demo mode and the tests
shared/          wire types, API types, order and book logic used by both sides
web/src/
  feed.ts        WebSocket client: subscriptions, reconnect, heartbeat watchdog
  store.ts       live state and the hooks that read it
  api.ts         REST reads and actions (TanStack Query)
  components/    Orders (TanStack Table), Book, Ticket, Trades, Balances, Header
```

## Tests

```bash
npm test
```

The tests never touch the network: routes run against the simulator, and the live backend runs against a stubbed `fetch` that checks the exact URLs, headers, bodies and signatures it sends.
