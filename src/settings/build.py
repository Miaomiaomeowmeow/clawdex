# 把手绘小头嵌进模板 → 设置页.html（缩成小图、减色，文件才小）
import base64, io, pathlib
from PIL import Image

here = pathlib.Path(__file__).parent
pics = here.parent / 'art'
NAMES = {'小克': '小克', 'codex': 'codex', 'gemini': 'gemini', '紫': '通用-紫', '蓝': '通用-蓝', '绿': '通用-绿'}

s = (here / 'template.html').read_text(encoding='utf-8')
for key, f in NAMES.items():
    im = Image.open(pics / f'{f}-探头.png').convert('RGBA')
    im.thumbnail((72, 72), Image.LANCZOS)
    im = im.quantize(48, method=Image.FASTOCTREE).convert('RGBA')
    b = io.BytesIO(); im.save(b, 'PNG', optimize=True)
    s = s.replace('{{' + key + '}}', 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode())
(here.parent.parent / 'pages' / 'settings.html').write_text(s, encoding='utf-8')
print('ok', len(s) // 1024, 'KB')
