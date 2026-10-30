# 跑道模板 → 跑道.html：把手绘形象嵌进去（{{名字}} = 形象抠图/手绘/名字.png）
# 大小一致（10-26 用户：“小克的大小要一致，不要一会儿大一会儿小”）：所有图按同一个比例缩小，不按固定高度压；
# 小克的几张来自不同批生图，再按橙色身子的面积微调到一样大。页面里每张图按 SIZE 里记的宽度显示
import base64, io, json, pathlib, re
import numpy as np
from PIL import Image

here = pathlib.Path(__file__).parent
pics = here.parent / 'art'
s = (here / 'template.html').read_text(encoding='utf-8')
SCALE = 0.24          # 导出成 2 倍大，页面上显示一半（高分屏清楚）
ORANGE_BODY = 270      # 小克身子面积开方后的目标值（原图像素）
SIZE = {}
FIX = {'小克-趴下': 0.82}   # 趴着摊开，面积一样也显得大，再缩一点（用户：比 Codex 大了一点）


def body_fix(path, im):
    if not path.stem.startswith('小克'):
        return 1.0
    a = np.asarray(im).astype(int)
    m = (a[..., 0] > 180) & (a[..., 1] > 80) & (a[..., 1] < 150) & (a[..., 2] < 120) & (a[..., 3] > 200)
    return ORANGE_BODY / max(1, np.sqrt(m.sum())) * FIX.get(path.stem, 1)


def stand_w(look):   # 这个形象站着时在页面上的宽度（原图像素）
    path = pics / f'{look}-站.png'
    im = Image.open(path).convert('RGBA')
    return im.width * SCALE * body_fix(path, im)


def uri(key):
    path = pics / f'{key}.png'
    im = Image.open(path).convert('RGBA')
    k = SCALE * body_fix(path, im)
    if key.endswith('-探头'):   # 探头只露半截，不能按身子面积对齐：直接按同一个人站着的宽度缩
        k = stand_w(key[:-3]) / im.width
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    SIZE[key] = [im.width / 2, im.height / 2]
    im = im.quantize(64, method=Image.FASTOCTREE).convert('RGBA')
    b = io.BytesIO(); im.save(b, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(b.getvalue()).decode()


for key in set(re.findall(r'\{\{([^}]+)\}\}', s)):
    if key != 'SIZE':
        s = s.replace('{{' + key + '}}', uri(key))
s = s.replace('{{SIZE}}', json.dumps(SIZE, ensure_ascii=False))
(here.parent.parent / 'pages' / 'track.html').write_text(s, encoding='utf-8')
print('ok', len(s) // 1024, 'KB')
