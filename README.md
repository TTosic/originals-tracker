# Originals Tracker

A browser overlay that tracks **provably-fair Originals games** and shows live stats beside the board — hit history, true odds, hot/cold, multiplier tallies, and a retrospective seed checker.

Supported today:

| Game | Sites |
|------|-------|
| Keno | Winna, Stake |
| Plinko | Winna |
| Mines | Winna (calculator), Stake (tracker) |

The panel docks next to the game, themed to look native to each casino. Everything runs locally in your browser — no account, no login, no server.

> **Not affiliated with any casino. This is a record-keeper, not a predictor.** Every provably-fair round is independent; past draws tell you nothing about future ones. The tracker only reports what already happened (exact hypergeometric odds, z-score hot/cold, and a seed checker that *replays an already-rotated seed* for verification). It never claims to predict a live seed.

---

## Install (Chrome, Edge, or Brave)

This extension is distributed here as an unpacked folder — you load it directly, no store needed.

1. **Download it.** Click the green **Code** button above → **Download ZIP**, then unzip it somewhere permanent (e.g. `Documents\OriginalsTracker`). Don't run it from your Downloads folder — if you delete that folder the extension breaks.
   *(Or, if you use git: `git clone` this repo.)*
2. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode** (toggle in the top-right).
4. Click **Load unpacked** and select the unzipped folder — the one that contains `manifest.json` directly inside it.
5. Open a supported game. The panel appears beside the board.

That's it.

### Notes

- **Keep Developer mode on.** Turning it off disables all unpacked extensions.
- On startup Chrome may pop up *"Disable developer-mode extensions."* Just click the **X** to dismiss it — do **not** click Cancel/Remove.
- The extension only runs on the casino domains listed in `manifest.json`. It can't see any other sites.

## Updating

1. Download the new ZIP and unzip it **over the same folder** (replace the old files).
2. Go back to your extensions page and click the **↻ refresh** icon on the Originals Tracker card.

## Uninstalling

Extensions page → **Remove** on the card. Your saved configs live in the browser's local extension storage and are removed with it.

---

## What it does

- **Save number/tile sets** and watch them light up the instant they hit — or come close.
- **Live draw tracking** counting every nonce 1:1 under manual, instant, and autobet.
- **True odds** per set (exact hypergeometric) and a per-multiplier hit/miss tally.
- **Hot / cold** heat map with a z-score middle band marked "statistically normal."
- **Board glow** ringing your picked numbers as results land.
- **Seed checker** — after you rotate your seed, replay the retired seed to see where each saved set *would have* landed next (nonce, multiplier, bets-till-hit). Purely retrospective and deterministic.
- **Export / import** your configs (site-agnostic).

## Privacy

No telemetry, no network calls of our own, no accounts. All state is kept in your browser's local extension storage on your machine.

## Building from source

There's no build step. It's plain JavaScript content scripts loaded straight from `src/` — what you see is what runs. `node --check` is the only tooling used on the JS files. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the architecture.
