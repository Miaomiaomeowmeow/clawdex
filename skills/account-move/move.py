# 换账号搬家：列出旧账号还在做的对话、给每个对话做一份精简记录、记下搬过哪些
# 用法：python -I move.py list [天数]        列出旧账号最近 N 天（默认 7）用过、没归档、还没搬过的对话
#       python -I move.py digest <对话编号>  把这个对话的记录精简成一份 .md（只留人和 Claude 说的话），打印路径
#       python -I move.py done <对话编号> <对方号里那个对话的编号>   记下这一对（以后来回搬只给对方发进度，不再开新的）
#       python -I move.py codex-list [天数]      Codex 换号后：列出 Codex 别的号最近在做的对话
#       python -I move.py codex-digest <对话编号>  把一个 Codex 对话精简成 .md（同样有交接摘要），打印路径
#       python -I move.py digest <编号> --since <毫秒>  只整理该时间之后的新改动
#       python -I move.py plan [清单文件]  只计划清单里勾选的对话，先上级后分支
#       done 可接多对编号；--out 指定摘要目录，--record 指定记账文件。
import argparse, glob, json, os, re, sqlite3, sys, time
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
APP = Path(os.environ['LOCALAPPDATA']) / 'Claude-Data'
HOME = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')   # 对话内容存在 HOME/projects/<文件夹>/<cliSessionId>.jsonl
CODEX = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')   # Codex 的家（CODEX_HOME）；对话表 state_5.sqlite 的 threads 每行记着 creator_account_id
OUT = Path(os.environ.get('CLAUDE_CONFIG_DIR') or (Path.home() / '.claude')) / 'account-move-records'
RECORD = OUT / '搬家记录.json'

def load(p):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:
        return None

ORG_OWNER = {}   # 第二层文件夹（组织编号）→ 第一层文件夹（账号编号）

def same_account(folder, want):   # 小克写的是账号编号，这里按组织编号分；两种都认
    return folder == want or ORG_OWNER.get(folder) == want

def all_sessions():   # [(账号文件夹名, 记录)]；兼容两层目录中的账号编号
    out = []
    # --app 可指定已知应用目录；默认枚举所有 claude_*，不写死本机名称。
    apps = [APP] if APP.name.startswith('claude_') else list(APP.glob('claude_*'))
    if not apps:
        # pathlib.glob 在部分 Python 版本会吞掉目录权限错误，明确区分“没数据”和“无权读”。
        next(APP.iterdir(), None)
    found = {}
    for app in sorted(apps):
        for f in (app / 'claude-code-sessions').glob('*/*/local_*.json'):
            s = load(f)
            if s and s.get('sessionId'):
                ORG_OWNER[f.parent.name] = f.parent.parent.name
                key = (f.parent.name, s['sessionId'])
                if key not in found or s.get('lastActivityAt', 0) > found[key].get('lastActivityAt', 0):
                    found[key] = s
    out.extend((account, s) for (account, _), s in found.items())
    return out

def current_account(sessions):   # 最新开的那个对话所在的账号 = 现在登录的号（搬家时是在新号里刚开的对话）
    return max(sessions, key=lambda x: x[1].get('createdAt', 0))[0]

def transcript(s):
    hits = glob.glob(str(HOME / 'projects' / '*' / (s.get('cliSessionId', '') + '.jsonl')))
    return Path(hits[0]) if hits else None

def record():   # {'pairs': [{'a': 编号, 'b': 编号, 'synced': {编号: 上次搬时的 lastActivityAt}}]}
    r = load(RECORD) or {}
    return r if 'pairs' in r else {'pairs': []}

def partner(r, sid):
    for p in r['pairs']:
        if sid in (p['a'], p['b']):
            return p, (p['b'] if p['a'] == sid else p['a'])
    return None, None

def cmd_list(days=7):
    ss = all_sessions()
    if not ss:
        print('没找到桌面应用的对话列表：', APP); return
    cur = current_account(ss)
    here = {s['sessionId'] for a, s in ss if a == cur}
    r = record()
    since = (time.time() - days * 86400) * 1000
    rows = []
    for a, s in ss:
        if a == cur or s.get('isArchived') or s.get('lastActivityAt', 0) < since:
            continue
        p, other = partner(r, s['sessionId'])
        if p and (s.get('lastActivityAt', 0) <= p.get('synced', {}).get(s['sessionId'], 0)
                  or not user_spoke_after(s, p.get('synced', {}).get(s['sessionId'], 0))):
            continue   # 上次搬过以后用户没再说过话，不用搬
        s['_partner'] = other if other in here else None
        rows.append(s)
    rows.sort(key=lambda s: s.get('lastActivityAt', 0), reverse=True)
    counts = {}
    for a, _ in ss:
        counts[a] = counts.get(a, 0) + 1
    print('账号文件夹（对话数）：', '；'.join(f"{a[:8]}…{'（现在这个号）' if a == cur else ''} {n}" for a, n in counts.items()))
    print(f'旧号最近 {days} 天、没归档、没搬过的对话：{len(rows)} 个\n')
    for i, s in enumerate(rows, 1):
        t = transcript(s)
        when = time.strftime('%m-%d %H:%M', time.localtime(s.get('lastActivityAt', 0) / 1000))
        size = f'{t.stat().st_size // 1024}KB' if t else '找不到记录'
        how = f"给现在这个号里的原对话 {s['_partner']} 发进度（不开新的）" if s['_partner'] else '开一个新对话'
        print(f"{i}. {s.get('title') or '（没标题）'} | {when} | {size}\n   编号 {s['sessionId']}\n   文件夹 {s.get('cwd')}\n   怎么搬：{how}")

def text_of(content):   # 只留文字：跳过工具调用、工具结果、系统提醒
    if isinstance(content, str):
        return '' if content.lstrip().startswith('<') else content
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get('type') == 'text':
            t = b.get('text', '')
            if not t.lstrip().startswith('<'):
                parts.append(t)
    return '\n'.join(parts)

def timestamp_ms(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, OverflowError):
        return None


def messages(t, since=None):
    with t.open(encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                o = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(o, dict) or o.get('type') not in ('user', 'assistant') or o.get('isMeta'):
                continue
            stamp = timestamp_ms(o.get('timestamp'))
            if since is not None and (stamp is None or stamp <= since):
                continue
            yield o


MOVE_MARK = re.compile('从旧账号搬过来的对话|你在另一个号上又接着做了')

def user_spoke_after(s, since):   # 上次搬完以后用户本人又说过话没有：AI 自己回的、对话开头那句交代、搬家发的进度都不算（跟小克清单同一条规则）
    t = transcript(s)
    if not t:
        return True   # 找不到记录时宁可列出来，别漏
    first = True
    for o in messages(t):
        if o.get('type') != 'user':
            continue
        txt = text_of(o.get('message', {}).get('content'))
        if not txt.strip() or MOVE_MARK.search(txt):
            continue
        if not first and (timestamp_ms(o.get('timestamp')) or 0) > since:
            return True
        first = False
    return False


def assistant_kind(content, previous=None):
    # 同一条消息可能先说话再用工具，按块顺序判断；工具结果不算说完。
    if isinstance(content, str):
        return 'text' if text_of(content).strip() else previous
    for block in content or []:
        if isinstance(block, dict):
            if block.get('type') == 'tool_use':
                previous = 'tool'
            elif block.get('type') == 'text' and text_of([block]).strip():
                previous = 'text'
    return previous


def cmd_digest(sid, since=None):
    s = next((s for _, s in all_sessions() if sid in (s['sessionId'], s.get('cliSessionId'))), None)   # 桌面对话编号或对话记录文件名都认（克代同堂插件交棒给 Codex 时用后者）
    if not s:
        raise ValueError('没找到这个编号：' + sid)
    p, _ = write_digest(s, since)
    print(p)


def write_digest(s, since=None):
    sid = s['sessionId']
    t = transcript(s)
    if not t:
        raise ValueError('找不到对话记录文件，cliSessionId = ' + str(s.get('cliSessionId')))
    lines = []
    plan, recap, files, last_user, last_kind, last_tool = [], None, [], '', None, None
    overall_kind = None
    for o in messages(t):
        content = (o.get('message') or {}).get('content')
        if o['type'] == 'assistant':
            overall_kind = assistant_kind(content, overall_kind)
        stamp = timestamp_ms(o.get('timestamp'))
        if since is not None and (stamp is None or stamp <= since):
            continue
        for b in content if isinstance(content, list) else []:
            if not isinstance(b, dict) or b.get('type') != 'tool_use':
                continue
            name, inp = b.get('name', ''), b.get('input') or {}
            last_tool = (name, inp)
            if name.endswith('update_plan'):
                plan = step_plan(plan, inp)
            elif name.endswith('wrap_up'):
                recap = inp
            elif name in ('Edit', 'Write', 'NotebookEdit') and inp.get('file_path') and 'scratchpad' not in inp['file_path']:   # 草稿纸里的临时文件不算
                fp = inp['file_path']
                files = [f for f in files if f != fp] + [fp]
        txt = text_of(content).strip()
        if txt:
            lines.append(('## 用户' if o['type'] == 'user' else '## Claude') + '\n' + txt)
            if o['type'] == 'user':
                last_user = txt
        if o['type'] == 'assistant':
            last_kind = assistant_kind(content, last_kind)
        # 只保留最终需要的开头和末尾，避免大记录累积在内存。
        if sum(map(len, lines)) > 125000:
            joined = '\n\n'.join(lines)
            lines = [joined[:6000], '\n……（中间省略，要细节去看原始记录）……\n', joined[-60000:]]
    body = '\n\n'.join(lines)
    summary = handoff(plan, recap, files, last_user, last_kind, last_tool)
    if len(body) > 60000:   # 太长：留开头（定下的目标）和最后一大段（做到哪了）
        body = body[:6000] + '\n\n……（中间省略，要细节去看原始记录）……\n\n' + body[-54000:]
    OUT.mkdir(parents=True, exist_ok=True)
    name = ''.join(c for c in (s.get('title') or sid) if c not in '\\/:*?"<>|')[:40]
    suffix = '' if since is None else f'-since-{since}'
    p = OUT / time.strftime('%Y-%m-%d') / f'{name}-{sid}{suffix}.md'
    p.parent.mkdir(parents=True, exist_ok=True)
    scope = '' if since is None else datetime.fromtimestamp(since / 1000).strftime('（只含 %m月%d日 %H:%M 以后的新改动）')
    head = f"# 旧对话：{s.get('title')}{scope}\n\n- 文件夹：{s.get('cwd')}\n- 原始记录：{t}\n- 模型：{s.get('model')}，思考程度：{s.get('effort')}\n\n"
    p.write_text(head + summary + '\n\n# 聊天记录（只留说的话）\n\n' + body, encoding='utf-8')
    return p.resolve(), overall_kind == 'tool'

def step_plan(plan, inp):   # 按 update_plan 的几种写法重放任务清单
    if inp.get('items'):
        return [{'content': i.get('content', ''), 'status': i.get('status', 'pending')} for i in inp['items']]
    plan = [dict(i) for i in plan]
    if inp.get('advance'):
        cur = next((i for i in plan if i['status'] == 'in_progress'), None)
        if cur:
            cur['status'] = 'completed'
        nxt = next((i for i in plan if i['status'] == 'pending'), None)
        if nxt:
            nxt['status'] = 'in_progress'
    for n in inp.get('done') or []:
        if 0 < n <= len(plan):
            plan[n - 1]['status'] = 'completed'
    if inp.get('start') and 0 < inp['start'] <= len(plan):
        plan[inp['start'] - 1]['status'] = 'in_progress'
    return plan

def handoff(plan, recap, files, last_user, last_kind, last_tool):   # 记录最前面的交接摘要
    out = ['# 交接摘要（脚本从对话里自动整理，换号时没人专门写交接）']
    if plan:
        mark = {'completed': '✅ 做完', 'in_progress': '▶ 正在做', 'pending': '⬜ 还没做'}
        out.append('## 最后一份任务清单\n' + '\n'.join(f"- {mark.get(i['status'], i['status'])}：{i['content']}" for i in plan))
    if recap:
        r = f"## 最后一次小结（结尾框）\n{recap.get('recap', '')}"
        if recap.get('ask'):
            r += f"\n- 当时在问用户：{recap['ask']}"
        out.append(r)
    if last_kind == 'tool' and last_tool:
        name, inp = last_tool
        what = inp.get('file_path') or inp.get('command') or inp.get('description') or ''
        out.append(f"## ⚠ 换号时 Claude 正做到一半\n最后一个动作是 `{name}`：{str(what)[:200]}\n这一步之后没有再说话，先检查它做完没有、结果对不对，再往下做。")
    if files:
        out.append('## 最近改过的文件\n' + '\n'.join(f'- {f}' for f in files[-15:]))
    if last_user:
        out.append('## 用户最后说的话\n' + last_user[:1500])
    if len(out) == 1:
        out.append('（这个对话里没有任务清单和小结，直接看下面的聊天记录最后几段）')
    return '\n\n'.join(out)

def cmd_plan(selection_path=None):
    path = Path(selection_path) if selection_path else HOME / 'clawdex' / 'move-selection.json'
    selection = load(path)
    if not isinstance(selection, dict) or not all(selection.get(k) for k in ('from', 'to')) or not isinstance(selection.get('ids'), list):
        raise ValueError('清单必须包含 from、to 和 ids 列表：' + str(path))
    if selection['from'] == selection['to'] or any(not isinstance(sid, str) for sid in selection['ids']):
        raise ValueError('清单的来源、目标必须不同，ids 只能包含对话编号')
    ss = all_sessions()
    # 清单明确标明目标号，比“最近创建的对话”推断更可靠。
    source = {s['sessionId']: s for a, s in ss if same_account(a, selection['from'])}
    here = {s['sessionId'] for a, s in ss if same_account(a, selection['to'])}
    if not source:
        raise ValueError('清单的来源账号没有本机对话，请核对账号编号')
    r, items, skipped = record(), {}, []
    for sid in dict.fromkeys(selection['ids']):
        s = source.get(sid)
        why = None
        pair, other = partner(r, sid)
        since = pair.get('synced', {}).get(sid, 0) if pair else None
        if s is None:
            why = '来源账号里没有这个对话'
        elif s.get('isArchived'):
            why = '对话已归档'
        elif pair and (s.get('lastActivityAt', 0) <= since or not user_spoke_after(s, since)):
            why = '上次搬完以后没有新动静（你没在里面再说过话）'
        if why:
            skipped.append({'id': sid, 'reason': why})
            continue
        kind = 'progress' if pair and other in here else 'new'
        reason = ('已搬过，给目标号的原对话发送上次之后的新进度' if kind == 'progress' else
                  '已搬过，但成对的对话不在目标号；新开对话，只整理上次之后的新改动' if pair else
                  '首次搬到目标号，新开对话并整理完整记录')
        if pair and sid not in pair.get('synced', {}):
            reason += '；旧记录缺少该侧同步时间，按 0 毫秒整理，避免漏掉内容'
        try:
            digest, cutoff = write_digest(s, since)
        except (OSError, ValueError) as exc:
            skipped.append({'id': sid, 'reason': str(exc)})
            continue
        item = {k: s.get(k) for k in ('cliSessionId', 'title', 'cwd', 'effort', 'model')}
        item.update(id=sid, kind=kind, parent=(s.get('spawnedFrom') or {}).get('sessionId'),
                    children=[], cutoff=cutoff, digest=str(digest), reason=reason,
                    target=other if kind == 'progress' else None, since=since)
        items[sid] = item
    for sid, item in items.items():
        parent = item['parent']
        if parent not in items:
            if parent in selection['ids']:
                item['reason'] += '；上级本次已跳过，由搬家对话直接处理'
            item['parent'] = None
        else:
            items[parent]['children'].append(sid)
    # 同级按最近活动排；深度优先，确保祖先在所有分支前面。
    def order(sid):
        return (-source[sid].get('lastActivityAt', 0), sid)
    ordered, visiting, visited = [], set(), set()
    def visit(sid):
        if sid in visiting:
            raise ValueError('spawnedFrom 存在循环，不能生成上下级计划：' + sid)
        if sid in visited:
            return
        visiting.add(sid)
        ordered.append(items[sid])
        items[sid]['children'].sort(key=order)
        for child in items[sid]['children']:
            visit(child)
        visiting.remove(sid)
        visited.add(sid)
    for sid in sorted((sid for sid, item in items.items() if item['parent'] is None), key=order):
        visit(sid)
    if len(visited) != len(items):
        raise ValueError('spawnedFrom 存在循环，不能生成上下级计划')
    print(json.dumps({'from': selection['from'], 'to': selection['to'], 'items': ordered, 'skipped': skipped}, ensure_ascii=False, indent=2))


def cmd_done(*ids):
    if not ids or len(ids) % 2:
        raise ValueError('done 需要成对编号：done <a> <b> [<a2> <b2> …]')
    r = record()
    sessions = {s['sessionId']: s for _, s in all_sessions()}
    for sid, other in zip(ids[::2], ids[1::2]):
        if sid == other or sid not in sessions or other not in sessions:
            raise ValueError('两个编号必须不同，且都能在本机列表中找到：' + sid + ' / ' + other)
        p, mate = partner(r, sid)
        q, back = partner(r, other)
        if (p and mate != other) or (q and back != sid):
            raise ValueError('编号已经与别的对话成对，请先核对：' + sid + ' / ' + other)
        if not p:
            p = {'a': sid, 'b': other, 'synced': {}}
            r['pairs'].append(p)
        for key in (sid, other):
            p.setdefault('synced', {})[key] = sessions[key].get('lastActivityAt', 0)
    RECORD.parent.mkdir(parents=True, exist_ok=True)
    temporary = RECORD.with_name(RECORD.name + '.tmp')
    temporary.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding='utf-8')
    temporary.replace(RECORD)
    for sid, other in zip(ids[::2], ids[1::2]):
        print('记好了：', sid, '⇄', other)

def codex_db():
    dbs = sorted(CODEX.glob('state_*.sqlite'))
    if not dbs:
        return None
    return sqlite3.connect(f'file:{dbs[-1]}?mode=ro', uri=True)   # 只读，不碰 Codex 自己的数据

def cmd_codex_list(days=7):
    c = codex_db()
    if not c:
        print('没找到 Codex 的对话表：', CODEX); return
    rows = c.execute("select id, coalesce(title, first_user_message, ''), cwd, creator_account_id, updated_at_ms, created_at_ms, source, rollout_path from threads where archived = 0 and coalesce(agent_role, '') = ''").fetchall()
    rows = [r for r in rows if r[6] not in ('exec',)]   # 派活 / 审查留下的 exec 记录不算
    if not rows:
        print('Codex 里没有对话'); return
    cur = max(rows, key=lambda r: r[5] or 0)[3]
    counts = {}
    for r in rows:
        counts[r[3]] = counts.get(r[3], 0) + 1
    print('Codex 账号（对话数）：', '；'.join(f"{str(a)[:8]}…{'（现在这个号）' if a == cur else ''} {n}" for a, n in counts.items()))
    since = (time.time() - days * 86400) * 1000
    old = sorted([r for r in rows if r[3] != cur and (r[4] or 0) >= since], key=lambda r: r[4] or 0, reverse=True)
    print(f'别的号最近 {days} 天在做的对话：{len(old)} 个\n')
    for i, r in enumerate(old, 1):
        when = time.strftime('%m-%d %H:%M', time.localtime((r[4] or 0) / 1000))
        print(f"{i}. {r[1][:40].strip() or '（没标题）'} | {when}\n   编号 {r[0]}\n   文件夹 {r[2]}")

def codex_text(content):
    parts = []
    for b in content or []:
        t = b.get('text', '') if isinstance(b, dict) else ''
        if t and not t.lstrip().startswith('<') and 'AGENTS.md' not in t[:300]:
            parts.append(t)
    return '\n'.join(parts)

def cmd_codex_digest(tid):
    c = codex_db()
    r = c and c.execute('select coalesce(title, first_user_message, ""), cwd, rollout_path, model from threads where id = ?', (tid,)).fetchone()
    if not r:
        print('没找到这个 Codex 对话：', tid); return
    title, cwd, path, model = r
    lines, plan, last_user = [], [], ''
    for line in Path(path).read_text(encoding='utf-8', errors='replace').splitlines():
        try:
            p = json.loads(line).get('payload') or {}
        except Exception:
            continue
        if p.get('type') == 'message' and p.get('role') in ('user', 'assistant'):
            txt = codex_text(p.get('content')).strip()
            if txt:
                lines.append(('## 用户' if p['role'] == 'user' else '## Codex') + '\n' + txt)
                if p['role'] == 'user':
                    last_user = txt
        elif p.get('type') == 'function_call' and p.get('name') == 'update_plan':
            try:
                plan = [{'content': s.get('step', ''), 'status': s.get('status', 'pending')} for s in json.loads(p.get('arguments') or '{}').get('plan', [])]
            except Exception:
                pass
    body = '\n\n'.join(lines)
    if len(body) > 60000:
        body = body[:6000] + '\n\n……（中间省略，要细节去看原始记录）……\n\n' + body[-54000:]
    summary = handoff(plan, None, [], last_user, 'text', None)
    name = ''.join(ch for ch in (title or tid) if ch not in '\\/:*?"<>|\n')[:40]
    out = OUT / time.strftime('%Y-%m-%d') / f'Codex-{name}.md'
    out.parent.mkdir(parents=True, exist_ok=True)
    head = f"# 旧 Codex 对话：{title[:80]}\n\n- 文件夹：{cwd}\n- 原始记录：{path}\n- 模型：{model}\n\n"
    out.write_text(head + summary + '\n\n# 聊天记录（只留说的话）\n\n' + body, encoding='utf-8')
    print(out)

def main():
    global OUT, RECORD, APP
    parser = argparse.ArgumentParser(description='只整理本机搬家资料，不开对话、不发消息')
    # 公共参数允许放在子命令前后，旧命令位置不变。
    parser.add_argument('--out', type=Path, default=OUT, help='精简记录输出目录')
    parser.add_argument('--record', type=Path, default=RECORD, help='搬家记录文件；测试时请指定副本')
    parser.add_argument('--app', type=Path, default=APP, help='Claude-Data 或已知的 claude_* 应用目录')
    common, rest = parser.parse_known_args()
    OUT, RECORD, APP = common.out, common.record, common.app
    commands = argparse.ArgumentParser(description=parser.description, parents=[parser], add_help=False)
    sub = commands.add_subparsers(dest='command')
    for name in ('list', 'codex-list'):
        sub.add_parser(name).add_argument('days', type=int, nargs='?', default=7)
    digest = sub.add_parser('digest')
    digest.add_argument('id')
    digest.add_argument('--since', type=int)
    sub.add_parser('codex-digest').add_argument('id')
    sub.add_parser('plan').add_argument('selection', nargs='?')
    sub.add_parser('done').add_argument('ids', nargs='+')
    args = commands.parse_args(rest or ['list'])
    try:
        if args.command == 'list': cmd_list(args.days)
        elif args.command == 'codex-list': cmd_codex_list(args.days)
        elif args.command == 'digest': cmd_digest(args.id, args.since)
        elif args.command == 'codex-digest': cmd_codex_digest(args.id)
        elif args.command == 'plan': cmd_plan(args.selection)
        elif args.command == 'done': cmd_done(*args.ids)
    except (OSError, ValueError, sqlite3.Error) as exc:
        commands.exit(1, '错误：' + str(exc) + '\n')


if __name__ == '__main__':
    main()
