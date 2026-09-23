# Illustrated identity

The only character language for StockHODL. Nothing in `assets/` is shipped;
the masters ARE the asset-catalog files the iPhone loads.

## Casting (ADR-002 §3)

- **Bull is the doer.** Brand marks: home-screen icon, top bar, widget
  headers, sign-in. Never cast by P/L.
- **Bear is the calm one.** Empty lists and failed-load / offline-empty
  screens. Warm, at ease, eyes open — never slumped, sleeping, or covering
  its face, and never the bad-news animal.

Mascot-free: position rows, lot tables, forms, honesty/stale badges,
ticker and publisher logos.

## Masters

| File | What it is |
|---|---|
| `ios/StockHODLShared/Design/SharedAssets.xcassets/BullMark.imageset/bull-mark.png` | Canonical bull, isolated onto a transparent field. Long side ≥ 1024. |
| `ios/StockHODL/Assets.xcassets/BearStill.imageset/bear-still.png` | Canonical bear, same illustration language (roundness, lighting, line weight). Warm umber, cream muzzle, seated or at-ease. Transparent field, long side ≥ 1024. |
| `ios/StockHODLShared/Design/SharedAssets.xcassets/WidgetMark.imageset/widget-mark.png` | Head + horns crop of the bull. This is what must read at 12pt. Do not scale the full body down for the small widget mark. |

The design-pass still the look was locked from (a look lock, not a
production drawing) is kept privately and is not published.

Baked colour is allowed in these rasters. Do not recolour them from retired
`--mascot-*` tokens.

## How to cut the 12pt crop

Crop `bull-mark.png` to the head and horns — a square around the face, not
the shoulders. Export RGBA on a transparent field. That file is
`widget-mark.png` (`WidgetMark`: Holdings / Options tiles at 12pt). The
fuller face (`BullMark`) is the top bar at 24pt, sign-in at 96pt, and the
Combined tile at 20pt.

## How to flatten the 1024 icon

Composite `bull-mark.png` onto an opaque dark `--surface-0` plate
(`oklch(0.16 0.011 260)`), 1024×1024. Export PNG **without** an alpha
channel (IHDR color type 2). iOS rejects an app icon that carries alpha
even when every pixel is opaque.

Preview: export PNG, uncheck Alpha. Or any editor that writes color type 2.
`pnpm gen:icons` verifies the committed file; it does not draw it.
