#!/usr/bin/env node
// 读队友 AI 自己记录里的额度（只读）。现在认得 Codex：它每次回话都把 rate_limits 写进对话记录（sessions/年/月/日/*.jsonl）
// 打印一行 JSON：{"Codex":{"five":用了%,"fiveAt":ISO,"week":用了%,"weekAt":ISO}}；读不到的 AI 不出现，出错打印 {}
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function newestDir(dir) {
  const names = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

async function newestFiles(root, count) {
  let dir = root;
  for (let i = 0; i < 3 && dir; i++) dir = await newestDir(dir);   // 年 / 月 / 日
  if (!dir) return [];
  const files = await Promise.all((await fs.readdir(dir)).filter(n => n.endsWith('.jsonl')).map(async n => {
    const file = path.join(dir, n);
    return { file, time: (await fs.stat(file)).mtimeMs };
  }));
  return files.sort((a, b) => b.time - a.time).slice(0, count).map(x => x.file);
}

async function codex() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  for (const file of await newestFiles(path.join(home, 'sessions'), 5)) {
    const text = await fs.readFile(file, 'utf8');
    const at = text.lastIndexOf('"rate_limits":{');
    if (at < 0) continue;
    const line = text.slice(text.lastIndexOf('\n', at) + 1, text.indexOf('\n', at) < 0 ? undefined : text.indexOf('\n', at));
    let limits;
    try { limits = JSON.parse(line)?.payload?.rate_limits; } catch { continue; }
    if (!limits) continue;
    const out = {};
    for (const w of [limits.primary, limits.secondary]) {
      if (!w || w.used_percent == null) continue;
      const key = w.window_minutes <= 600 ? 'five' : 'week';   // 300 分钟 = 5 小时；10080 分钟 = 一周
      out[key] = Math.round(w.used_percent);
      if (w.resets_at) out[key + 'At'] = new Date(w.resets_at * 1000).toISOString();
    }
    if (Object.keys(out).length) return out;
  }
  return null;
}

try {
  const result = {};
  const c = await codex().catch(() => null);
  if (c) result.Codex = c;
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stdout.write('{}\n');
}
