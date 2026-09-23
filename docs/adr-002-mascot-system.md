# ADR-002: Mascot system — the bull and the bear

**Status:** accepted (illustrated stills, 2026-09-19) · **Date:** 2026-08-08 · **Amended:** 2026-09-19 · **Supersedes** the retired ADR-001 (web design system, removed with the website 2026-08-29; its token layer survives as `src/styles/tokens.css`)
**Reference system (historical):** "Bob" — `product-cocpit/assets/bob-identity/` (47 SVG sprites + GIF renders)

## Current production (2026-09-19 illustrated-still pass)

The phone wears illustrated stills, not a pixel grid. Colour is baked into the
rasters in the xcassets catalogs (the catalog files ARE the masters); those
files are not `src/`, so baked colour is allowed. `--mascot-*` tokens are retired. Do
not re-add them to recolour an illustration.

**First-pass inventory is two stills:**

| Still | Animal | Appears at |
|---|---|---|
| Bull brand | bull | home-screen icon (on dark `--surface-0`), top bar 24pt, Combined widget 20pt, Holdings/Options widget 12pt crop, sign-in above the name |
| Bear empty/error | bear | empty lists, failed-load / offline-empty (`LoadFailureView`) |

Sign-in is the illustrated bull above the word, not a duo-peek. Animated
sprites (refresh gallop, hibernate, confetti/tea, 404, first-run duo) remain
future work, not this pass. `src/components/mascots/` is gone with the website.
The 15×16 grid and the inline TSX sprite plan below are historical — they are
not how production art is made.

A note on the grep rule: this file lives in `docs/`, outside the `src/` scope
of the hex-grep AC. Illustrated rasters may bake colour. No hex enters `src/`
except `src/styles/tokens.css`.

---

## 1. Reference analysis — why Bob works

Bob is not "cute pixel art"; it is a small engineering system with six load-bearing conventions.
Everything below is extracted from the actual files, not the README.

### 1.1 The grid

Base viewBox is **`0 0 15 16`** — a 15×16 unit stage where 1 unit = 1 "pixel". Every rect sits on
integer coordinates with integer sizes (`x="2" y="6" width="11" height="7"`), with two sanctioned
exceptions: the **half-pixel eye highlight** (`x="2.5" y="6.5" width="1" height="1"` at 60% white)
and **sub-pixel detail lines** (closed-eye lids are `height="0.4"`). Animated sprites keep the same
character coordinates but *widen the viewBox with negative origins* (`viewBox="-12 -15 40 40"`,
`"-15 -25 45 45"`) to make room for jumps, particles and props without ever moving the body rects.
That's the trick that makes 47 files stay in registration: **the character never moves in model
space; only the camera and the transform groups do.**

### 1.2 The anatomy naming

Every sprite reuses the same named skeleton from `bob-static-base.svg`:

| id / group | rects | role |
|---|---|---|
| `ground-shadow` | `x3 y15 w9 h1`, black @ 0.5 | anchors character to a floor; animates inversely to jumps |
| `body-color-group` | one `<g fill="…">` | single fill for the whole body — recolor = one attribute |
| `torso` | `x2 y6 w11 h7` | head and body are one blob (chibi proportions) |
| `belly-patch` | `x4 y9 w7 h3`, lighter | the one interior color zone |
| `left/right-arm` | 2×2 at `y9`, flanking | separately grouped so shoulders can rotate |
| `outer/inner-*-leg` | four 1×2 at `y13` | four stubs read as feet at any size |
| `*-cheek-spot` | 1×1 at `y10`, mid-tone | the "alive" texture pixel |
| eyes | ledge 5×1 + bulge 6×3 + sclera 4×3 + pupil 2×2 + half-pixel highlight | the entire personality lives here |

The eye construction is the system's signature: a body-colored ledge and bulge, a pale sclera, a
2×2 pupil, and the 0.6-opacity half-pixel highlight that makes the eye read as *wet* at 32px.
Closed eyes swap the pupil for a `0.4`-tall lid line over a sclera sliver (`bob-sleeping.svg`).

### 1.3 The animation idiom

All motion is **pure CSS in an inline `<defs><style>`** — no SMIL, no JS. The mechanics:

- **`transform-box: fill-box` + `transform-origin` at the joint.** Arms pivot at `100% 50%` /
  `0% 50%` (shoulders), bodies at `50% 100%` (feet), shadows at their center. This is what lets a
  2×2 rect "wave" convincingly.
- **Squash and stretch with anticipation.** `bob-happy.svg`'s bounce: squash `scaleY(0.85)` at 20%
  *before* the jump, stretch `1.05` on the way up, hangtime at peak, stretch on the fall, squash on
  landing, recover. The **ground shadow runs the inverse curve** (scales down + fades at apex,
  widens on landing) — that pairing alone is 80% of the perceived weight.
- **The `step-end` sparkle trick.** Particles are `opacity: 0` at rest and flip visible/invisible
  with `animation-timing-function: step-end` — frame-by-frame 8-bit flicker, no tweening. Each
  `<use href="#px-sparkle">` instance gets its own phase via
  `animation-delay: var(--delay, 0s)` set inline (`style="--delay: 0.3s"`). One def, six
  desynchronized stars.
- **Parallax gaze.** The body tilts ±2px while the eye group translates ±3px in the same keyframe
  timeline — a fake head-turn that costs two transforms (`bob-working-confused.svg`).
- **Long idle timelines.** Idle loops are 4–7s with most of the timeline at rest and one gesture
  burst — the character feels alive without being busy. `bob-peek.svg` adds `svg:hover` overrides
  for reactive behavior, still zero JS.
- **DOM-order masking.** `bob-peek.svg` hides the body behind a box simply by drawing the box
  *after* the eyes — no clip paths.

### 1.4 The taxonomy

Files are `bob-<state>.svg` with a README mapping each to "when to use". States are **system
states** (sleeping = idle, disconnected = offline, notification = alert), not business states.
Mini variants (`bob-mini-*`, 12×12) exist for tight spaces. This is the part worth copying most:
the mascot vocabulary is an API with documented semantics, so any agent or developer picks the
right sprite without taste debates.

### 1.5 What does *not* transfer

Bob hardcodes ~6 hex literals per file (`#2e7d3a`, `#d4eed4`, `#111` …). This repo forbids that
outside `tokens.css`, and Bob has no dark/light story — his colors are absolute. Section 5 solves
both with the same mechanism. His *cadence* doesn't transfer either: 1s bounces and 0.15s arm
flaps suit a logistics tool, not a screen full of money — §6.1 runs every loop 2–3× slower with
long hold frames.

---

## 2. The two characters

Same 15×16 grid, same skeleton, same eye construction, same shadow — siblings by construction.
They differ only in **head furniture, muzzle treatment, and palette**, because at 32px those are
the only three channels that survive.

| Channel | Bull | Bear |
|---|---|---|
| Silhouette break | horns: 3-step diagonal, out-then-up, off the top corners | ears: solid 2×2 blocks on the top corners |
| Muzzle | full-width lighter band (`belly-patch` slot) with **two** nostril pixels | centered lighter patch with **one** nose pixel |
| Extra pixel | dark forelock tuft between the horns | inner-ear pixel |
| Palette | slate blue (accent family, hue ~265) | warm umber (hue ~65) |
| Posture bias (poses) | forward-leaning, kinetic | grounded, settled |

At 32px rendered (2 device px per grid cell): the horn diagonal vs. the ear block is a 4-px
silhouette difference at the top corners — the first thing the eye resolves — and the two-nostril
band vs. one-nose patch differs at the second glance. Color is the third, redundant channel, never
the only one (accessibility rule, and colorblind-safe since the two hues also differ in lightness).

### 2.1 Bull base skeleton (`bull-static-base`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 16" width="300" height="320"
     shape-rendering="crispEdges" aria-hidden="true">
  <!-- Bob's shadow, verbatim -->
  <rect id="ground-shadow" x="3" y="15" width="9" height="1"
        fill="var(--mascot-shadow, #000000)" opacity="0.5"/>

  <g id="master-group">
    <!-- Horns: 3-step forward/up curve off the head corners. Silhouette channel #1. -->
    <g id="horns" fill="var(--mascot-horn, #e6dcbe)">
      <rect id="left-horn-base"  x="1"  y="5" width="1" height="1"/>
      <rect id="left-horn-mid"   x="0"  y="4" width="1" height="1"/>
      <rect id="left-horn-tip"   x="0"  y="3" width="1" height="1"/>
      <rect id="right-horn-base" x="13" y="5" width="1" height="1"/>
      <rect id="right-horn-mid"  x="14" y="4" width="1" height="1"/>
      <rect id="right-horn-tip"  x="14" y="3" width="1" height="1"/>
    </g>

    <g id="body-color-group" fill="var(--mascot-bull-body, #4d5a75)">
      <rect id="torso" x="2" y="6" width="11" height="7"/>       <!-- Bob's exact torso -->
      <rect id="forelock" x="5" y="5" width="5" height="1"/>      <!-- tuft between horns -->
      <!-- Muzzle band occupies Bob's belly-patch slot -->
      <rect id="muzzle-band" x="4" y="9" width="7" height="3"
            fill="var(--mascot-bull-shade, #8894ab)"/>
      <rect id="left-arm"  x="0"  y="9" width="2" height="2"/>    <!-- Bob's arms -->
      <rect id="right-arm" x="13" y="9" width="2" height="2"/>
      <rect id="outer-left-leg"  x="3"  y="13" width="1" height="2"/>  <!-- Bob's legs -->
      <rect id="inner-left-leg"  x="5"  y="13" width="1" height="2"/>
      <rect id="inner-right-leg" x="9"  y="13" width="1" height="2"/>
      <rect id="outer-right-leg" x="11" y="13" width="1" height="2"/>
      <rect id="left-cheek-spot"  x="2"  y="12" width="1" height="1"
            fill="var(--mascot-bull-shade, #8894ab)"/>
      <rect id="right-cheek-spot" x="12" y="12" width="1" height="1"
            fill="var(--mascot-bull-shade, #8894ab)"/>
    </g>

    <!-- Nostril pair on the band: muzzle channel #2 (two pixels = bull) -->
    <rect id="left-nostril"  x="5" y="10" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>
    <rect id="right-nostril" x="9" y="10" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>

    <!-- Eyes: Bob's sclera + pupil + half-pixel-highlight construction, set into the face -->
    <g id="eyes">
      <rect x="3"  y="7" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="4"  y="7" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="4"  y="7" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
      <rect x="10" y="7" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="10" y="7" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="10" y="7" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
    </g>
  </g>
</svg>
```

Bob's protruding frog-eye bulge is the one anatomy piece **not** carried over — bulging eyes are
amphibian anatomy. The sclera/pupil/highlight stack is kept, set flush into the face, and the
cheek spots move down to `y12` (below the muzzle band). Everything else is Bob's rects verbatim.

### 2.2 Bear base skeleton (`bear-static-base`)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 16" width="300" height="320"
     shape-rendering="crispEdges" aria-hidden="true">
  <rect id="ground-shadow" x="3" y="15" width="9" height="1"
        fill="var(--mascot-shadow, #000000)" opacity="0.5"/>

  <g id="master-group">
    <g id="body-color-group" fill="var(--mascot-bear-fur, #7a5f45)">
      <!-- Ears: solid 2x2 corner blocks. Silhouette channel #1 (block vs. bull's diagonal). -->
      <rect id="left-ear"  x="2"  y="4" width="2" height="2"/>
      <rect id="right-ear" x="11" y="4" width="2" height="2"/>

      <rect id="torso" x="2" y="6" width="11" height="7"/>
      <rect id="left-arm"  x="0"  y="9" width="2" height="2"/>
      <rect id="right-arm" x="13" y="9" width="2" height="2"/>
      <rect id="outer-left-leg"  x="3"  y="13" width="1" height="2"/>
      <rect id="inner-left-leg"  x="5"  y="13" width="1" height="2"/>
      <rect id="inner-right-leg" x="9"  y="13" width="1" height="2"/>
      <rect id="outer-right-leg" x="11" y="13" width="1" height="2"/>
      <rect id="left-cheek-spot"  x="2"  y="10" width="1" height="1"
            fill="var(--mascot-bear-shade, #a98e6d)"/>
      <rect id="right-cheek-spot" x="12" y="10" width="1" height="1"
            fill="var(--mascot-bear-shade, #a98e6d)"/>
    </g>

    <!-- Inner-ear pixels -->
    <rect x="3"  y="5" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>
    <rect x="11" y="5" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>

    <!-- Muzzle: centered patch, ONE nose pixel (vs. bull's band + two nostrils) -->
    <rect id="muzzle-patch" x="5" y="9" width="5" height="3"
          fill="var(--mascot-bear-shade, #a98e6d)"/>
    <rect id="nose" x="7" y="9" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>

    <!-- Same eye stack as the bull — sibling DNA -->
    <g id="eyes">
      <rect x="3"  y="7" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="4"  y="7" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="4"  y="7" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
      <rect x="10" y="7" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="10" y="7" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="10" y="7" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
    </g>
  </g>
</svg>
```

---

## 3. The central tension: bull ≠ green, bear ≠ red

The obvious design — bull appears when the portfolio is up, bear when it's down, colored to
match — is rejected. Three reasons, each sufficient alone:

1. **Green/red are already a data channel.** `--gain`/`--loss` are the only saturated hues on the
   holdings screen by explicit ADR-001 decision ("green/red as the only saturated colors on
   screen"). A green mascot is a false data point: a green bull beside a red row *claims something
   about the numbers* and is wrong half the time. Worse, mixed portfolios make any single
   direction claim a lie — GPW down, NASDAQ up is a normal Tuesday for this user.
2. **Color-alone signaling is banned anyway** (`docs/context.md`: "direction is never conveyed by
   color alone"). If the mascot can't rely on color for meaning, the P/L-driven mapping loses most
   of its supposed payoff.
3. **A P/L-driven mascot is emotionally miscalibrated by default.** A cheering bull rendered from
   `dayChange > 0` will inevitably appear next to a position the user just lost money on, or
   cheer a +0.02% day. The failure mode isn't cosmetic — it makes the app feel like it's mocking
   the user, on the exact day their trust is lowest.

**Decision: mascots are cast by *system state*, never by P/L direction.** Each animal is a
character with a fixed temperament, assigned to screens by role at design time:

- **The bull is the doer** — everything kinetic: pull-to-refresh, loading, fetching. When the app
  is *working*, the bull works.
- **The bear is the calm one** — everything still: empty lists, failed-load / offline-empty.
  Bear poses are deliberately warm and unbothered — seated or at ease, eyes open — never
  slumped, sleeping, covering its face, or dejected. The bear must not become "the
  bad-news animal"; he's the comfortable one. Login and onboarding in this pass use the
  illustrated bull (the doer / brand), not a duo-peek and not the bear.

Neither animal ever wears `--gain` or `--loss`. Their palette (slate + umber, §5) sits far from
both hues (152 and 22) so no accidental semantic reading is possible.

**The single, gated exception:** two sentiment sprites exist — `bull-confetti` (celebration) and
`bear-tea` (commiseration). They are structurally prevented from misfiring:

- Rendered **only** in the All-holdings day-summary header, never per-row, never on detail screens.
- Threshold-gated: `|day P/L| ≥ 2%` of portfolio value (default; open question §9). No confetti
  for noise days.
- Shown at most once per trading day, dismissible.
- The branch is exclusive: `bull-confetti` mounts only on the gain branch, `bear-tea` only on the
  loss branch — a cheering bull *cannot* co-render with a loss because the code path doesn't exist.
- `bear-tea` is quiet by design: slow steam pixels, no bounce, and factual copy ("Rough day.").
  Commiseration means sitting with you, not performing sadness at you.

**Mascot-free zones (equally a decision):** position rows, the lot table, position detail stats,
the transaction form, the normal-operation summary header, and the "delayed / stooq" degraded-source
badge. These are dense numeric surfaces where a character is noise; the degraded-source case in
particular is an *honesty* label (the delay-disclosure rule in docs/context.md) and cutesifying it would undercut it. Mascots live
exclusively where there is no data to compete with: empty, loading, offline, error, auth, 404.

---

## 4. State inventory — the sprite set

**Production today (2026-09-19):** two illustrated stills, listed in Current production
above. Everything in the table below is future work unless a later pass ships it.

Historical plan (13 assets: 9 animated sprites, 2 static bases, 1 mini variant,
1 non-mascot glyph):

| # | Sprite | Animal | Pose / motion (one line) | Appears at |
|---|---|---|---|---|
| 1 | `bull-refresh` | bull | 3-phase: pull = lean back + squash scrubbed by `--pull`; release = gallop-in-place with dust puffs; success = one-shot proud head-toss | pull-to-refresh on Holdings and Position detail |
| 2 | `bull-trot-mini` | bull | 12×12 mini grid, two-frame trot cycle | full-screen first load; inline "fetching" indicator where a spinner would go |
| 3 | `bull-confetti` | bull | Bob's `confetti` idiom: bounce + `step-end` confetti pixels | day-summary header, gain ≥ threshold, 1×/day, dismissible |
| 4 | `bull-dizzy` | bull | swaying with spiral 1px eye replacement — he charged the wrong way | 404 page |
| 5 | `bear-empty` | bear | sitting, hugging an empty honey pot, slow breathe + blink + ear twitch | empty holdings in a portfolio; empty portfolio list (copy differs, sprite doesn't) |
| 6 | `bear-hibernate` | bear | Bob's `sleeping` sploot + Zzz particles + blinking no-signal glyph | offline banner / stale-cache shell (M5) |
| 7 | `bear-shrug` | bear | Bob's `confused` idiom: head tilt, parallax gaze, `?` pop | quote fetch failed after failover; route error boundary |
| 8 | `bear-tea` | bear | sitting, offering a steaming mug; steam = slow `step-end` pixels; no bounce | day-summary header, loss ≥ threshold, 1×/day, dismissible |
| 9 | `duo-peek` | both | Bob's `peek` idiom: two pairs of eyes over the card edge — horns left, ears right; hover retreat | login card (the one playful pre-auth surface) |
| 10 | `duo-welcome` | both | static duo side-by-side, single wave loop on the bull | first-run onboarding ("add your first transaction") |
| 11 | `bull-static-base` | bull | none | reduced-motion pose source, README, avatar |
| 12 | `bear-static-base` | bear | none | reduced-motion pose source, README, avatar |
| 13 | *(glyph, not a mascot)* moon pixel glyph | — | static 8×8 | "market closed" chip in the summary header |

**States resolved to "no sprite," deliberately:** *market closed* gets the moon glyph only — it
shows on every off-hours session next to live numbers, and a sleeping character there reads as "the
app is off," which is false (cached data is shown). *Degraded quote source* stays a text badge
(honesty label). *Skeleton rows* stay bare — a mascot inside a skeleton screen delays perceived
load; `bull-trot-mini` appears only on the full-screen cold start where there is nothing else to
look at. *Error* and *failed fetch* share `bear-shrug`; a distinct "apology" sprite is a v2 luxury.

---

## 5. Token integration — no hex leaves `tokens.css`

**Amendment (2026-09-19):** illustrated rasters bake their own colour. `--mascot-*`
custom properties are retired from `tokens.css`. Do not re-add them to recolour
the stills. `tokens.css` remains the only `src/` file allowed a colour literal.

Historical (pixel TSX, no longer production): Bob's files each carried ~6 literal
hexes. Then, **every fill was a `var()` reference** and the literals lived in
`src/styles/tokens.css` — the only file allowed to contain them.

### 5.1 New tokens

Appended to `:root` (dark) and `:root[data-theme='light']` in `src/styles/tokens.css`:

```css
/* Mascots — character palette. Deliberately distant from --gain (hue 152) and
   --loss (hue 22): bull is slate (hue ~265, the accent family), bear is umber
   (hue ~65). A mascot must never be readable as a P/L signal. */
--mascot-bull-body:  oklch(0.47 0.05 265);
--mascot-bull-shade: oklch(0.63 0.04 265);
--mascot-horn:       oklch(0.88 0.04 95);
--mascot-bear-fur:   oklch(0.50 0.06 65);
--mascot-bear-shade: oklch(0.68 0.05 75);
--mascot-eye:        oklch(0.18 0.01 260);
--mascot-eye-white:  oklch(0.95 0.01 90);
--mascot-prop:       oklch(0.44 0.05 50);  /* pots, mugs, boxes */
--mascot-dust:       oklch(0.60 0.02 90);  /* dust puffs, steam */
--mascot-shadow:     oklch(0 0 0);
```

```css
:root[data-theme='light'] {
  /* Same hues, darker bodies for contrast on white; eye-white gets a border-side
     value problem solved by the darker sclera below. */
  --mascot-bull-body:  oklch(0.42 0.05 265);
  --mascot-bull-shade: oklch(0.58 0.04 265);
  --mascot-bear-fur:   oklch(0.45 0.06 65);
  --mascot-bear-shade: oklch(0.62 0.05 75);
  --mascot-eye-white:  oklch(0.93 0.01 90);
  --mascot-shadow:     oklch(0.2 0.01 260);
}
```

### 5.2 The two color mechanisms

- **`var(--token)` for character anatomy** — multi-color art needs named channels; `currentColor`
  only carries one color.
- **`currentColor` for monochrome particles** — Zzz bubbles, the no-signal glyph, question marks.
  The wrapper sets `className="text-text-muted"` and the particles inherit theme-correct muted ink
  for free, in both themes, with zero new tokens.

### 5.3 Inline components, not files — a hard requirement, not a preference

**Amendment (2026-09-19):** production stills are xcassets rasters, not inline
TSX. `src/components/mascots/` is gone with the website. The requirement below
applied to the pixel-web plan.

Historical decision: every sprite was an inline React server-renderable component
(`src/components/mascots/*.tsx`), never an external `<img src="*.svg">`. Because:

1. **External SVG cannot inherit anything.** An `<img>`/`background-image` SVG is a separate
   document: `var(--mascot-*)` resolves to nothing and `currentColor` to black. Theme-reactive
   sprites are only possible inline. This single fact forces the architecture.
2. **Precache falls out for free.** Inline sprites ship inside the JS bundle, which Serwist
   precaches as part of the app shell (M5) — the offline `bear-hibernate` cannot itself be a
   network fetch that fails offline. Irony avoided structurally.
3. The hex-grep AC covers `*.tsx` — inline components are *inside* the enforcement perimeter,
   so a stray literal fails CI instead of hiding in `/public`.

Each component embeds its `<style>` in the SVG exactly like Bob, with keyframes and classes
namespaced `msct-<sprite>-*` to avoid collisions once several sprites mount on one page. No shared
mascot CSS file; self-containment is Bob's idiom and it's correct — pixel poses don't DRY well,
and 47 Bob files prove per-file duplication stays maintainable.

---

## 6. Motion & accessibility

### 6.1 Motion timing — slower than Bob, on purpose

Bob's cadence is snappy — 1s bounce loops, 0.15s arm flaps, 1.5s sparkle cycles. That energy fits
a warehouse tool; it is wrong next to money the user is anxious about, where a fast-twitch
character reads as *agitated*. **Decision: all loops run at roughly 2–3× Bob's durations, with
generous hold frames.** Four rules, then the numbers:

1. **Holds, not slow motion.** A longer loop is not the same motion stretched — each timeline
   parks the character in its settled pose for **≥ 40% of the cycle** and spends the rest on one
   gesture. Calm breathing, not slow-motion flailing.
2. **Stagger loop lengths across independent elements** (body 3.5s vs. blink 5s vs. ear 7.5s), so
   the sprite never visibly resyncs — at these durations a simultaneous restart is glaring.
3. **Physically coupled pairs share one duration.** The ground shadow is the body's inverse curve;
   splitting their clocks breaks the weight illusion. Couple those, stagger everything else.
4. **Gesture-driven phases are exempt.** `bull-refresh`'s pull scrub tracks the finger 1:1 with a
   CSS variable and must stay instant.
5. **Work indicators are exempt too.** `bull-refresh` is the one sprite the user is *waiting on* —
   it fronts pull-to-refresh and the `(app)` route loading state — so it never outlasts the work
   it reports. Its loop runs brisk rather than calm, and its one fixed-duration phase (the success
   head-toss, which plays *after* the data has landed) is cut to the shortest span that still
   registers as an acknowledgement. Every other sprite keeps the slow treatment.

> **Amendment (2026-08-10):** the `(app)` route loading state no longer uses the bull —
> `src/app/(app)/loading.tsx` now renders content-shaped skeletons (nav restructure, plan
> `2026-08-10-nav-portfolios-add-merge`). The bull's only home is pull-to-refresh; everything
> above about the loading state is historical.

| Sprite | Element | Duration | Easing / notes |
|---|---|---|---|
| `bull-refresh` | pull lean (scrub) | — (gesture-driven, `--pull`) | none — tracks the finger |
| `bull-refresh` | gallop loop (body + shadow, coupled) | 0.7s | ease-in-out; 0–15% settled hold |
| `bull-refresh` | dust puffs | 0.7s (coupled to gallop) | step-end; `--delay` 0s / 0.22s |
| `bull-refresh` | success head-toss | 0.26s × 1 | ease-out; also the `DONE_MS` strip hold |
| `bear-empty` | breathe (body) | 3.5s | ease-in-out; still 0–25% |
| `bear-empty` | blink | 5s | linear; one blink at ~46% |
| `bear-empty` | ear twitch | 7.5s | ease-in-out; one flick at ~60% |
| `bear-hibernate` | breathe (body + shadow, coupled) | 5.5s | ease-in-out; rest 0% and 70–100% |
| `bear-hibernate` | Zzz particles | 8s each | ease-in-out; delays 0 / 2.7 / 5.3s |
| `bear-hibernate` | no-signal blink | 4.2s | step-end |
| `bear-shrug` | full look/`?` timeline | 8s | ease-in-out; at rest ≥ 50% of cycle |
| `bull-confetti` | bounce (body + shadow) / confetti | 2.5s / 4s | ease-in-out / step-end |
| `bear-tea` | breathe / steam pixels | 4s / 5s | ease-in-out / step-end |
| `duo-peek` | emerge / gaze / blink | 9s / 6.5s / 5s | ease-in-out; hover variant 5s |
| `bull-trot-mini` | trot cycle | 1.2s | ease-in-out (it's a busy indicator; the fastest loop in the set) |
| `bull-dizzy` | sway / spiral eyes | 3.6s / 2.4s | ease-in-out |

These are commitments, not suggestions — a new sprite that needs a different tempo amends this
table in its PR.

### 6.2 The reduced-motion freeze problem

`globals.css` sets `animation-duration: 0.01ms !important` under
`prefers-reduced-motion: reduce`. Applied to Bob-style sprites this doesn't produce "no motion" —
it produces an infinite loop of 0.01ms iterations, i.e. a character frozen at an effectively
arbitrary frame (mid-squash, eyes half-closed). Two rules fix it:

1. **The un-animated DOM is the canonical resting pose — by construction.** Base rects carry no
   transform; all motion lives exclusively in `animation`. Particles (`.msct-dust`, Zzz, sparkles)
   are `opacity: 0` in their *base* style, made visible only by keyframes. Remove every animation
   and what remains is a clean standing/sitting character with no floating props.
2. **Each sprite declares its own belt-and-braces block:**

   ```css
   @media (prefers-reduced-motion: reduce) {
     .msct-* { animation: none !important; }
   }
   ```

   `animation: none` (not a shortened duration) reverts every element to rule 1's resting pose.
   The global rule then has nothing left to mangle. Even the `--pull` scrub in `bull-refresh` is
   disabled — the reduced-motion pull-to-refresh indicator is simply the static bull, which still
   communicates "release to refresh" through the standard PTR affordance around it.

### 6.3 Semantics

- **Every mascot is decorative: `aria-hidden="true"` + `focusable="false"`.** No `role="img"`, no
  `<title>`. A screen-reader user should never meet the bull.
- **Therefore every mascot has a text sibling that carries the actual state**: "No holdings yet —
  add your first transaction", "You're offline — showing data from 16:32", "Couldn't fetch quotes.
  Retrying…". The mascot component API enforces this: `<MascotPanel sprite={...} title=... body=...>`
  renders the text unconditionally; the sprite is the optional part. This is the concrete form of
  "decorative mascots must never be the only carrier of a state message."
- Mascots are never interactive (no click handlers, no tab stops); the adjacent button ("Add
  transaction", "Retry") is the interactive element with the ≥44px target.

---

## 7. Production plan

**Amendment (2026-09-19, simplified 2026-09-23):** production art lives in
the iOS xcassets catalogs, and those files are the masters — the separate
`assets/illustrated/` copies were byte-identical and were removed; the
design-pass still is kept privately. `assets/illustrated/README.md` keeps the
casting, crop and plate instructions. The 15×16 grid is not the production
method. File layout for this pass:

```
ios/StockHODLShared/Design/SharedAssets.xcassets/
  BullMark.imageset/bull-mark.png       master bull — top bar, sign-in, Combined 20pt
  WidgetMark.imageset/widget-mark.png   master head + horns crop, Holdings/Options 12pt
ios/StockHODL/Assets.xcassets/
  AppIcon.appiconset/                   1024 RGB-no-alpha on --surface-0
  BearStill.imageset/bear-still.png     master bear — empty lists + LoadFailureView
```

### 7.1 Build order

**First three, in order — maximum payoff per sprite:**

1. **`bear-empty`** — the first screen every fresh install shows (M4's "explicit empty state
   everywhere" AC), and it forces the token + skeleton + component plumbing into existence.
2. **`bull-refresh`** — the highest-frequency touchpoint (every manual refresh, every day); this
   is where the mascot system earns affection rather than tolerance.
3. **`bear-hibernate`** — the M5 offline shell's centerpiece and the best conceptual joke in the
   set; also exercises the precache path.

Then: `bear-shrug` (M6 error states) → `duo-peek` (login polish) → `bull-trot-mini` →
`duo-welcome` → `bull-dizzy` → the gated pair `bull-confetti` / `bear-tea` last (they need the
threshold logic, and the product is whole without them).

Static bases are byproducts of sprites 1–2, not separate work items.

### 7.2 File layout

```
src/components/mascots/
  index.ts               # exports + the sprite-name union type
  mascot-panel.tsx       # MascotPanel wrapper: text-first, sprite optional, aria-hidden
  bull-static-base.tsx
  bear-static-base.tsx
  bull-refresh.tsx       # accepts phase: 'pulling' | 'spinning' | 'done', style={{'--pull': p}}
  bear-empty.tsx
  bear-hibernate.tsx
  ...
docs/mascots/
  README.md              # the taxonomy table from §4 — Bob's README pattern, "when to use"
  preview.html           # dev-only gallery page, all sprites × both themes (not shipped)
```

### 7.3 Rendering guidance

- **Sizes are grid multiples**: 15×16 grid → render at 30×32, 60×64, 90×96 CSS px
  (2×/4×/6× cells). Empty/error panels use 60×64; inline indicators 30×32; onboarding 90×96.
- `shape-rendering="crispEdges"` on every SVG root — at 2× scale, anti-aliased rect seams are
  visible fuzz. (`image-rendering: pixelated` is for raster; for SVG rects `crispEdges` is the
  equivalent.) Put sprites in fixed-size containers so fractional scaling never occurs.
- The half-pixel eye highlight renders as exactly 1 device pixel at 2× — that's the intent.
- Sprites never resize with fluid layout; they are fixed-size objects centered in their panel.

### 7.4 Weight budget

Bob's median sprite is 3–5 KB raw; the largest (angry-explosion) is 26 KB. Budget here: **≤ 5 KB
raw per sprite, ≤ 1.5 KB gzipped; whole set ≤ 60 KB raw / ≤ 20 KB gzipped** inside the client
bundle. Empty/offline/error sprites load with the shell (they must exist before the network does);
the gated pair and `bull-dizzy` can be `next/dynamic` islands since their screens are rare.
No GIF pipeline — Bob's GIFs exist for chat surfaces; a PWA renders the SVG source directly.

### 7.5 PWA note

Because sprites are inline TSX (§5.3), Serwist precaches them automatically as part of the JS
chunks — **no separate precache manifest entry needed, and no possibility of an offline screen
whose mascot 404s.** If any sprite is ever moved to `/public` (e.g. for an OG image), it must be
added to the precache list explicitly; default is: don't move them.

---

## 8. Sample sprites — runnable, on-grid, in Bob's idiom

Reminder: the `#hex` values below are `var()` *fallbacks* so these files preview standalone;
the TSX versions drop every fallback and rely on `tokens.css` being loaded.

### 8.1 `bull-refresh` — pull-to-refresh (three phases, one file)

The host sets one class on the root: `is-pulling` (with `--pull` 0→1 scrubbed from drag distance —
a CSS variable, not an animation, so it tracks the finger exactly), `is-spinning` on release,
`is-done` on success. Standalone default shows the spin.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -6 24 23" width="240" height="230"
     class="is-spinning" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
  <defs>
    <style>
      .msct-body, .msct-shadow { transform-box: fill-box; }
      .msct-body   { transform-origin: 50% 100%; }  /* pivot at the hooves */
      .msct-shadow { transform-origin: 50% 50%; }
      .msct-dust   { opacity: 0; }

      /* PHASE: pulling — scrubbed, not animated. Bull leans back and coils. */
      .is-pulling .msct-body {
        transform: rotate(calc(var(--pull, 0) * -12deg))
                   scaleY(calc(1 - var(--pull, 0) * 0.15));
      }
      .is-pulling .msct-shadow { transform: scaleX(calc(1 + var(--pull, 0) * 0.15)); }

      /* PHASE: spinning — gallop in place, Bob's bounce grammar with a forward lean.
         0.7s (§6.1 rule 5): brisk, because the user is waiting on it; 0–15% is
         still a settled hold. Body, shadow and dust share one clock — they are
         physically coupled. */
      .is-spinning .msct-body   { animation: msct-br-gallop 0.7s infinite ease-in-out; }
      .is-spinning .msct-shadow { animation: msct-br-shadow 0.7s infinite ease-in-out; }
      .is-spinning .msct-dust   { animation: msct-br-dust 0.7s infinite step-end;
                                  animation-delay: var(--delay, 0s); }

      /* PHASE: done — one quick head-toss, then the host unmounts the indicator.
         The data is already on screen here, so this stays short (§6.1 rule 5). */
      .is-done .msct-body { animation: msct-br-toss 0.26s 1 ease-out; }

      @keyframes msct-br-gallop {
        0%, 15%, 100% { transform: translateY(0)    rotate(0deg)  scaleY(1); }  /* hold  */
        30%           { transform: translateY(0)    rotate(-6deg) scaleY(0.86); } /* dig in  */
        50%           { transform: translateY(-4px) rotate(-8deg) scaleY(1.06); } /* launch  */
        62%           { transform: translateY(-5px) rotate(-7deg) scaleY(1); }    /* hangtime */
        82%           { transform: translateY(0)    rotate(-2deg) scaleY(0.9); }  /* land    */
      }
      @keyframes msct-br-shadow {
        0%, 15%, 100% { transform: scale(1);    opacity: 0.5; }
        50%, 62%      { transform: scale(0.65); opacity: 0.2; }
        82%           { transform: scale(1.1);  opacity: 0.6; }
      }
      @keyframes msct-br-dust {        /* 8-bit flicker: step-end, no tween */
        0%   { opacity: 0; }
        50%  { opacity: 1; }
        82%  { opacity: 0; }
      }
      @keyframes msct-br-toss {
        0%   { transform: rotate(0deg); }
        30%  { transform: rotate(-10deg) translateY(-2px); }
        100% { transform: rotate(0deg) translateY(0); }
      }

      /* Un-animated DOM = resting pose; kill everything, including the scrub. */
      @media (prefers-reduced-motion: reduce) {
        .msct-body, .msct-shadow, .msct-dust {
          animation: none !important; transform: none !important;
        }
      }
    </style>
    <g id="msct-br-puff" fill="var(--mascot-dust, #98917f)">
      <rect x="0" y="0" width="1" height="1"/>
      <rect x="1.5" y="-0.5" width="1" height="1" opacity="0.6"/>
    </g>
  </defs>

  <rect class="msct-shadow" x="3" y="15" width="9" height="1"
        fill="var(--mascot-shadow, #000000)" opacity="0.5"/>

  <!-- Dust kicked up behind the gallop -->
  <use href="#msct-br-puff" class="msct-dust" x="15"   y="13" style="--delay: 0s"/>
  <use href="#msct-br-puff" class="msct-dust" x="16.5" y="11" style="--delay: 0.22s"/>

  <g class="msct-body">
    <g fill="var(--mascot-horn, #e6dcbe)">
      <rect x="1"  y="5" width="1" height="1"/> <rect x="0"  y="4" width="1" height="1"/>
      <rect x="0"  y="3" width="1" height="1"/> <rect x="13" y="5" width="1" height="1"/>
      <rect x="14" y="4" width="1" height="1"/> <rect x="14" y="3" width="1" height="1"/>
    </g>
    <g fill="var(--mascot-bull-body, #4d5a75)">
      <rect x="2" y="6" width="11" height="7"/>
      <rect x="5" y="5" width="5"  height="1"/>
      <rect x="4" y="9" width="7"  height="3" fill="var(--mascot-bull-shade, #8894ab)"/>
      <rect x="0" y="9" width="2"  height="2"/>  <rect x="13" y="9"  width="2" height="2"/>
      <rect x="3" y="13" width="1" height="2"/>  <rect x="5"  y="13" width="1" height="2"/>
      <rect x="9" y="13" width="1" height="2"/>  <rect x="11" y="13" width="1" height="2"/>
    </g>
    <rect x="5" y="10" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>
    <rect x="9" y="10" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>
    <g>
      <rect x="3"  y="7" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="4"  y="7" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="4"  y="7" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
      <rect x="10" y="7" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="10" y="7" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="10" y="7" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
    </g>
  </g>
</svg>
```

### 8.2 `bear-empty` — empty holdings

Sitting bear hugging an empty honey pot. Long idle timeline (6s), one gesture: an ear twitch.
The empty pot interior *is* the message pixel — the copy beside it says the rest.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 21 21" width="252" height="252"
     shape-rendering="crispEdges" aria-hidden="true" focusable="false">
  <defs>
    <style>
      /* Staggered clocks (§6.1): 3.5s / 5s / 7.5s — the three elements never
         restart together, so the loop seam is invisible. */
      .msct-be-body { transform-box: fill-box; transform-origin: 50% 100%;
                      animation: msct-be-breathe 3.5s infinite ease-in-out; }
      .msct-be-eyes { transform-box: fill-box; transform-origin: 50% 50%;
                      animation: msct-be-blink 5s infinite linear; }
      .msct-be-ear  { transform-box: fill-box; transform-origin: 50% 100%;
                      animation: msct-be-twitch 7.5s infinite ease-in-out; }

      @keyframes msct-be-breathe {          /* barely-there; he's content, not asleep */
        0%, 25%, 100% { transform: scale(1, 1); }        /* settled hold */
        55%, 70%      { transform: scale(1.01, 1.04); }  /* inhale, held */
      }
      @keyframes msct-be-blink {            /* one blink per 5s cycle */
        0%, 44%, 48%, 100% { transform: scaleY(1); }
        46%                { transform: scaleY(0.1); }
      }
      @keyframes msct-be-twitch {           /* one flick at 60% of the 7.5s loop */
        0%, 60%, 66%, 100% { transform: rotate(0deg); }
        62%                { transform: rotate(-12deg); }
        64%                { transform: rotate(6deg); }
      }

      @media (prefers-reduced-motion: reduce) {
        .msct-be-body, .msct-be-eyes, .msct-be-ear { animation: none !important; }
      }
    </style>
  </defs>

  <rect x="2" y="15" width="11" height="1" fill="var(--mascot-shadow, #000000)" opacity="0.5"/>

  <g class="msct-be-body">
    <g fill="var(--mascot-bear-fur, #7a5f45)">
      <g class="msct-be-ear"><rect x="2" y="5" width="2" height="2"/></g>
      <rect x="11" y="5" width="2" height="2"/>
      <rect x="2" y="7" width="11" height="8"/>          <!-- seated: torso sits lower, taller -->
      <rect x="2" y="14" width="2" height="1"/>          <!-- splayed feet -->
      <rect x="11" y="14" width="2" height="1"/>
      <rect x="2"  y="11" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>
      <rect x="12" y="11" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>
    </g>
    <rect x="3"  y="6" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>
    <rect x="11" y="6" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>

    <!-- Muzzle above the pot -->
    <rect x="6" y="9" width="3" height="2" fill="var(--mascot-bear-shade, #a98e6d)"/>
    <rect x="7" y="9" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>

    <!-- Eyes -->
    <g class="msct-be-eyes">
      <rect x="3"  y="8" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="4"  y="8" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="4"  y="8" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
      <rect x="10" y="8" width="2" height="2" fill="var(--mascot-eye-white, #f3eee1)"/>
      <rect x="10" y="8" width="1" height="2" fill="var(--mascot-eye, #191c23)"/>
      <rect x="10" y="8" width="0.5" height="0.5" fill="var(--mascot-eye-white, #f3eee1)" opacity="0.6"/>
    </g>

    <!-- The empty honey pot, hugged; drawn after the body = DOM-order layering -->
    <rect x="5" y="11" width="5" height="3" fill="var(--mascot-prop, #6e4f36)"/>
    <rect x="6" y="11" width="3" height="1" fill="var(--mascot-eye, #191c23)" opacity="0.6"/>
    <g fill="var(--mascot-bear-fur, #7a5f45)">   <!-- paws over the rim -->
      <rect x="4"  y="11" width="1" height="2"/>
      <rect x="10" y="11" width="1" height="2"/>
    </g>
  </g>
</svg>
```

### 8.3 `bear-hibernate` — offline / stale cache

Bob's `sleeping` sploot, bear-ified, plus a `currentColor` demo: Zzz particles and the blinking
no-signal glyph inherit the wrapper's text color (`text-text-muted` in-app), so they are
theme-correct with zero mascot tokens. The root `style="color: …"` exists only for standalone
preview and is dropped in the TSX version.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -13 31 31" width="248" height="248"
     shape-rendering="crispEdges" aria-hidden="true" focusable="false"
     style="color: #90a4ae">
  <defs>
    <style>
      /* Clocks (§6.1): body+shadow coupled at 5.5s; Zzz on their own 8s cycle;
         signal glyph at 4.2s — nothing resyncs on a visible beat. */
      .msct-bh-body   { transform-box: fill-box; transform-origin: 50% 100%;
                        animation: msct-bh-breathe 5.5s infinite ease-in-out; }
      .msct-bh-shadow { transform-box: fill-box; transform-origin: 50% 50%;
                        animation: msct-bh-shadowp 5.5s infinite ease-in-out; }
      .msct-bh-z      { opacity: 0; }
      .msct-bh-z1 { animation: msct-bh-float 8s infinite ease-in-out 0s; }
      .msct-bh-z2 { animation: msct-bh-float 8s infinite ease-in-out 2.7s; }
      .msct-bh-z3 { animation: msct-bh-float 8s infinite ease-in-out 5.3s; }
      .msct-bh-nosig  { opacity: 0; animation: msct-bh-blinksig 4.2s infinite step-end; }

      @keyframes msct-bh-breathe {        /* slow inhale, long hold, exhale, long rest */
        0%, 70%, 100% { transform: scale(1, 1); }
        35%, 45%      { transform: scale(1.02, 1.2); }
      }
      @keyframes msct-bh-shadowp {
        0%, 70%, 100% { transform: scaleX(1);    opacity: 0.4; }
        35%, 45%      { transform: scaleX(1.05); opacity: 0.5; }
      }
      @keyframes msct-bh-float {
        0%   { transform: translate(4px, 6px)  scale(0.4); opacity: 0; }
        10%  { opacity: 1; }
        50%  { transform: translate(8px, 0px)  scale(0.8); }
        90%  { opacity: 0.8; }
        100% { transform: translate(5px, -7px) scale(1.1); opacity: 0; }
      }
      @keyframes msct-bh-blinksig {       /* slow honest blink: we ARE offline */
        0%   { opacity: 0.8; }
        60%  { opacity: 0.25; }
        100% { opacity: 0.8; }
      }

      @media (prefers-reduced-motion: reduce) {
        .msct-bh-body, .msct-bh-shadow, .msct-bh-z1, .msct-bh-z2, .msct-bh-z3
          { animation: none !important; }
        .msct-bh-nosig { animation: none !important; opacity: 0.6; } /* glyph stays visible */
      }
    </style>
    <g id="msct-bh-pz">                    <!-- Bob's pixel-Z, verbatim -->
      <rect x="0" y="0" width="4" height="1"/> <rect x="2" y="1" width="1" height="1"/>
      <rect x="1" y="2" width="1" height="1"/> <rect x="0" y="3" width="4" height="1"/>
    </g>
  </defs>

  <rect class="msct-bh-shadow" x="-1" y="15" width="17" height="1"
        fill="var(--mascot-shadow, #000000)" opacity="0.4"/>

  <!-- Zzz inherit currentColor from the wrapper -->
  <g fill="currentColor">
    <use href="#msct-bh-pz" class="msct-bh-z msct-bh-z1"/>
    <use href="#msct-bh-pz" class="msct-bh-z msct-bh-z2" opacity="0.7"/>
    <use href="#msct-bh-pz" class="msct-bh-z msct-bh-z3" opacity="0.5"/>
  </g>

  <!-- No-signal glyph: two arc pixels + slash, also currentColor -->
  <g class="msct-bh-nosig" fill="currentColor">
    <rect x="17" y="7"  width="1" height="1"/>
    <rect x="16" y="8.5" width="3" height="0.5"/>
    <rect x="15" y="10" width="5" height="0.5"/>
    <rect x="16" y="10.5" width="1" height="1"/>   <!-- slash, bottom-left… -->
    <rect x="17" y="9"   width="1" height="1"/>
    <rect x="18" y="7.5" width="1" height="1"/>    <!-- …to top-right -->
  </g>

  <!-- Splooted hibernating bear -->
  <g class="msct-bh-body">
    <g fill="var(--mascot-bear-fur, #7a5f45)">
      <rect x="1"  y="8"  width="2"  height="2"/>  <!-- ears, flopped to the sides -->
      <rect x="12" y="8"  width="2"  height="2"/>
      <rect x="1"  y="10" width="13" height="5"/>  <!-- flattened torso, Bob's sploot -->
      <rect x="-1" y="13" width="2"  height="2"/>  <!-- arms spread on the floor -->
      <rect x="14" y="13" width="2"  height="2"/>
    </g>
    <rect x="2"  y="9" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>
    <rect x="12" y="9" width="1" height="1" fill="var(--mascot-bear-shade, #a98e6d)"/>

    <rect x="5" y="11" width="5" height="2" fill="var(--mascot-bear-shade, #a98e6d)"/>
    <rect x="7" y="11" width="1" height="1" fill="var(--mascot-eye, #191c23)"/>

    <!-- Closed eyes: Bob's 0.4-tall lid lines -->
    <rect x="3"  y="12" width="2" height="0.4" fill="var(--mascot-eye, #191c23)"/>
    <rect x="10" y="12" width="2" height="0.4" fill="var(--mascot-eye, #191c23)"/>
  </g>
</svg>
```

---

## 9. Open questions (with defaults — proceed unless overridden)

| # | Question | Recommended default |
|---|---|---|
| 1 | Celebration/commiseration threshold | `|day P/L| ≥ 2%` of All-holdings value, once per trading day, dismissible; revisit after living with it for a month |
| 2 | Ship `bear-tea` at all in v1? | Yes, but last — commiseration is the riskiest tone to get right; if it feels off in the preview gallery, cut it and keep only the celebration |
| 3 | Mini-grid variants beyond `bull-trot-mini`? | No — Bob's mini set exists for chat avatars; this app has exactly one tight-space slot (inline loading) |
| 4 | GIF export pipeline (Puppeteer + ffmpeg, like Bob)? | Skip — no chat surface consumes them; the repo README can embed the static bases |
| 5 | Animate `duo-welcome` fully? | Ship static duo + single bull wave first; full choreography only if onboarding gets revisited post-MVP |

---

*End of ADR-002. Build order: `bear-empty` → `bull-refresh` → `bear-hibernate`; tokens land in
`src/styles/tokens.css` in the same PR as the first sprite.*
