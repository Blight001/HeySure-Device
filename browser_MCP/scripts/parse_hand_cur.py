import struct
import sys

p = sys.argv[1] if len(sys.argv) > 1 else r'd:\1.STUDY\1_project\AI\HeySure_AI_2.0\Hand.cur'
data = open(p, 'rb').read()
print('size', len(data))
print('magic', data[:4])
pos = 12
while pos < len(data) - 8:
    cid = data[pos:pos + 4]
    csz = struct.unpack_from('<I', data, pos + 4)[0]
    pos += 8
    chunk = data[pos:pos + csz]
    pos += csz
    pos = (pos + 1) & ~1
    name = cid.decode('latin1', errors='replace')
    print(name, csz)
    if cid == b'anih' and len(chunk) >= 36:
        cFrames, jif, fl, ck, rate, seq, flags, cx, cy = struct.unpack_from('<IIIIIIII', chunk, 0)
        print('  frames', cFrames, 'size', cx, cy, 'rate', rate, 'jif', jif)