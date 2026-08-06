import struct
from pathlib import Path
from PIL import Image

lines = []
p = Path(__file__).resolve().parents[1] / 'cursors' / 'hand.png'
img = Image.open(p)
px = img.load()
o = sum(1 for y in range(img.height) for x in range(img.width) if px[x, y][3] > 128)
lines.append(f'hand.png size={img.size} opaque={o} bytes={p.stat().st_size}')

cur = Path(r'C:/Windows/Cursors/aero_link.cur')
d = cur.read_bytes()
lines.append(f'aero_link len={len(d)} head={d[:4]!r}')
if d[:4] == b'RIFF':
    lines.append('aero_link is ANI')
elif d[:4] in (b'\x00\x00\x01\x00', b'\x00\x00\x02\x00'):
    n = struct.unpack_from('<H', d, 4)[0]
    lines.append(f'aero_link CUR images={n}')
    off = 6
    for i in range(n):
        w, h, _, _, xh, yh, _, _ = struct.unpack_from('<BBBBHHII', d, off)
        off += 16
        w = w or 256
        h = h or 256
        lines.append(f'  img{i}: {w}x{h} hotspot=({xh},{yh})')

Path(__file__).with_name('_inspect2_out.txt').write_text('\n'.join(lines), encoding='utf-8')