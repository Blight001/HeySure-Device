from pathlib import Path
from extract_hand_cur import parse_ani, cur_icon_to_png

src = Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/Hand.cur')
_, frames = parse_ani(src.read_bytes())
lines = []
best_i, best_n = 0, -1
for i, fr in enumerate(frames[:10]):
    info = cur_icon_to_png(fr)
    if not info:
        continue
    px = info['image'].load()
    w, h = info['image'].size
    n = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 0)
    black = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 0 and px[x, y][:3] == (0, 0, 0))
    lines.append(f'frame {i}: opaque={n} black={black}')
    if n > best_n:
        best_n, best_i = n, i
lines.append(f'best in first10: frame {best_i} opaque={best_n}')
Path(__file__).with_name('pick_best_frame_out.txt').write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))