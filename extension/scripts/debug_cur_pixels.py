import struct
from pathlib import Path
from PIL import Image

from extract_hand_cur import parse_ani

src = Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/Hand.cur')
_, frames = parse_ani(src.read_bytes())
icon = frames[0]
_, _, _, _, _, _, size, offset = struct.unpack_from('<BBBBHHII', icon, 6)
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

lines = []
# ASCII map: T=and transparent, B=black opaque xor, W=white/color, .=other
for y in range(height):
    row = ''
    for x in range(width):
        i = y * xor_stride + x * (bpp // 8)
        b, g, r, a = xor[i], xor[i + 1], xor[i + 2], xor[i + 3]
        and_i = y * and_stride + (x // 8)
        and_bit = (andm[and_i] >> (7 - (x % 8))) & 1 if and_i < len(andm) else 0
        if and_bit:
            row += '.'
        elif r == 0 and g == 0 and b == 0 and a == 255:
            row += '#'
        elif r > 200 and g > 200 and b > 200:
            row += 'W'
        else:
            row += 'o'
    lines.append(row)

out = Path(__file__).with_name('debug_cur_pixels_out.txt')
out.write_text('\n'.join(lines) + '\n\n#=black xor255 and0  W=white  .=and1 transparent  o=other\n', encoding='utf-8')
print(out.read_text(encoding='utf-8'))