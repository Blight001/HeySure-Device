from pathlib import Path
from extract_hand_cur import parse_ani, cur_icon_to_png

src = Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/Hand.cur')
_, frames = parse_ani(src.read_bytes())
info = cur_icon_to_png(frames[0])
img = info['image']
px = img.load()
w, h = img.size
opaque = [(x, y, px[x, y]) for y in range(h) for x in range(w) if px[x, y][3] > 0]
lines = [f'opaque count={len(opaque)}']
for item in opaque[:50]:
    lines.append(str(item))
Path(__file__).with_name('count_rendered_out.txt').write_text('\n'.join(lines), encoding='utf-8')
print(len(opaque), 'opaque pixels')