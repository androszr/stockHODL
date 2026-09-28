# Quiet Precision iOS design system

The iPhone app uses Quiet Precision: one leading financial figure or task per screen, readable full-width rows, and plain labels for every signed value. This is direction A from [the accepted proposal](design/2026-09-25-ios-proposal/proposal.md). The four-tab navigation, native forms, bull/bear artwork, and stock-tracking semantics stay intact.

## Source of truth

`src/styles/tokens.css` is the only color-literal source. Dark and light semantic roles (`surface-0`, `surface-1`, `surface-2`, `text-*`, `accent`, `accent-contrast`, `gain`, `loss`) are converted by `pnpm tokens:gen` into `ios/StockHODLShared/Generated/Tokens.swift`. Never edit generated Swift or add a color literal to a view. The app and widgets both consume the generated palette. The dark accent has a dark `accent-contrast` label; the light accent has a light label.

`ios/StockHODL/Design/QuietDesign.swift` owns named spacing (4/8/12/16/20/24/32 pt), radii (10/16 pt), and scalable type roles. Use system text styles so Dynamic Type grows naturally. `QuietFinancialValue` renders an already formatted amount with tabular digits; it never parses or changes the amount or unit. Use a whole server string, including currency. `QuietLabeledFigure` keeps Today and Total P/L explicit. `QuietGroup` supplies an opaque grouped surface without a repeated border. `QuietSectionHeading` gives sections a consistent title and VoiceOver header trait. `QuietHitRegion` provides a 44 pt minimum target.

```swift
QuietGroup {
    VStack(alignment: .leading, spacing: QuietDesign.Space.medium) {
        QuietSectionHeading(title: "Positions")
        QuietFinancialValue(text: position.valuePLN ?? "—")
        QuietLabeledFigure(label: "Total P/L", value: position.unrealizedPct,
                           direction: position.direction)
    }
}
```

`TickerTile` is the shared readable stock row for Dashboard and Watchlist. It accepts formatted strings and server-owned state; no monetary calculation belongs in the component. Watchlist passes no unowned P/L. `SummaryHeader`, `HoldingCard`, Options cards, report summaries, empty/failure states, and navigation rows use the same roles.

## Theme, state, and accessibility rules

- Blue identifies actions and selection. Green/red reinforce signed gain/loss values; the value's sign and a visible Today or Total P/L label carry the meaning. Selected fill uses `Tokens.accentContrast` for text.
- Amount and currency wrap together. Rows reflow at accessibility sizes; no fixed height or one-line limit applies to a monetary value. Controls have at least 44 × 44 pt hit regions.
- Keep cached timestamps, stale notices, partial and excluded-symbol notes, estimates, market session labels, and missing-value dashes. A fetch timestamp is not a trade timestamp. PLN holdings and USD options have separate summaries.
- Charts keep server data, modes, ranges, trade marks, and session semantics. The Holdings overview starts collapsed so a position is visible on opening the tab; its visible disclosure opens a 160 pt plot. Detailed plots retain 220 pt. Range and metric/style controls occupy separate rows.
- VoiceOver reads identity, figure, change, then action. Do not put fast-changing market values in a forced live region. `StaleBar` suppresses its entrance motion when Reduce Motion is on.
- Native form sections retain persistent labels, currencies, inline validation and Cancel/Save. Apply these roles to surrounding copy and controls while keeping the system's input behavior.

## Widget extension

The Home Screen extension uses the same generated semantic palette and receives only server-formatted strings. `WidgetFigureText` is its wrapping amount role; never parse or shorten a currency to make it fit. Single-summary small widgets show the compact server percentage with explicit Today and Total P/L labels; medium widgets show the full server change string. The combined small widget prioritizes separate holdings PLN and options USD values and labelled Today percentages over its decorative day plot. Combined medium keeps the day plot below two readable currency sections, with labelled Today and Total P/L. The compact header shows a relative Updated age using the payload capture time when the provider falls back to cache.

Accessory widgets remain monochrome and percentage-only: their direction glyph, sign, and spoken Today label work without the Home Screen gain/loss colors. Do not add a painted background to an accessory family or merge PLN and USD. `previewFamily` on widget views is a display-only seam for fixed-size synthetic renders; WidgetKit still supplies the real family in production. The 158 × 158 pt small, 338 × 158 pt medium, 160 × 72 pt rectangular, and 310 × 28 pt inline captures kept locally under `docs/design/` (git-ignored, never published) are content renders at those family sizes, not screenshots of a WidgetKit host installation. Verify placement and system margins on a device before release.

## Preview and extension

Open `ios/StockHODL/Design/QuietDesignCatalog.swift` in Xcode's canvas. Dark, light, and accessibility previews show a long amount, partial note, stock row, and selected controls using synthetic values. Rendered regression captures, with their command and simulator details, are kept locally under `docs/design/`, which is git-ignored and never published.

For a new screen, choose the leading figure/task, use `QuietSectionHeading` and `QuietGroup` for structure, place server-formatted values in `QuietFinancialValue` or `QuietLabeledFigure`, and pass state text through the existing stale/empty/estimate components. Add a catalog example for any new shared role. If the palette needs a new semantic meaning, add it to CSS, regenerate Swift, and check both appearances and widget legibility.
