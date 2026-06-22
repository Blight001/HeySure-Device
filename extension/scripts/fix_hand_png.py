from PIL import Image
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'cursors' / 'hand.png'
img = Image.open(p).convert('RGBA')
px = img.load()
w, h = img.size
changed = 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        # 32-bit CUR matte is stored as opaque black; hand ink is never pure black.
        if r == 0 and g == 0 and b == 0:
            px[x, y] = (0, 0, 0, 0)
            changed += 1

out = p
img.save(out)
print(f'fixed {changed} pixels in {out} ({w}x{h})')