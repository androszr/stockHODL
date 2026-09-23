"""The front page's pictures, drawn by StockHODL's own screens from one
invented portfolio, and never from a real book.

    python3 tools/demo_shots.py check      # the book holds nothing private
    python3 tools/demo_shots.py render     # draw the screens on a throwaway simulator
    python3 tools/demo_shots.py compose    # frame them and write shots.json
    python3 tools/demo_shots.py all        # check, render, compose

Needs Xcode, an iPhone 16 simulator runtime, and Pillow. The simulator is
created for the run and deleted afterwards. The test answers every request
from ios/StockHODLTests/DemoBook.swift, so nothing reaches a server.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BOOK = REPO / "ios" / "StockHODLTests" / "DemoBook.swift"
README = REPO / "README.md"
DEFAULT_OUT = REPO / "docs" / "images"

SCALE = 2
MAX_BYTES = 1400 * 1024
DISPLAY_CAP = 880
MARGIN_PT = 28
PHONE_RADIUS_PT = 55
KEEP_CHUNKS = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND", b"sRGB"}

# Descriptions are the README's alt text, verbatim.
SHOTS = {
    "hero.png": (
        "StockHODL on two phones: the Dashboard with the day's total and the market strip, and Holdings with the value chart, on one invented portfolio.",
        "Dashboard and Holdings, side by side.",
        True,
    ),
    "stock.png": (
        "Apple's own page beside the Options book, each in an iPhone frame.",
        "The instrument screen and the Options screen, side by side.",
        True,
    ),
    "summary.png": (
        "The daily close summary on an iPhone: the day's figure for the whole book.",
        "The day report, in an iPhone frame.",
        False,
    ),
    "widgets.png": (
        "The Home Screen tiles for holdings and options, and the Lock Screen line, with the same invented figures.",
        "Holdings tile, Options tile, and the Lock Screen accessory.",
        False,
    ),
}

# Figures and addresses that must never appear in the invented book live in
# `.private-strings` at the repository root: git-ignored, never exported, so
# the real values are not published by the very list that guards them. The
# machine's own names are added at run time.
PRIVATE_STRINGS = REPO / ".private-strings"


def private_strings() -> list[str]:
    try:
        lines = PRIVATE_STRINGS.read_text().splitlines()
    except FileNotFoundError:
        print(f"note: no {PRIVATE_STRINGS.name}; checking machine names only", file=sys.stderr)
        return []
    return [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]


class ShotError(RuntimeError):
    """A refusal in words; main prints it and exits 1."""


def _run(argv: list[str]) -> str:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def denylist() -> list[str]:
    words: set[str] = set(private_strings())

    def add(value: str) -> None:
        value = (value or "").strip()
        if len(value) >= 4:
            words.add(value)
            words.add(value.lower())

    try:
        add(getpass.getuser())
    except (KeyError, OSError):
        pass
    add(Path.home().name)
    add(socket.gethostname().split(".")[0])
    add(_run(["scutil", "--get", "ComputerName"]))
    add(_run(["git", "-C", str(REPO), "config", "user.name"]))
    email = _run(["git", "-C", str(REPO), "config", "user.email"])
    add(email)
    add(email.split("@")[0])
    words -= {"code", "users", "main", "test"}
    return sorted(words)


def cmd_check(_args) -> None:
    text = BOOK.read_text()
    if "static let synthetic = true" not in text:
        raise ShotError("DemoBook is not marked synthetic")
    findings = []
    lowered = text.lower()
    for word in denylist():
        if word.lower() in lowered:
            findings.append(word)
    if findings:
        raise ShotError("DemoBook contains: " + ", ".join(findings))
    if "70 238,19" not in text or "2 195,00" not in text:
        raise ShotError("DemoBook is missing the invented totals")
    print("check: invented book, nothing private")


def _pt(value: float) -> int:
    return int(round(value * SCALE))


def _pil():
    try:
        from PIL import Image, ImageCms, ImageDraw, ImageFilter
    except ImportError as exc:
        raise ShotError("Pillow is missing (pip install pillow)") from exc
    return Image, ImageCms, ImageDraw, ImageFilter


def _to_srgb(img):
    Image, ImageCms, _, _ = _pil()
    profile = img.info.get("icc_profile")
    img = img.convert("RGBA")
    if profile:
        import io
        try:
            source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
            target = ImageCms.createProfile("sRGB")
            img = ImageCms.profileToProfile(img, source, target, outputMode="RGBA")
        except (ImageCms.PyCMSError, OSError, ValueError):
            pass
    img.info.pop("icc_profile", None)
    return img


def _open(path: Path):
    Image, _, _, _ = _pil()
    with Image.open(path) as img:
        img.load()
        return _to_srgb(img)


def _at_scale(path: Path):
    """The layer at 2x, whatever scale the simulator drew it at."""
    img = _open(path)
    meta = json.loads(path.with_suffix(".json").read_text())
    size = (_pt(meta["width_pt"]), _pt(meta["height_pt"]))
    if img.size != size:
        Image, _, _, _ = _pil()
        img = img.resize(size, Image.Resampling.LANCZOS)
    return img


def _background(width: int, height: int):
    Image, _, _, _ = _pil()
    top, bottom = (0x15, 0x17, 0x1A), (0x0D, 0x0E, 0x10)
    column = Image.new("RGBA", (1, height))
    for y in range(height):
        t = y / max(1, height - 1)
        column.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return column.resize((width, height))


def _rounded(layer, radius_pt: float):
    Image, _, ImageDraw, _ = _pil()
    mask = Image.new("L", layer.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, layer.width - 1, layer.height - 1), radius=_pt(radius_pt), fill=255
    )
    out = layer.copy()
    out.putalpha(Image.composite(layer.split()[-1], mask, mask))
    return out


def _shadowed(canvas, layer, x: int, y: int) -> None:
    Image, _, _, ImageFilter = _pil()
    alpha = layer.split()[-1]
    shadow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    shadow.putalpha(alpha.point(lambda a: int(a * 0.55)))
    pad = _pt(24) * 2
    padded = Image.new("RGBA", (layer.width + 2 * pad, layer.height + 2 * pad), (0, 0, 0, 0))
    padded.alpha_composite(shadow, (pad, pad))
    padded = padded.filter(ImageFilter.GaussianBlur(_pt(24) / 2))
    canvas.alpha_composite(padded, (x - pad, y - pad + _pt(10)))
    canvas.alpha_composite(layer, (x, y))


def _even(img):
    width, height = img.width - img.width % 2, img.height - img.height % 2
    return img.crop((0, 0, width, height)) if (width, height) != img.size else img


def _strip_chunks(path: Path) -> None:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ShotError(f"{path.name} is not a PNG")
    out = [data[:8]]
    at = 8
    while at < len(data):
        length, kind = struct.unpack(">I4s", data[at:at + 8])
        chunk = data[at:at + 12 + length]
        if kind in KEEP_CHUNKS:
            out.append(chunk)
        at += 12 + length
    path.write_bytes(b"".join(out))


def _save(img, path: Path) -> None:
    img = _even(img.convert("RGBA"))
    if img.split()[-1].getextrema() == (255, 255):
        img = img.convert("RGB")
    img.save(path, format="PNG", optimize=True)
    _strip_chunks(path)
    if path.stat().st_size > MAX_BYTES:
        quantised = img.convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        quantised.save(path, format="PNG", optimize=True)
        _strip_chunks(path)
    if path.stat().st_size > MAX_BYTES:
        raise ShotError(f"{path.name} is {path.stat().st_size // 1024} KiB; shrink the window, never the scale")


def _device(screen):
    """An iPhone around a full-screen capture.

    The capture is the app's window, so the status band is empty. The island
    is drawn on that band. Side buttons sit just outside the metal.
    """
    Image, _, ImageDraw, _ = _pil()
    screen = _rounded(screen.convert("RGBA"), 47)
    bezel = _pt(12)
    outer = _pt(54)
    body_w = screen.width + 2 * bezel
    body_h = screen.height + 2 * bezel
    button = _pt(3)
    device = Image.new("RGBA", (body_w + 2 * button, body_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(device)
    metal = (44, 44, 48, 255)
    # Volume and the side button, behind the body so the metal covers their inner edge.
    def pill(x0, y0, x1, y1):
        draw.rounded_rectangle((x0, y0, x1, y1), radius=_pt(1.5), fill=metal)
    pill(0, _pt(150), button + _pt(1), _pt(196))
    pill(0, _pt(214), button + _pt(1), _pt(278))
    pill(0, _pt(292), button + _pt(1), _pt(356))
    pill(body_w + button - _pt(1), _pt(230), body_w + 2 * button - 1, _pt(310))
    draw.rounded_rectangle(
        (button, 0, button + body_w - 1, body_h - 1), radius=outer, fill=(22, 22, 24, 255)
    )
    draw.rounded_rectangle(
        (button + _pt(1), _pt(1), button + body_w - 1 - _pt(1), body_h - 1 - _pt(1)),
        radius=outer - _pt(1), fill=metal,
    )
    device.alpha_composite(screen, (button + bezel, bezel))
    island_w, island_h = _pt(120), _pt(35)
    ix = button + (body_w - island_w) // 2
    iy = bezel + _pt(12)
    draw.rounded_rectangle((ix, iy, ix + island_w, iy + island_h), radius=island_h // 2, fill=(0, 0, 0, 255))
    return device


def _pair(left, right):
    gap, margin = _pt(48), _pt(MARGIN_PT)
    width = left.width + right.width + gap + 2 * margin
    height = max(left.height, right.height) + 2 * margin
    canvas = _background(width, height)
    top = margin + (max(left.height, right.height) - left.height) // 2
    _shadowed(canvas, left, margin, top)
    _shadowed(canvas, right, margin + left.width + gap, margin + (max(left.height, right.height) - right.height) // 2)
    return canvas


def _framed_card(layer):
    margin = _pt(MARGIN_PT)
    canvas = _background(layer.width + 2 * margin, layer.height + 2 * margin)
    _shadowed(canvas, layer, margin, margin)
    return canvas


def _phone(layers: Path, name: str):
    return _device(_at_scale(layers / name))


def compose_images(layers: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    _save(_pair(_phone(layers, "dashboard.png"), _phone(layers, "holdings.png")), out / "hero.png")
    _save(_pair(_phone(layers, "instrument.png"), _phone(layers, "options.png")), out / "stock.png")
    story = layers / "day-report-story.png"
    if story.is_file():
        summary = _pair(_phone(layers, "day-report.png"), _phone(layers, "day-report-story.png"))
    else:
        phone = _phone(layers, "day-report.png")
        margin = _pt(MARGIN_PT)
        summary = _background(phone.width + 2 * margin, phone.height + 2 * margin)
        _shadowed(summary, phone, margin, margin)
    _save(summary, out / "summary.png")
    widget_layer = layers / "widgets.png"
    if widget_layer.is_file():
        widgets = _rounded(_at_scale(widget_layer), 22)
        _save(_framed_card(widgets), out / "widgets.png")
    for stale in ("dashboard.png", "holdings.png", "instrument.png", "options.png", "day-report.png"):
        leftover = out / stale
        if leftover.is_file():
            leftover.unlink()

    digest = hashlib.sha256(BOOK.read_bytes()).hexdigest()
    manifest = {}
    Image, _, _, _ = _pil()
    readme = README.read_text()
    problems = []
    for name, (alt, shows, _paired) in SHOTS.items():
        path = out / name
        with Image.open(path) as img:
            w, h = img.size
        display = min(DISPLAY_CAP, w // SCALE)
        # Match within this picture's own <img> tag: a bare substring check
        # passes when another picture happens to carry the same width.
        tag = next(
            (line for line in readme.splitlines() if f'src="docs/images/{name}"' in line),
            None,
        )
        if tag is None:
            problems.append(f"README does not embed docs/images/{name}")
        else:
            if f'alt="{alt}"' not in tag:
                problems.append(f"README alt for {name} does not match")
            if f'width="{display}"' not in tag:
                problems.append(f"README width for {name} should be {display}")
        manifest[name] = {
            "alt": alt,
            "shows": shows,
            "width_px": w,
            "height_px": h,
            "scale": SCALE,
            "display_width": display,
            "bytes": path.stat().st_size,
            "book_sha256": digest,
        }
    (out / "shots.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    if problems:
        raise ShotError("pictures written; README does not match yet:\n" + "\n".join(problems))
    print(f"compose: {len(manifest)} pictures in {out}")


def cmd_render(args) -> None:
    layers = Path(args.work) / "layers"
    if layers.exists():
        for child in layers.iterdir():
            child.unlink()
    layers.mkdir(parents=True, exist_ok=True)
    name = "StockHODL Shots"
    existing = _run(["xcrun", "simctl", "list", "devices", "available", "-j"])
    # A leftover from a killed run, deleted before a new one is made.
    try:
        devices = json.loads(existing or "{}").get("devices", {})
    except json.JSONDecodeError:
        devices = {}
    for runtime in devices.values():
        for device in runtime:
            if device.get("name") == name and device.get("isAvailable"):
                subprocess.run(["xcrun", "simctl", "delete", device["udid"]], check=False)

    created = subprocess.run(
        ["xcrun", "simctl", "create", name, "iPhone 16"],
        capture_output=True, text=True,
    )
    if created.returncode != 0:
        raise ShotError(created.stderr.strip() or "could not create the simulator")
    udid = created.stdout.strip()
    log = Path(args.work) / "xcodebuild.log"
    try:
        subprocess.run(["xcrun", "simctl", "boot", udid], check=False)
        subprocess.run(["xcrun", "simctl", "ui", udid, "appearance", "dark"], check=False)
        # Xcode forwards TEST_RUNNER_* from the process environment into the
        # test, without the prefix. A build setting of the same name does not.
        env = dict(
            os.environ,
            TEST_RUNNER_STOCKHODL_DEMO_SHOTS_OUT=str(layers),
            TEST_RUNNER_STOCKHODL_DEMO_LOGOS=str(REPO / "ios" / "StockHODLTests" / "DemoLogos"),
        )
        with log.open("w") as handle:
            done = subprocess.run(
                [
                    "xcodebuild", "test",
                    "-project", str(REPO / "ios" / "StockHODL.xcodeproj"),
                    "-scheme", "StockHODL",
                    "-destination", f"platform=iOS Simulator,id={udid}",
                    "-only-testing:StockHODLTests/DemoShotsTests",
                    "-derivedDataPath", str(Path(args.work) / "dd"),
                ],
                cwd=REPO,
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
            )
        if done.returncode != 0:
            tail = log.read_text(errors="replace")[-4000:]
            raise ShotError(f"xcodebuild failed (log {log}):\n{tail}")
        missing = [name for name in (
            "dashboard.png", "holdings.png", "instrument.png",
            "options.png", "day-report.png", "day-report-story.png", "widgets.png",
        ) if not (layers / name).is_file()]
        if missing:
            raise ShotError("render did not write " + ", ".join(missing))
        print(f"render: layers in {layers}")
    finally:
        subprocess.run(["xcrun", "simctl", "shutdown", udid], check=False)
        subprocess.run(["xcrun", "simctl", "delete", udid], check=False)


def cmd_compose(args) -> None:
    compose_images(Path(args.work) / "layers", Path(args.out))


def cmd_all(args) -> None:
    cmd_check(args)
    cmd_render(args)
    cmd_compose(args)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", default=str(REPO / "tmp" / "demo-shots"))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func in (("check", cmd_check), ("render", cmd_render), ("compose", cmd_compose), ("all", cmd_all)):
        sub.add_parser(name).set_defaults(func=func)
    # work dir is a scratch path. Keep it out of the tree when the default is used
    # by redirecting the default under /tmp if the repo default would be committed.
    args = parser.parse_args(argv)
    if args.work == str(REPO / "tmp" / "demo-shots"):
        args.work = str(Path("/tmp") / "stockhodl-demo-shots")
    Path(args.work).mkdir(parents=True, exist_ok=True)
    try:
        args.func(args)
    except ShotError as exc:
        print(f"demo shots: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
