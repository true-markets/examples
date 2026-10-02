# True Markets examples

Apps built on the True Markets APIs the way a client would build them. Each folder is a self-contained project with its own README, dependencies and setup.

- `starters/` hold the smallest working setup for one API, to copy and build on.
- `apps/` hold complete apps that show several APIs working together.

| Example | What it shows |
| --- | --- |
| [apps/tensho-wallet](apps/tensho-wallet/) | A neobank on the gateway APIs: sign up with embedded wallets, market buy and sell on Solana and Base, sends to external wallets, and activity |

## Before you run one

You need a True Markets organization and an API key downloaded from the developer console. Each example says where to put it; keys stay on your machine and are never committed.

There is no sandbox. Wallets these examples create hold real funds, and a signer key that seats a funded wallet must be backed up, because losing it locks that wallet for good.

## Adding an example

Put it under `starters/` or `apps/` in its own folder with a README, its own dependencies and a `.gitignore` that keeps keys and local state out of git. Use public APIs only, and make its tests run without real keys or network access. Add its path to the matrix in `.github/workflows/ci.yml`.
