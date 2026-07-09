"""Extract largest frame from a static .cur file to PNG."""
import struct
import sys
from pathlib import Path

from PIL import Image


def render_dib(w, h, xhot, yhot, blob):
    hdr_size = struct.unpack_from('<I', blob, 0)[0]
    if hdr_size < 40:
        return None
    biWidth, biHeight = struct.unpack_from('<ii', blob, 4)
    width = biWidth
    height = abs(biHeight) // 2
    bpp = struct.unpack_from('<H', blob, 14)[0]
    off = hdr_size
    xor_stride = ((width * bpp + 31) // 32) * 4
    xor_size = xor_stride * height
    xor = blob[off:off + xor_size]
    andm = blob[off + xor_size:]
    and_stride = ((width + 31) // 32) * 4

    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    pixels = img.load()
    for y in range(height):
        for x in range(width):
            i = y * xor_stride + x * (bpp // 8)
            if bpp == 32:
                b, g, r, a = xor[i], xor[i + 1], xor[i + 2], xor[i + 3]
            elif bpp == 24:
                b, g, r = xor[i], xor[i + 1], xor[i + 2]
                a = 255
            else:
                continue

            and_i = y * and_stride + (x // 8)
            and_mask = (andm[and_i] >> (7 - (x % 8))) & 1 if and_i < len(andm) else 0
            if and_mask:
                r, g, b, a = 0, 0, 0, 0
            elif bpp == 32 and (r, g, b) == (0, 0, 0):
                r, g, b, a = 0, 0, 0, 0
            elif bpp == 32 and a == 0:
                r, g, b, a = 0, 0, 0, 0

            pixels[x, height - 1 - y] = (r, g, b, a)
    return dict(image=img, hotspot=(xhot, yhot), size=(width, height))


def cur_to_png(data: bytes, prefer_size=None):
    if data[:4] not in (b'\x00\x00\x01\x00', b'\x00\x00\x02\x00'):
        return None
    count = struct.unpack_from('<H', data, 4)[0]
    entries: list[tuple[int, int, int, int, int, bytes]] = []
    off = 6
    for _ in range(count):
        w, h, _, _, xhot, yhot, size, offset = struct.unpack_from('<BBBBHHII', data, off)
        off += 16
        w = w or 256
        h = h or 256
        blob = data[offset:offset + size]
        entries.append((w * h, w, h, xhot, yhot, blob))
    if not entries:
        return None
    if prefer_size is not None:
        exact = [e for e in entries if e[1] == prefer_size and e[2] == prefer_size]
        pick = exact[0] if exact else min(entries, key=lambda e: abs(e[1] - prefer_size))
    else:
        pick = max(entries, key=lambda e: e[0])
    _, w, h, xhot, yhot, blob = pick
    return render_dib(w, h, xhot, yhot, blob)


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2] if len(sys.argv) > 2 else src.with_suffix('.png'))
    data = src.read_bytes()
    prefer = int(sys.argv[3]) if len(sys.argv) > 3 else None
    info = cur_to_png(data, prefer)
    if not info:
        print('decode failed')
        sys.exit(1)
    info['image'].save(out)
    print('saved', out, 'hotspot', info['hotspot'], 'size', info['size'])


if __name__ == '__main__':
    main()