#!/usr/bin/env python3
"""Regenerate The Lab favicon assets.

Mark: an Erlenmeyer flask outline in amber-spark on the dark notebook
background, with a single spark dot above the rim — picks up the Lab's
"new ideas" colour (amber #F59E0B) on the bg-primary surface (#0F1117).

Run from the repo root:
    pip install Pillow
    python3 apps/research-agent/scripts/gen-icons.py

Outputs into apps/research-agent/src/lab/public/ — Vite's default
publicDir for root=src/lab. The build copies them into dist/ verbatim
and the Worker serves them publicly at /lab/<file> before the auth
gate (see apps/research-agent/src/index.ts).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

INK   = (0x0F, 0x11, 0x17, 255)   # #0F1117 — notebook bg
AMBER = (0xF5, 0x9E, 0x0B, 255)   # #F59E0B — spark accent
TEXT  = (0xE8, 0xEA, 0xF0, 255)   # #E8EAF0 — text-primary

HERE   = Path(__file__).resolve().parent
APP    = HERE.parent
PUBLIC = APP / "src" / "lab" / "public"


def flask_outline(cx: int, cy: int, S: int):
    """Return outer + inner polygon points for an Erlenmeyer flask.

    Drawing both as filled polygons (outer in amber, inner in bg colour)
    yields a thick outline silhouette without needing stroke widths.
    """
    H        = int(S * 0.62)   # total flask height
    neck_w   = int(S * 0.18)
    body_w   = int(S * 0.46)
    neck_h   = int(H * 0.32)
    rim_w    = int(S * 0.24)
    rim_h    = int(H * 0.05)

    top    = cy - H // 2
    bottom = cy + H // 2
    shoulder_y = top + neck_h

    outer = [
        (cx - rim_w // 2, top),
        (cx + rim_w // 2, top),
        (cx + rim_w // 2, top + rim_h),
        (cx + neck_w // 2, top + rim_h + max(int(S * 0.01), 1)),
        (cx + neck_w // 2, shoulder_y),
        (cx + body_w // 2, bottom),
        (cx - body_w // 2, bottom),
        (cx - neck_w // 2, shoulder_y),
        (cx - neck_w // 2, top + rim_h + max(int(S * 0.01), 1)),
        (cx - rim_w // 2, top + rim_h),
    ]

    stroke = max(int(S * 0.025), 2)
    inner_neck_w = neck_w - 2 * stroke
    inner_body_w = body_w - 2 * stroke
    inner_rim_w  = rim_w - 2 * stroke
    inner_top    = top + stroke
    inner_bottom = bottom - stroke
    inner_shoulder_y = shoulder_y + int(stroke * 0.4)

    inner = [
        (cx - inner_rim_w // 2, inner_top),
        (cx + inner_rim_w // 2, inner_top),
        (cx + inner_rim_w // 2, top + rim_h - 1),
        (cx + inner_neck_w // 2, top + rim_h + stroke),
        (cx + inner_neck_w // 2, inner_shoulder_y),
        (cx + inner_body_w // 2, inner_bottom),
        (cx - inner_body_w // 2, inner_bottom),
        (cx - inner_neck_w // 2, inner_shoulder_y),
        (cx - inner_neck_w // 2, top + rim_h + stroke),
        (cx - inner_rim_w // 2, top + rim_h - 1),
    ]
    return outer, inner, (cx, top, S)


def render(size: int, square: bool = False) -> Image.Image:
    scale = 4
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = 0 if square else int(S * 0.20)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=radius, fill=INK)

    cx = S // 2
    cy = int(S * 0.55)   # nudge down to leave room for the spark above
    outer, inner, (sx, top, _) = flask_outline(cx, cy, S)

    d.polygon(outer, fill=AMBER)
    d.polygon(inner, fill=INK)

    # Liquid line — a subtle amber bar inside the lower body so the flask
    # reads as "filled". Sits across the body about 60% down.
    body_w = int(S * 0.46) - 2 * max(int(S * 0.025), 2)
    liq_y = cy + int(S * 0.13)
    liq_h = max(int(S * 0.018), 2)
    d.rounded_rectangle(
        (cx - body_w // 2 + int(S * 0.02), liq_y - liq_h // 2,
         cx + body_w // 2 - int(S * 0.02), liq_y + liq_h // 2),
        radius=liq_h // 2,
        fill=AMBER,
    )

    # Spark above the rim — a small amber dot. Drops at very small sizes
    # to avoid mud, but reads at 32+.
    if size >= 24:
        spark_r = max(int(S * 0.035), 3)
        spark_y = top - int(S * 0.06)
        d.ellipse(
            (cx - spark_r, spark_y - spark_r, cx + spark_r, spark_y + spark_r),
            fill=AMBER,
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

# Hand-authored SVG that matches the raster mark.
SVG_TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="102" ry="102" fill="#0F1117"/>
  <g fill="none" stroke="#F59E0B" stroke-width="13" stroke-linejoin="round" stroke-linecap="round">
    <path d="M 195 124 H 317 V 150 H 302 L 302 218 L 374 366 H 138 L 210 218 L 210 150 H 195 Z"/>
  </g>
  <rect x="170" y="320" width="172" height="10" rx="5" fill="#F59E0B"/>
  <circle cx="256" cy="92" r="13" fill="#F59E0B"/>
</svg>
"""

MANIFEST = {
    "name":             "The Lab",
    "short_name":       "The Lab",
    "description":      "Research agent — The Lab.",
    "start_url":        "/lab/",
    "scope":            "/lab/",
    "display":          "standalone",
    "background_color": "#0F1117",
    "theme_color":      "#0F1117",
    "icons": [
        { "src": "/lab/icon-192.png",          "sizes": "192x192", "type": "image/png" },
        { "src": "/lab/icon-512.png",          "sizes": "512x512", "type": "image/png" },
        { "src": "/lab/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
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
