import struct
from pathlib import Path

from extract_hand_cur import parse_ani, cur_icon_to_png, render_dib

src = Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/Hand.cur')
data = src.read_bytes()
meta, frames = parse_ani(data)
lines = [f'meta={meta} frames={len(frames)}']
fr0 = frames[0]
if fr0[:4] in (b'\x00\x00\x01\x00', b'\x00\x00\x02\x00'):
    count = struct.unpack_from('<H', fr0, 4)[0]
    lines.append(f'icons in frame0: {count}')
    off = 6
    for i in range(count):
        w, h, _, _, xh, yh, size, offset = struct.unpack_from('<BBBBHHII', fr0, off)
        off += 16
        w = w or 256
        h = h or 256
        blob = fr0[offset:offset + size]
        bpp = struct.unpack_from('<H', blob, 14)[0] if len(blob) > 16 else 0
        lines.append(f'  img{i}: {w}x{h} hotspot=({xh},{yh}) bpp={bpp} blob={len(blob)}')

info = cur_icon_to_png(fr0)
if info:
    img = info['image']
    px = img.load()
    w, h = img.size
    black_opaque = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 0 and px[x, y][:3] == (0, 0, 0))
    dark = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 128 and max(px[x, y][:3]) < 20)
    opaque = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 128)
    lines.append(f'extracted: {w}x{h} hotspot={info["hotspot"]} opaque={opaque} black_opaque={black_opaque} dark_opaque={dark}')
    lines.append(f'corner (0,0)={px[0,0]} (1,1)={px[1,1]}')

Path(__file__).with_name('probe_hand_cur_out.txt').write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))