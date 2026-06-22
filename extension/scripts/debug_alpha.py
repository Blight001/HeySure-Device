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
andm = blob[off + xor_stride * height:]
and_stride = ((width + 31) // 32) * 4

samples = [(6, 13), (7, 14), (8, 15), (10, 10), (15, 15), (3, 3)]
lines = []
for x, y in samples:
    i = y * xor_stride + x * 4
    b, g, r, a = xor[i], xor[i + 1], xor[i + 2], xor[i + 3]
    and_i = y * and_stride + (x // 8)
    and_bit = (andm[and_i] >> (7 - (x % 8))) & 1
    lines.append(f'({x},{y}) xor=({r},{g},{b},{a}) and={and_bit}')

# count xor pixels with color but alpha 0
cnt = 0
for y in range(height):
    for x in range(width):
        i = y * xor_stride + x * 4
        b, g, r, a = xor[i], xor[i + 1], xor[i + 2], xor[i + 3]
        if a == 0 and (r or g or b):
            cnt += 1
lines.append(f'colored alpha0 xor pixels: {cnt}')
Path(__file__).with_name('debug_alpha_out.txt').write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))