# assets/

Reference notes for the artwork. **Nothing in this directory is shipped or
served.**

The mascot masters are the asset-catalog files the app already loads — there
is no second copy to keep in step:

| Master | Path |
|---|---|
| Bull (full face) | `ios/StockHODLShared/Design/SharedAssets.xcassets/BullMark.imageset/bull-mark.png` |
| Bull (12pt head crop) | `ios/StockHODLShared/Design/SharedAssets.xcassets/WidgetMark.imageset/widget-mark.png` |
| Bear | `ios/StockHODL/Assets.xcassets/BearStill.imageset/bear-still.png` |

The design-pass still the look was locked from is kept privately and is not
published.

Why this folder sits where it does:

- It is outside `src/`, so it sits outside the hex-grep perimeter —
  illustrated rasters may bake colour. The rule that only
  `src/styles/tokens.css` may hold a colour literal applies to `src/`;
  these are not `src/`.
- Nothing here is fetchable at runtime; the server has no static folder.

See `illustrated/README.md` for casting, crops, and the 1024 plate.
