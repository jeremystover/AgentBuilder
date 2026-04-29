#!/usr/bin/env python3
"""Regenerate CFO favicon assets.

Mark: bold serif "$" in paper-white on slate-900, with a small indigo
accent bar below (matches the CFO ledger-paper palette: bg #0F172A,
text/light #F8FAFC, accent #4F46E5).

Run from the repo root:
    pip install Pillow
    python3 apps/cfo/scripts/gen-icons.py

Outputs PNGs + favicon.ico into apps/cfo/public/, plus an SVG and a
web app manifest. Vite copies public/ into dist/ verbatim and the
Worker exposes them at the public root before the auth gate (see
apps/cfo/src/index.ts).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

INK    = (0x0F, 0x17, 0x2A, 255)   # #0F172A — slate-900
PAPER  = (0xF8, 0xFA, 0xFC, 255)   # #F8FAFC — bg-primary
INDIGO = (0x4F, 0x46, 0xE5, 255)   # #4F46E5 — accent

HERE   = Path(__file__).resolve().parent
APP    = HERE.parent
PUBLIC = APP / "public"

FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"


def render(size: int, square: bool = False) -> Image.Image:
    scale = 4
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = 0 if square else int(S * 0.20)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=radius, fill=INK)

    # Bold serif "$" — drawn from a font so the strokes/curves look right
    # at every size. Pre-rendered at 4× then downsampled.
    font_px = int(S * 0.70)
    font = ImageFont.truetype(FONT_PATH, font_px)
    glyph = "$"
    bbox = d.textbbox((0, 0), glyph, font=font)
    gw = bbox[2] - bbox[0]
    gh = bbox[3] - bbox[1]
    cx = S // 2
    cy = int(S * 0.48)
    d.text((cx - gw // 2 - bbox[0], cy - gh // 2 - bbox[1]), glyph, fill=PAPER, font=font)

    # Indigo accent bar — short, centered, beneath the $.
    bar_w = int(S * 0.32)
    bar_h = max(int(S * 0.04), 2)
    bar_y = int(S * 0.82)
    d.rounded_rectangle(
        (cx - bar_w // 2, bar_y - bar_h // 2, cx + bar_w // 2, bar_y + bar_h // 2),
        radius=bar_h // 2,
        fill=INDIGO,
    )

    return img.resize((size, size), Image.LANCZOS)


SIZES = {
    "favicon-16.png":         (16,  False),
    "favicon-32.png":         (32,  False),
    "favicon-48.png":         (48,  False),
    "apple-touch-icon.png":   (180, False),
    "icon-192.png":           (192, False),
    "icon-512.png":           (512, False),
    "icon-512-maskable.png":  (512, True),
}

SVG_TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="102" ry="102" fill="#0F172A"/>
  <text x="256" y="346" text-anchor="middle"
        font-family="'Source Serif 4', 'Liberation Serif', Georgia, serif"
        font-weight="700" font-size="320" fill="#F8FAFC">$</text>
  <rect x="174" y="408" width="164" height="20" rx="10" ry="10" fill="#4F46E5"/>
</svg>
"""

MANIFEST = {
    "name":             "CFO",
    "short_name":       "CFO",
    "description":      "Personal CFO agent.",
    "start_url":        "/",
    "scope":            "/",
    "display":          "standalone",
    "background_color": "#F8FAFC",
    "theme_color":      "#0F172A",
    "icons": [
        { "src": "/icon-192.png",          "sizes": "192x192", "type": "image/png" },
        { "src": "/icon-512.png",          "sizes": "512x512", "type": "image/png" },
        { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    ],
}


def main() -> int:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for name, (sz, sq) in SIZES.items():
        render(sz, square=sq).save(PUBLIC / name, optimize=True)
    render(48).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    (PUBLIC / "favicon.svg").write_text(SVG_TEMPLATE)
    (PUBLIC / "manifest.webmanifest").write_text(json.dumps(MANIFEST, indent=2) + "\n")
    print(f"wrote {len(SIZES) + 3} files into {PUBLIC}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
