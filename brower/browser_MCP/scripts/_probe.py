from pathlib import Path
lines = []
for p in [
    Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/Hand.cur'),
    Path(r'd:/1.STUDY/1_project/AI/HeySure_AI_2.0/device/extension/cursors/Hand.cur'),
    Path(r'C:/Windows/Cursors/aero_link.cur'),
]:
    lines.append(f'{p} exists={p.exists()} size={p.stat().st_size if p.exists() else 0}')
Path(__file__).with_name('_probe_out.txt').write_text('\n'.join(lines), encoding='utf-8')