from pathlib import Path
from PIL import Image

for rel in ['cursors/hand.png', 'dist/cursors/hand.png']:
    p = Path(__file__).resolve().parents[1] / rel
    if not p.exists():
        print(rel, 'MISSING')
        continue
    img = Image.open(p).convert('RGBA')
    px = img.load()
    w, h = img.size
    # rows/cols that have any opaque pixel
    row_has = [any(px[x, y][3] > 0 for x in range(w)) for y in range(h)]
    col_has = [any(px[x, y][3] > 0 for x in range(w)) for y in range(h)]
    # dark pixels with alpha (potential black bg)
    dark_a = [(x, y, px[x, y]) for y in range(h) for x in range(w)
              if px[x, y][3] > 10 and max(px[x, y][:3]) < 40]
    print(f'=== {rel} {w}x{h} bytes={p.stat().st_size} ===')
    print('dark semi-opaque count', len(dark_a))
    if dark_a[:8]:
        print('samples', dark_a[:8])
    # full bounding box fill ratio
    if any(row_has):
        y0 = row_has.index(True)
        y1 = len(row_has) - 1 - row_has[::-1].index(True)
        x0 = col_has.index(True)
        x1 = len(col_has) - 1 - col_has[::-1].index(True)
        box_area = (x1 - x0 + 1) * (y1 - y0 + 1)
        opaque_in_box = sum(1 for y in range(y0, y1 + 1) for x in range(x0, x1 + 1) if px[x, y][3] > 0)
        print(f'bbox ({x0},{y0})-({x1},{y1}) fill {opaque_in_box}/{box_area}')