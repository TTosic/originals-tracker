# Originals Tracker — universal provably-fair game tracker

Chrome MV3 extension tracking provably-fair casino games (Keno on Winna +
Stake + Thrill; Plinko on Winna). No build step — plain JS content scripts;
the manifest composes each page from layered files that share one
isolated-world scope.

## Architecture (do not re-fork per casino)

```
src/
  games/<game>/engine.js      casino-agnostic game engine (state, panel UI,
                              math, hot/cold, export/import, popups, layout
                              shell, resize/drag) — ONE copy, all casinos
  sites/<casino>/
    <game>-adapter.js         site-specific: DOM selectors, draw detection,
                              docking, board painting, visibility, roles
    <game>.css                the casino's THEME (panels deliberately look
                              native to each site — never unify the look)
    net-hook.js               (only if the site needs MAIN-world fetch/XHR
                              sniffing, e.g. Stake)
manifest.json                 per-casino content_script entries load
                              [adapter, engine] in that ORDER (adapter first —
                              it publishes window.__KT_SITE; engine reads it)
```

### Rules
- **Game logic, math, UI structure → `games/<game>/engine.js`.** A feature or
  bugfix lands once and every casino gets it.
- **Anything that touches the site's DOM or network → the adapter.** A new
  casino must cost ~300–600 lines of adapter + a theme CSS, nothing more.
- **Theming is per-site CSS only.** Same class names (`kt-*`) everywhere, very
  different look per casino — that is intentional (user requirement).
- **Storage keys are namespaced per site+game** — the extension shares one
  `chrome.storage.local`; keys must never collide. In use: `kenoTrackerState`
  (winna keno, legacy name), `kenoTrackerBridge` + `kenoTrackerCmd` (winna keno
  iframe bridge), `stakeKenoTrackerState`, `plinkoTrackerState` +
  `plinkoTrackerBridge` (winna plinko). Future: `<site><Game>TrackerState`.
- Engine HTML element ids the engine relies on: `#kt-nt` (nonces), `#kt-cf`
  (configs), `#kt-ld` (last draw), `#kt-selection-nums`, `#kt-status` (toast,
  sibling of `.kt-body`, NOT inside it), `.kt-resize`, `.kt-heat`/`.kt-heat-n`.

### Adapter contract (`window.__KT_SITE`)
| Member | Purpose |
|---|---|
| `id`, `storageKey`, `dockW`, `floatW` | constants (exportTag is dead — exports are site-agnostic, tag `originals-keno-tracker`) |
| `attach(E)` | receives the engine API (stored in adapter closure) |
| `init()` | wire roles, draw sources, intervals, visibility (after state load) |
| `gameActive()` | on the game page right now? (gates heat paint etc.) |
| `readSelection()` | current picks as sorted board labels |
| `dockLayout()` | position `E.getRoot()` when docked (float is engine-owned) |
| `paintBoard(h)` / `unpaintBoard()` | tint real tiles from `h.hues` ([hue,sat,light] per number) |
| `onHistoryReset()` | optional: clear adapter draw-tracking state |
| `classifyTiles()` | optional: replace board reading wholesale (Thrill: shadow DOM + SVG tiles) |
| `readPaytable()` | optional: replace the paytable scrape (Thrill: plain "10x", shadow DOM) |
| `glowBoard(items)` | optional: ring tiles per hit config (`items` = [{nums, color}], priority-sorted, gold first). ADDITIVE box-shadow rings, never background fills. Multiple hit configs CYCLE — one config's numbers/colour on the board at a time, ~1.6s per phase, looping (simultaneous multi-colour rings, segments and dots were all tried and read poorly). Persists for the whole nonce; the engine calls again on the next draw to replace/clear. Enabled on all three keno sites incl. Thrill. The glow normally clears at the next bet, but a MANUAL board clear (Clear Table / a manual↔auto switch) has no next bet — so each adapter runs `idleClearGlow(revealedCount)` from its board tick: when no REVEALED result tiles remain (hit ∪ miss === 0) for a ~400ms debounce, it drops the glow. Keyed on revealed tiles because that's the reliable "result is on the board" signal cross-site — the MISSES read everywhere (Stake `is-revealed`, Winna `revealed`, Thrill `tile-lost`) even though the HIT tiles don't (Winna win art, Thrill gem art) — and it matches the user's rule "glow only while there are hit/result tiles". Gated on an active glow + debounced so the brief inter-bet board wipe on autobet can't flicker it off (autobet's per-bet clear still comes from bet-start). |

Engine API (`E`): `state`, `persist`, `log`, `esc`, `classifyTiles`,
`boardSelection`, `updatePaytableFromDOM`, `getPaytables`, `mergePaytables`,
`processDraw`, `nextDomNonce`, `saveCurrentSelection`, `hotkeyMatches`,
`onKeyDown`, `buildShell`, `getRoot`, `render`, `scheduleRender`,
`refreshDynamic`, `updateSelectionDisplay`, `flashStatus`, `toggleOpen`,
`heatHues`, `syncBoardHeat`, `layout`, `scheduleLayout`, `setStyle`,
`navBottom`, `boardRect`, `clampW/H`, `effectiveW/H`.

## Site-specific knowledge (hard-won — don't regress)

### Winna (`sites/winna/`)
- Keno runs in a **cross-origin iframe** (games.winna.com). Roles: `reader`
  (iframe), `panel` (top page), `combined` (same frame). Communication over
  **chrome.storage** (`kenoTrackerBridge`/`kenoTrackerCmd`) — NEVER
  postMessage (winna logs "Unknown message type!" for foreign messages).
- **Net is authoritative once seen** (`keno-net-hook.js`, MAIN world): the
  "play" REST response carries `{id, multiplier, data:{tiles[10],
  user_tiles, risk}, betUuid}` — numbers **0-indexed** (+1 shift, proven by
  0s in live data). No nonce (synthesised, deduped on betUuid/id). The
  hook also emits `__kt_net_req` the moment the bet REQUEST leaves (devtools
  "pending") — THAT is the **bet-start signal** (clears glow/notification at
  the user's click; the response repeats it as backup) — the DOM gives no
  early signal on no-turbo autobet (nothing changes until the reveal
  animation ends). `netOwnsCounting` = `netSeenEver`, NEVER the
  `data-kt-nethook` marker (the plinko hook also marks it on winna pages);
  the keno hook forwards any `/play`, `validDraw` shape-checks (this is also
  what keeps plinko's /play responses out).
- **Net reveal-sync (proven live — don't regress)**: on no-turbo autobet the
  response arrives while the OLD reveal is still displayed, the board then
  clears tile-by-tile (~3s) and reveals (~3s), and winna rebets instantly at
  reveal end. Consequences: (a) classify can NEVER see a hit tile after it
  flips (the win art replaces the tile's number text and classify skips
  non-numeric tiles — yet the `revealed` class-add mutation fires at the
  flip while the text is still numeric, which is why the clear phase removes
  10), so the board triggers are **exact** (classify hit∪miss === draw,
  hit-free draws) and **mut-exact** (mutation-maintained `revealSet` ⊇ draw
  with `revealCount` === 10 — fires at the last tile's visual flip); the
  release check MUST run from the mutation observer at the 10th flip
  (`netRevealCheck`), not just a poll — with instant rebet the settled board
  lives < one 50ms tick (proven: count hit 10 and was wiped between polls on
  every mid-run bet). A flipped tile may gain `revealed` OR only `isHit`,
  and its number text is already win art by callback time → resolve via the
  `tileNumByEl` element cache. `checkDrawFromDOM` must NOT rebuild
  `revealSet` from classify in net mode (it would wipe mutation-captured
  hits). Looser triggers all failed live (misses-shown → fired before hits
  flipped; +stillness → never fired, lagged a bet; +timed estimate → early
  or late); (b) NEVER use a "10 shown ≠
  response-time snapshot" trigger — it matches the OLD reveal still
  displayed when the response arrives and releases early; (c) the
  **order-flush** releases a still-pending draw when the next bet's response
  arrives (proves it settled — keeps autobet in lockstep if exact misses);
  (d) the cap is 9s (clear+reveal cycle outlasts 4s) and only matters for
  the last bet of a run; (e) bet-start clears glow/notification
  UNCONDITIONALLY — a "keep them if the result showed <1.5s" grace was tried
  and the user rejected it (glow lingering through the whole next draw reads
  worse than a brief flash). The reader relays the revealed-tiles sig over
  `bridge.rs` so a board-less frame could still time releases.
- DOM draw counting stays primary until the first net draw: tiles get class
  `revealed`; MutationRecords with `attributeOldValue` catch paid bets that
  skip the reveal animation (state lasts <1 frame). Tiles:
  `button.field-button` + `selected`/`revealed`/`isHit` classes.
- Board heat paint: an injected **CSS rule** gated on the tile having no state
  classes (`.field-button:not(.selected):not(.revealed):not(.isHit)
  .field-button__surface[data-kt-heat] { background-image: var(--kt-heat) }`),
  with the colour in a per-tile `--kt-heat` custom property. NEVER toggle the
  tint from JS per state change — the CSS engine swaps tint⇄game-colour
  atomically with the class change; JS toggling flickered on turbo and left
  tiles colourless behind a repaint cooldown. The `data-kt-heat` marker also
  excludes the tinted element from every colour read path.
- Nonce = locally counted, sequential.
- classifyTiles: `.field-button` markup counts as an exact dialect even with
  ZERO state classes (idle board) — it must NOT fall through to colour
  classification, which would read our own heat tints as game state.

### Stake (`sites/stake/`)
- Keno is always **top frame** (combined only). `net-hook.js` (MAIN world,
  document_start) wraps fetch/XHR, gates on keno *requests* (excludes the
  global bet feed), forwards responses via `__kt_net_payload` CustomEvent and
  SPA navigations via `__kt_nav`; marks `<html data-kt-nethook="1">`.
- **Network is the only counter when the hook is present** (`netOwnsCounting`)
  — DOM counting double-counts/misses under instant+autobet. Response carries
  NO nonce (synthesised sequentially, deduped on bet `id`) and numbers are
  **0-indexed** (`shiftNums`/`calibrateOffset`).
- Reveal sync (`whenNewReveal` + rapid/instant short-circuits) keeps the panel
  from spoiling results before the board paints; see comments in the adapter.
  An **order-flush** (`pendingRelease`, like Winna's) releases a draw still
  waiting on its reveal the instant the next bet's response arrives: without
  it, instant bets spaced just over `INSTANT_RATE_MS` (board flashes the
  result sub-poll) left releases pending that later fired on a NEWER bet's
  board, counting several bets behind with a stale glow that "caught up" one
  bet at a time.
- Tiles: `button.tile` with `data-selected` + `data-game-tile-status` attrs.
- **Selection: NEVER interpret tile flags while a result is showing or in
  flight** — Stake puts `data-selected` on drawn-but-unpicked tiles during/
  after reveals (misses then read as picks or even hits; three filter attempts
  all leaked). The rule that works: hold the last selection through the whole
  result phase (`revealPhaseUntil` covers the response→reveal gap where tiles
  read unrevealed but already carry bogus flags), and sync the held value from
  the bet response's **`selectedNumbers`** (server truth, index-shifted) on
  every bet. Clean frames (board fully cleared) read normally.
- Board heat paint: **inject `.kt-heat-overlay` divs** — never restyle Stake's
  `.cover` face (breaks selected look, shows duplicate numbers). CSS hides
  overlays on hover/selected/revealed. Anything we inject into the game DOM
  must be excluded from every read path (tileFill etc. skip the overlay).
- Page check: `/casino/games/keno` on the stake.* mirror domains.

### Thrill (`sites/thrill/`)
- Board is either in the **top frame or an iframe** — roles like Winna's
  (reader/panel/combined) PLUS a panel→combined **promotion** when SPA nav
  mounts the board into the top frame. Much of the page is **shadow DOM**: all
  queries go through `qsaDeep`/`qsDeep` (shadow-piercing).
- Tiles are **layered SVGs** flagged with data-testid (`tile-idle-base`,
  `tile-active-overlay` = pick, `tile-lost` = miss) inside `keno-tile-N`
  button containers. A DRAWN pick swaps to gem art and its number label
  VANISHES — hits are inferred (cached tile map + missing-label while ≥3 lost
  tiles show). See `classifyTilesThrill`. **Detector gate must use the
  `keno-tile-` containers** — at the 10-pick limit thrill re-renders all
  unselected tiles WITHOUT `tile-idle-base`, so gating on the idle layer
  collapsed detection exactly at 10 picks.
- Net: REST, URL ends `/bet`; response `{data:{roundId, result[10], …}}`. No
  nonce (synthesised, deduped on roundId); numbers proven 1-indexed by
  `calibrateOffset`. The hook forwards generously (any `/bet`); `validDraw`
  shape-checks before counting. **DOM counting stays primary until the first
  net draw** (`netSeenEver`), then the network owns the count; the handover
  bet is deduped against `domDraw.lastSig`.
- Reveal sync: misses are the primary done-signal (gem art makes hits
  unreadable mid-reveal); cap 1500ms; first check synchronous.
- Selection: grow-adopts (a number the user adds is taken immediately), holds
  through reveals, 2s empty-debounce (end-of-reveal can blank the board >1s).
- Board heat paint: **DISABLED on purpose** (user decision — tints fought the
  game's tile styling during reveals). The popup's Board toggle is layout-only;
  `paintBoard` broadcasts an unpaint. The paint machinery is kept in the
  adapter solely for clearing stale tints; if ever re-enabled, it must be
  **inline CSSOM styles** (`el.style.*`) — Thrill's page CSP blocks injected
  stylesheets — with the painted-element REGISTRY for unpainting.
- Gem testid is unverified (gemVisible() heuristics: testid containing
  gem/diamond/hit/win, or an img) — hit reads lean on the missing-label
  inference; verify on a live winning draw if hit detection misbehaves.
- Toggle button docks next to the **favourite (heart) button** — gated hard on
  `kenoActive()` because that heuristic matches every game's toolbar. It copies
  the heart's `className` (see the toolbar-toggle convention below).
- Reader relays the board RECT + its viewport (`bridge.br`/`vw`/`vh`) so the
  panel can project the true board edge through the iframe box for docking.
- Paytable: plain "10x" multipliers (no decimal) — site `readPaytable`
  override; hit-count labels are bare digits so number+x is safe there.

## Adding a casino (e.g. how Thrill was done)
1. `src/sites/thrill/keno-adapter.js` — copy the closest adapter (Stake if the
   site is SPA + network-readable; Winna if iframe + DOM-revealed) and rewrite
   the site-specific parts: tile selectors/state markers, draw source,
   `dockLayout`, `gameActive` URL test, toolbar button slot, board paint.
2. `src/sites/thrill/keno.css` — theme it to match the casino (copy a CSS file
   as the starting skeleton; keep all `kt-*` class names).
3. `storageKey: "thrillKenoTrackerState"`, unique `exportTag`.
4. manifest: add host_permissions + a content_script entry
   `[adapter, engine]` (+ a MAIN-world net-hook entry if needed).

## Plinko (Winna-only today)
`sites/winna/plinko.js` + `plinko.css` + `plinko-net-hook.js` — a verbatim
import of C:\Project\WinnaPlinkoTracker, deliberately kept as a **monolith**
(engine+adapter in one file) until a second casino wants plinko; split it into
`games/plinko/engine.js` + adapters at that point, mirroring keno.

It is fully namespaced and collision-free with keno even though both run on
every winna page: guard `__plinkoTrackerContentLoaded`, root
`#plinko-tracker-root`, classes `pt-*`, storage `plinkoTrackerState` +
`plinkoTrackerBridge`, net-hook guard `__plinkoNetHookLoaded` + event
`pt-net-bet`, toggle `#pt-bottom-toggle`.
- **Extreme-risk 0x = a skull icon, NOT text.** Every multiplier-reading path
  must map the skull to "0x" or that landing is dropped: `multText` (board) and
  `historyResultText` (customHistory) both check
  `.skull-icon, img[alt="Skull" i]`; the network path uses `formatMult(bet.m)`
  (m=0 → "0x"). The history one bit us — empty text made `handleHistoryElement`
  bail on `!text`, skipping the 0x bet AND desyncing the queued net results. Role detection is mutually
exclusive: plinko activates on `.multiplier-label` boards / `/plinko/` paths,
keno on `.keno-field`/`.field-button` / `/keno/` — each takes ROLE "none" in
the other game's frames.

## Mines calculator (Winna-only)
`sites/winna/mines.js` + `mines.css` — NOT a tracker: Mines payouts are
deterministic, so this is a pure what-if **calculator** (no draw detection, no
nonces, no net-hook). Pick grid (25/36/49/64), mines, and gems → it shows the
cashout multiplier, win chance (and "1 in N"), and payout from the live Bet
Amount, plus a full per-gem ladder table. The panel shell mirrors keno/plinko:
dock-beside-game / pop-out-float (`⤢`), drag, resize handle (drag +
double-click reset), collapse (`▾`), and an in-game toolbar diamond toggle to
reopen. No title icon (just "Mines Calculator").
- **Math** (verified against winna's own 25-grid/3-mines ladder
  1.1136/1.2727/1.4636/1.6947): `mult = HOUSE · Π_{i=0..gems-1}
  (grid−i)/(grid−mines−i)`, `winChance = HOUSE/mult`, `HOUSE = 0.98` (flat 2%
  edge, solved from the ladder). Don't "fix" the multipliers — they're exact.
- **Live sync** via `composeBoard()` in the reader, merging three sources:
  - **mines**: the range **slider** (`input[type=range]`, max = gridSize-1 =
    24/35/48/63) is the live source during config AND play; falls back to the
    network `data.mines`, then revealed `mine mines-1` tiles. The DOM tiles
    HIDE the mine count during play, so the slider/network carry it — reading
    the slider is what makes mines count (and re-sync after a manual edit).
  - **grid**: the `.mine` tile count FIRST (tiles always reflect the CURRENT
    grid, so changing the real grid AFTER a bet is followed), network
    `data.gridSize` only as a fallback when no tiles are present. netGrid is the
    last PLAYED grid and never clears — preferring it froze the calc's grid after
    the first bet (real grid changes stopped propagating).
  - **gems**: count ONLY the player's own tiles — `mine autoBetPick` (placed
    picks) + `mine selected` non-mine (safe tiles THEY revealed); idle is
    `mine grey`; network `choices.length` as fallback. Critically this EXCLUDES
    the end-of-round full reveal: a bust/cashout flips every tile (a 25-grid/
    20-mines bust shows all 5 diamonds + 20 bombs), but those un-picked tiles
    carry neither class, so counting them was what made gems jump to
    gridSize-mines. `heldGems` tracks the round's PEAK engaged count (so a
    revealed pick shedding its marker, or the hit mine, can't drop it) and
    resets only when the board returns to all-idle (next round).
  `mines-net-hook.js` (MAIN world) forwards play/turn/finish (`__mc_net`,
  shape-checked on `gridSize`+`mines` so keno/plinko `/play` is ignored). The
  panel FOLLOWS the board on change (slider move / tile pick / game start
  drives the calc); manual stepper/chip edits persist until the board changes.
- **Cross-frame** like keno/plinko: the game + Bet Amount input live in the
  games.winna.com iframe (oversized/clipped), so the panel docks/floats on the
  TOP page (`panel` role) and a `reader` in the iframe relays bet + board over
  chrome.storage (`minesCalcBridge`); `combined` if the board is ever top-frame.
  The bet input is found heuristically (label "Bet Amount"→nearest input, else
  first money-looking input) and the panel's Bet field overrides it when typed.
- Fully namespaced: guard `__minesCalcContentLoaded` (+ `__minesNetHookLoaded`
  for the hook), root `#mines-calc-root`, classes `mc-*`, storage
  `minesCalcState` + `minesCalcBridge`, net event `__mc_net`, toggle
  `#mc-bottom-toggle`. Activates on `.mine`/`.mines-history`/`/mines/`; ROLE
  "none" elsewhere, so it can't collide with keno/plinko on shared winna pages.

## Adding a game
1. If single-casino: drop it in as a namespaced monolith under
   `sites/<casino>/<game>.js` (like plinko). Unique: window guards, root id,
   CSS class prefix, storage keys, net-hook event names.
2. When a second casino wants it: split into `games/<game>/engine.js` +
   per-site adapters, mirroring keno's SITE contract.
3. Games never run on the same page, so `window.__KT_SITE` can be reused per
   game — but if a casino ever hosts two games on one URL, namespace it
   (`__KT_SITE_PLINKO`).

## Verification (no test suite — manual, both sites)
After any engine change, on ALL keno sites (Winna, Stake, Thrill): panel docks
beside the board; selection updates live; Alt+S + Save config save; draws count
nonces 1:1 under manual, instant, and autobet; hits colour/flash rows (gold
when betting it); hit banner + board glow (multi-config = multi-colour, gold =
bet-hit); ⓘ odds popup (follows the CURRENTLY selected risk live); ★
multiplier tally popup (hit vs missed per multi); 🔥 hot/cold popup
(Ranked/Board views, window chips, board painting on/off — paint winna+stake
only, glow everywhere); Sort chips (Manual/Hit/Size — drag only in Manual);
export/import (site-agnostic tag, import resets stats+nonces); drag-reorder
with drop line; resize handle (drag + double-click reset); pop-out float drag;
collapse; clear/reset confirm dialogs; panel hides instantly when leaving keno.

## Misc
- **In-game toggle button (reopen the panel) — shared convention across all
  sites/games.** One faceted-gem OUTLINE icon (`TOGGLE_SVG`, fixed 22px,
  `fill:none; stroke:currentColor`) so it inherits the toolbar button's text +
  hover colour. **No tooltip** — removed on every site (matching each native
  tooltip per-site was endless fiddling and the gem is self-explanatory). To
  look native the button takes a toolbar-button `className` + inline
  `display:inline-flex` centering — never `all:unset` (looked foreign). Per
  site (geometric row-scans were unreliable — the oversized/clipped game iframe
  broke absolute-position checks):
  - Winna keno/plinko/mines: the game toolbar is on the TOP PAGE (the board
    iframe ends ABOVE it), so the PANEL docks it (not just the reader) — both
    call `ensureBottomButton`, only the frame with the toolbar acts. Anchor on
    the unique **"Fairness" button** (`fairnessSection()` → its `<section>`),
    then pick the icon cluster = the `items-center` div with the most small
    `text-typography-secondary` square buttons. Use a FIXED `TOOLBAR_BTN_CLASS`
    (the known icon-button utilities) — NOT a copied sibling's class, which was
    inconsistent across refreshes (sometimes caught a bordered/active state).
    `onToggleClick`: reader relays over the bridge, panel/combined toggle
    DIRECTLY (the toggle lives in the panel's frame now). Float fallback is
    COMBINED-only.
  - Stake: a footer ICON button (`svg`, no text, ≤80px) is the style/anchor REF.
    **Do NOT copy its className** — Stake's class-based hover lit up the real
    popout button when the gem carried it. Mirror the native look with a SHORT
    explicit reset (NOT `all:unset` — that serialises into a monstrous inline
    style of every longhand): transparent bg, the ref's computed colour (saved
    as `data-rest-color`), `rounded-sm`, its footprint. Stake icons have **no
    hover background** (`hover:bg-transparent`) — only colour changes, so
    `ensureToggleStyle` injects ONLY
    `#kt-bottom-toggle:hover{color:var(--ds-color-on-surface)!important}` (a bg
    fill there = the "big box" bug); `setToggleActive` holds that white inline
    while open. **Dock the gem OUTSIDE Stake's icon group** — parent it to the
    group's HOST (one level up), `position:absolute`, at the popout button's own
    right edge via bounding rects (anchor on the ref's rect, NOT the group box —
    the group's padding drifts it; gap = the REAL inter-icon gap measured off the
    last two icons, since the row uses margins so `columnGap` reads "normal"),
    host set `position:relative` if static. Two reasons it must be outside, not a child of the group:
    (1) **tooltip keep-alive** — Stake keeps a tooltip visible while you hover
    ANYTHING inside the icon group, so a gem that's a child of it showed the
    neighbouring "Open Mini Player" even with no shared class; outside the group,
    hovering the gem reads as "left the group" → tooltip hides. (2) **geometry**
    — an in-flow gem widened the group's box, which Stake's tooltip popper clamps
    to, shifting every native tooltip right (confirmed live: deleting the gem
    re-centred them); out-of-flow keeps the group's box byte-for-byte.
    Re-create the gem if it was a float (`position:fixed`) before docking, or
    its float styles leak.
  - Thrill: the favourite heart (`aria-label*=favorite`), copy its class, force
    `color:#fff` (the heart's class resolves dark; Thrill's other icons white).
  - **Active state** (`setToggleActive`, run each tick): mirror the native tools
    when the panel is OPEN — Winna/plinko/mines AND Stake set the icon colour
    white inline (Stake = `var(--ds-color-on-surface)`, from `data-rest-color`
    when closed); Thrill swaps `bg-button-secondary`→`bg-surface-selected-secondary`
    + green icon, building the active variant off a stored base class
    (`refClass`), not the ref's live className (it would inherit a sibling's
    active state).
  - **Insert with `appendChild`** (trailing), never `insertBefore(firstChild)`:
    a foreign node at the FRONT of a framework-managed cluster disrupts its
    reconciliation — it dropped sibling tooltips on Winna and made Svelte
    reconcile the gem away on Stake.
  - Stake still `stopPropagation`s the gem's `mouseover`/`mouseout` so Stake's
    DELEGATED footer tooltip handler doesn't pop a neighbour's label on hover.
  ids: keno/thrill `kt-bottom-toggle`, plinko `pt-bottom-toggle`, mines
  `mc-bottom-toggle`.
- `node --check` every touched JS file (no other tooling).
- Engine is ES5-style (var, no arrows) — keep it; it runs in old-ish contexts.
- **Debug logs toggle is hidden from the ⚙ settings menu for release** (so
  end users can't enable console logging). The `tog-debug` handler, the
  `state.settings.debug` flag (default false), `log()` gating, and the
  cross-frame debug sync are all kept — re-add the one `tog("tog-debug", …)`
  line in `settingsMenuHtml` to expose it during development.
- Honest-stats principle: the tracker reports reality (exact hypergeometric
  odds, z-score hot/cold with a grey "statistically normal" middle, ceil'd
  "1 in N"). Never add features that imply predictive power — past draws don't
  predict future ones; each nonce is independent.
