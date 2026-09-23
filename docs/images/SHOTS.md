# The front page's pictures

Every picture under `docs/images/`, except this note, is drawn by
StockHODL's own screens from one invented portfolio, and retaken with one
command. Each phone sits in an iPhone frame. The tiles use the company
marks in `ios/StockHODLTests/DemoLogos/`, not the letter monogram. None is
a screenshot of a real book, and none is edited by hand: the fix for a
wrong picture is a change to the book and a re-run.

## The story

`ios/StockHODLTests/DemoBook.swift` is the book. Two portfolios, Core and
Income. Eight stocks (Apple, Microsoft, NVIDIA, Broadcom, Costco, JPMorgan,
Exxon Mobil, Coca-Cola) with invented quantities, and two call contracts.
The stock book is worth 70 238,19 zł. The options book is 2 195,00 USD and
is never added to the złoty total. The day is Tuesday 22 September 2026,
after the cash close. USD/PLN is 3,6520.

The company names are real public companies. Every quantity, price and
total is made up.

## Retake them

```bash
python3 tools/demo_shots.py all
```

Needs Xcode, an iPhone 16 simulator runtime and Pillow. It takes a few
minutes, most of it the app build. `check` only reads the book. `render`
draws the screens. `compose` frames them and writes `shots.json`.

The run creates a simulator named `StockHODL Shots` and deletes it
afterwards, whatever happened. It does not boot your own simulator and it
does not talk to a server: the test answers every request from the book.

## What guarantees what

| Guarantee | Held by |
|---|---|
| The book is made up and holds nothing of this machine's | `tools/demo_shots.py check` |
| The screens are the app's own views | `DemoShotsTests` |
| Nothing was requested that the book does not answer | the test fails the shot if an unknown path was needed to paint |
| No hidden metadata, even sizes, 1 400 KiB at most | `compose` |
| Four pictures, each with the README's own alt and width | `shots.json` and `compose` |

## The look a person still takes

1. Open `docs/images` in Finder.
2. Open `hero.png` and zoom in.
3. Read every ticker, figure and sentence.
4. Expect only the invented book: the eight tickers above, 70 238,19 zł,
   2 195,00 USD, and no name, email or folder of your own.
5. Check that no text is cut off at an edge and the phones sit straight.
6. Repeat for the other three pictures.

Why not automated: the check proves the book file contains no known private
string, but whether the invented book reads as believable and a frame looks
polished is a person's judgement about a real picture.
