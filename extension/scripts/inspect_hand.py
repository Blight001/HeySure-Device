from PIL import Image
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'cursors' / 'hand.png'
img = Image.open(p).convert('RGBA')
px = img.load()
lines = []
for y in range(img.height):
    row = ''
    for x in range(img.width):
        r, g, b, a = px[x, y]
        row += '#' if a > 128 else '.'
    lines.append(row)
out = Path(__file__).resolve().parent / 'hand_preview.txt'
out.write_text('\n'.join(lines) + f'\n\nsize={img.size}\n', encoding='utf-8')
print('wrote', out)