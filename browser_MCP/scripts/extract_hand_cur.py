"""Extract frames from Hand.cur (RIFF/ANI animated cursor) to PNG files."""
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print('Pillow required: pip install pillow')
    sys.exit(1)


def parse_ani(data: bytes):
    if data[:4] != b'RIFF':
        raise ValueError('Not a RIFF file')
    pos = 12
    meta = {}
    frames = []
    while pos < len(data) - 8:
        cid = data[pos:pos + 4]
        csz = struct.unpack_from('<I', data, pos + 4)[0]
        pos += 8
        chunk = data[pos:pos + csz]
        pos += csz
        pos = (pos + 1) & ~1
        if cid == b'anih' and len(chunk) >= 36:
            cFrames, cSteps, cx, cy, cBitCount, cPlanes, jif, flags = struct.unpack_from('<IIIIIIII', chunk, 4)
            meta.update(dict(cFrames=cFrames, cSteps=cSteps, cx=cx, cy=cy, jif=jif))
        elif cid == b'LIST' and chunk[:4] == b'fram':
            inner = 4
            while inner < len(chunk) - 8:
                scid = chunk[inner:inner + 4]
                ssz = struct.unpack_from('<I', chunk, inner + 4)[0]
                inner += 8
                sub = chunk[inner:inner + ssz]
                inner += ssz
                inner = (inner + 1) & ~1
                if scid == b'icon':
                    frames.append(sub)
    return meta, frames


def cur_icon_to_png(icon_data: bytes):
    if icon_data[:4] not in (b'\x00\x00\x01\x00', b'\x00\x00\x02\x00'):
        return None
    if icon_data[:4] == b'\x00\x00\x01\x00' or icon_data[:4] == b'\x00\x00\x02\x00':
        # ICO/CUR container with possibly multiple images; pick largest
        count = struct.unpack_from('<H', icon_data, 4)[0]
        best = None
        off = 6
        for _ in range(count):
            w, h, _, _, xhot, yhot, size, offset = struct.unpack_from('<BBBBHHII', icon_data, off)
            off += 16
            w = w or 256
            h = h or 256
            blob = icon_data[offset:offset + size]
            if best is None or w * h > best[0]:
                best = (w * h, w, h, xhot, yhot, blob)
        if not best:
            return None
        _, w, h, xhot, yhot, blob = best
        return render_dib(w, h, xhot, yhot, blob)
    return None


def render_dib(w, h, xhot, yhot, blob):
    hdr_size = struct.unpack_from('<I', blob, 0)[0]
    if hdr_size < 40:
        return None
    biWidth, biHeight = struct.unpack_from('<ii', blob, 4)
    width = biWidth
    height = abs(biHeight) // 2  # cursor XOR + AND
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
                # 32-bit color cursors encode the matte as opaque black in XOR.
                r, g, b, a = 0, 0, 0, 0
            elif bpp == 32 and a == 0:
                r, g, b, a = 0, 0, 0, 0

            pixels[x, height - 1 - y] = (r, g, b, a)
    return dict(image=img, hotspot=(xhot, yhot), size=(width, height))


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else r'd:\1.STUDY\1_project\AI\HeySure_AI_2.0\Hand.cur')
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else src.parent / 'device' / 'extension' / 'cursors')
    out_dir.mkdir(parents=True, exist_ok=True)
    data = src.read_bytes()
    meta, frames = parse_ani(data)
    print('meta', meta, 'frame_count', len(frames))
    if not frames:
        print('No frames found')
        sys.exit(1)
    fr0 = frames[0]
    print('first icon head', fr0[:32].hex(), 'size', len(fr0))
    info = cur_icon_to_png(frames[0])
    if not info:
        print('Failed to decode first frame')
        sys.exit(1)
    info = cur_icon_to_png(frames[0])
    primary = out_dir / 'hand.png'
    info['image'].save(primary)
    print('saved', primary, 'hotspot', info['hotspot'], 'size', info['size'])


if __name__ == '__main__':
    main()