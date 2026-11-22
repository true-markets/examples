# True Markets examples

Apps built on the True Markets APIs the way a client would build them. Each folder is a self-contained project with its own README, dependencies and setup.

- `starters/` hold the smallest working setup for one API, to copy and build on.
- `apps/` hold complete apps that show several APIs working together.

| Example | What it shows |
| --- | --- |
| [apps/tensho-wallet](apps/tensho-wallet/) | A neobank on the gateway APIs: sign up with embedded wallets, market buy and sell on Solana and Base, sends to external wallets, and activity |
| [apps/kumi](apps/kumi/) | A wealth-advisor app on the gateway APIs: each client gets a Solana wallet Kumi holds and a True Markets trading wallet, and market trades of SOL and other top Solana tokens move only the amount needed and send the proceeds straight back |
| [apps/cefi-console](apps/cefi-console/) | A monitoring and order-management UI for an automated CeFi strategy: live orders, fills, book and tape over the CeFi WebSocket, with cancel, modify, cancel-by-symbol, cancel-all, and wallet-to-CeFi allocation. Runs against a built-in simulator until you add a key |
| [apps/cefi-quoter](apps/cefi-quoter/) | A market maker in Go for any number of CeFi books from one process, all drawing on one shared balance ledger so books never spend the same funds. Each book quotes a ladder of post-only orders around a reference price (Coinbase for crypto, Hyperliquid for tokenized stocks), kept in place with modifies over REST or FIX, with orders followed on the WebSocket drop copy. Add, start and tune books live from the console's Quoter screen. Runs in paper mode against a simulated exchange until you add a key |

## Before you run one

You need a True Markets organization and an API key downloaded from the developer console. Each example says where to put it; keys stay on your machine and are never committed.

There is no sandbox. Wallets these examples create hold real funds, and a signer key that seats a funded wallet must be backed up, because losing it locks that wallet for good.

## Adding an example

Put it under `starters/` or `apps/` in its own folder with a README, its own dependencies and a `.gitignore` that keeps keys and local state out of git. Use public APIs only, and make its tests run without real keys or network access. Add its path to the matrix in `.github/workflows/ci.yml` (the `go` job for Go examples).
