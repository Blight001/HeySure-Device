from pathlib import Path
from PIL import Image

p = Path(__file__).resolve().parents[1] / 'cursors' / 'hand.png'
img = Image.open(p).convert('RGBA')
px = img.load()
w, h = img.size
stats = {
    'opaque': 0,
    'transparent': 0,
    'black_opaque': 0,
    'black_semi': 0,
    'white_opaque': 0,
}
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a == 0:
            stats['transparent'] += 1
        else:
            stats['opaque'] += 1
            if r < 8 and g < 8 and b < 8:
                stats['black_opaque'] += 1
            elif r < 32 and g < 32 and b < 32 and a > 200:
                stats['black_semi'] += 1
            if r > 240 and g > 240 and b > 240:
                stats['white_opaque'] += 1

lines = [f'{p.name} {w}x{h} bytes={p.stat().st_size}']
for k, v in stats.items():
    lines.append(f'{k}: {v}')
for pt in [(0, 0), (1, 0), (5, 0), (15, 15), (31, 31)]:
    lines.append(f'px{pt}: {px[pt]}')

out = Path(__file__).with_name('analyze_hand_out.txt')
out.write_text('\n'.join(lines), encoding='utf-8')
print(out.read_text(encoding='utf-8'))