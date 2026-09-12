#!/usr/bin/env python3
"""Generate PWA icons (rounded-square + 'H') as PNG using only stdlib."""
import struct
import zlib
from pathlib import Path


def make_png(size: int, path: Path) -> None:
    bg = (15, 20, 32)      # #0f1420
    fg = (16, 163, 127)    # teal
    r = size * 0.22        # corner radius
    rows = []
    pad = size * 0.24
    bar_w = size * 0.14
    x1, x2 = pad, size - pad - bar_w
    top, bot = pad, size - pad

    def inside(x: int, y: int) -> bool:
        # rounded rect
        if x < r and y < r:
            return (x - r) ** 2 + (y - r) ** 2 <= r * r
        if x >= size - r and y < r:
            return (x - (size - r)) ** 2 + (y - r) ** 2 <= r * r
        if x < r and y >= size - r:
            return (x - r) ** 2 + (y - (size - r)) ** 2 <= r * r
        if x >= size - r and y >= size - r:
            return (x - (size - r)) ** 2 + (y - (size - r)) ** 2 <= r * r
        return True

    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            in_h = (x1 <= x < x1 + bar_w or x2 <= x < x2 + bar_w) and top <= y < bot
            crossbar = x1 <= x < x2 + bar_w and (size // 2 - bar_w // 2) <= y < (size // 2 + bar_w // 2)
            if in_h or crossbar:
                row.extend((*fg, 255))
            elif inside(x, y):
                row.extend((*bg, 255))
            else:
                row.extend((0, 0, 0, 0))
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(typ: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)
    print(f"wrote {path} ({size}x{size}, {len(png)} bytes)")


out = Path(__file__).resolve().parent.parent / "web" / "public"
make_png(192, out / "icon-192.png")
make_png(512, out / "icon-512.png")