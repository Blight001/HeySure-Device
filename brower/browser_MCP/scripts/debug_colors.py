import struct
from pathlib import Path
from extract_hand_cur import parse_ani

src = Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/Hand.cur')
_, frames = parse_ani(src.read_bytes())
icon = frames[0]
size, offset = struct.unpack_from('<II', icon, 14)
blob = icon[offset:offset + size]
hdr = struct.unpack_from('<I', blob, 0)[0]
width, biHeight = struct.unpack_from('<ii', blob, 4)
height = abs(biHeight) // 2
bpp = struct.unpack_from('<H', blob, 14)[0]
off = hdr
xor_stride = ((width * bpp + 31) // 32) * 4
xor = blob[off:off + xor_stride * height]
colors = set()
for y in range(height):
    for x in range(width):
        i = y * xor_stride + x * 4
        b, g, r, a = xor[i], xor[i + 1], xor[i + 2], xor[i + 3]
        if a > 0 and not (r == 0 and g == 0 and b == 0):
            colors.add((r, g, b, a))
lines = [f'non-black colors: {len(colors)}']
for c in sorted(colors):
    lines.append(str(c))
Path(__file__).with_name('debug_colors_out.txt').write_text('\n'.join(lines), encoding='utf-8')