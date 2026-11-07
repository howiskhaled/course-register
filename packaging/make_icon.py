"""Renders the KFUPM Planner app icon -> packaging output PNG (1024x1024).

Follows Apple's macOS icon template:
  * 1024 canvas, 824x824 tile at (100,100), continuous corners (flat sides, superellipse corners)
  * soft drop shadow + contact shadow inside the canvas
  * graphite body with a gentle top-to-bottom light falloff and a fine top rim highlight
  * glyph: a Sun-Thu week; Sun/Tue/Thu share class blocks, Mon/Wed another - the UTR / MW
    rhythm every KFUPM timetable has - with one green block (the app's 'seat open' signal).
    Original artwork; no university marks.

Rendered 4x supersampled with Pillow (build-time only dependency), then downsampled.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

K = 4  # supersampling
S = 1024
TILE = (100, 100, 924, 924)


def squircle(box, radius=None, n=4.2, steps=90):
    """Rounded rect with *continuous* corners (Apple-style): straight sides, superellipse-shaped
    corners. radius ~ 0.30 x side mimics the macOS Big Sur+ icon tile."""
    x0, y0, x1, y1 = box
    r = radius if radius is not None else 0.30 * (x1 - x0)
    pts = []
    # corner centres and the quadrant each corner sweeps
    corners = [((x1 - r, y0 + r), -90, 0), ((x1 - r, y1 - r), 0, 90), ((x0 + r, y1 - r), 90, 180), ((x0 + r, y0 + r), 180, 270)]
    for (cx, cy), t0, t1 in corners:
        for i in range(steps + 1):
            t = math.radians(t0 + (t1 - t0) * i / steps)
            c, s_ = math.cos(t), math.sin(t)
            pts.append((cx + r * math.copysign(abs(c) ** (2 / n), c), cy + r * math.copysign(abs(s_) ** (2 / n), s_)))
    return pts


def mask_of(draw_fn, size=S):
    m = Image.new("L", (size * K, size * K), 0)
    draw_fn(ImageDraw.Draw(m))
    return m.resize((size, size), Image.LANCZOS)


def scaled(pts, dx=0, dy=0):
    return [((x + dx) * K, (y + dy) * K) for x, y in pts]


def vgradient(top, bottom, size=S, y0=0, y1=S):
    g = Image.new("RGBA", (1, size))
    for y in range(size):
        t = min(max((y - y0) / (y1 - y0), 0), 1)
        t = t * t * (3 - 2 * t)  # smoothstep
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(4)))
    return g.resize((size, size))


def rrect(box, r):
    return lambda d: d.rounded_rectangle([c * K for c in box], radius=r * K, fill=255)


def main(out: Path) -> None:
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    tile_pts = squircle(TILE)

    # 1. shadows (ambient + contact)
    for dy, blur, alpha in ((14, 22, 0.42), (3, 4, 0.30)):
        m = mask_of(lambda d: d.polygon(scaled(tile_pts, 0, dy), fill=255)).filter(ImageFilter.GaussianBlur(blur))
        sh = Image.new("RGBA", (S, S), (0, 0, 0, 255))
        sh.putalpha(m.point(lambda v: round(v * alpha)))
        canvas = Image.alpha_composite(canvas, sh)

    # 2. body: graphite, lighter at the top like Apple's dark utility icons
    tile_mask = mask_of(lambda d: d.polygon(scaled(tile_pts), fill=255))
    body = vgradient((64, 64, 68, 255), (22, 22, 24, 255), y0=100, y1=924)
    body.putalpha(tile_mask)
    canvas = Image.alpha_composite(canvas, body)

    # 3. fine rim highlight along the top edge
    inner = mask_of(lambda d: d.polygon(scaled(squircle((103, 104, 921, 921), radius=0.30 * 824 - 3)), fill=255))
    rim = ImageChops.subtract(tile_mask, inner)
    fade = vgradient((255, 255, 255, 120), (255, 255, 255, 0), y0=100, y1=420).getchannel("A")
    rim_layer = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    rim_layer.putalpha(ImageChops.multiply(rim, fade))
    canvas = Image.alpha_composite(canvas, rim_layer)

    # 4. glyph: a Sun-Thu week. UTR blocks (cols 0,2,4) and MW blocks (cols 1,3), one green block
    glyph = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    lines = mask_of(lambda d: [d.rectangle([232 * K, y * K, 792 * K, (y + 3) * K], fill=255) for y in (366, 510, 654)])
    lines_layer = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    lines_layer.putalpha(lines.point(lambda v: round(v * 0.07)))
    glyph = Image.alpha_composite(glyph, lines_layer)

    W, P, X0 = 88, 112, 244  # bar width, column pitch, first column x  (spans 244..780, centred)
    col = lambda i: (X0 + i * P, X0 + i * P + W)
    WHITE, DIM, GREEN = ((255, 255, 255), 1.0), ((255, 255, 255), 0.5), ((48, 209, 88), 1.0)
    blocks = []
    blocks += [(*col(i), 300, 436, WHITE) for i in (0, 2, 4)]
    blocks += [(*col(i), 392, 528, DIM) for i in (1, 3)]
    blocks += [(*col(i), 588, 724, GREEN if i == 2 else DIM) for i in (0, 2, 4)]

    bsh = mask_of(lambda d: [d.rounded_rectangle([x0 * K, (y0 + 8) * K, x1 * K, (y1 + 8) * K], radius=22 * K, fill=255) for x0, x1, y0, y1, (c, op) in blocks if op > 0.9])
    bsh = bsh.filter(ImageFilter.GaussianBlur(10))
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 255))
    sh.putalpha(bsh.point(lambda v: round(v * 0.45)))
    glyph = Image.alpha_composite(glyph, sh)

    for x0, x1, y0, y1, (rgb, op) in blocks:
        top = tuple(min(255, c + 12) for c in rgb) + (255,)
        bot = tuple(round(c * 0.9) for c in rgb) + (255,)
        layer = vgradient(top, bot, y0=y0, y1=y1)
        layer.putalpha(mask_of(rrect((x0, y0, x1, y1), 22)).point(lambda v, op=op: round(v * op)))
        glyph = Image.alpha_composite(glyph, layer)

    glyph.putalpha(ImageChops.multiply(glyph.getchannel("A"), tile_mask))
    canvas = Image.alpha_composite(canvas, glyph)

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    # python make_icon.py out.png [--ico out.ico]
    args = sys.argv[1:]
    png = Path(args[0]) if args and not args[0].startswith("--") else Path(__file__).with_name("icon-1024.png")
    main(png)
    if "--ico" in args:
        ico = Path(args[args.index("--ico") + 1])
        Image.open(png).save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
        print(f"wrote {ico}")
