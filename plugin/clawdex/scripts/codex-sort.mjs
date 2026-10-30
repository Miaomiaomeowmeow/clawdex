#!/usr/bin/env node
// Only app-server changes Codex state. Claude configuration is read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const TASK_PREFIX = 'Codex Companion Task';
const HANDOFF_PREFIX = '接着 Claude 那边的活做';
const WINDOW_MS = 15 * 60 * 1000;
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeCwd(value) {
  let cwd = String(value).replaceAll('/', '\\');
  if (cwd.toUpperCase().startsWith('\\\\?\\UNC\\')) cwd = '\\\\' + cwd.slice(8);
  else if (cwd.startsWith('\\\\?\\')) cwd = cwd.slice(4);
  return path.win32.resolve(cwd).replace(/\\+$/, '').toLowerCase();
}

export function shortName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('对话名字不能为空');
  return Array.from(name).slice(0, 60).join('');
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const allowed = {
    task: ['cwd', 'name', 'claude-session'],
    handoff: ['cwd', 'claude-session', 'since'],
    thread: ['id', 'name', 'claude-session'],
    describe: ['claude-session'],
  }[mode];
  if (!allowed) throw new Error('用法：codex-sort.mjs task|handoff|thread|describe --参数 值');
  const options = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (!rest[i]?.startsWith('--') || !allowed.includes(key) ||
        options[key] !== undefined || !rest[i + 1] || rest[i + 1].startsWith('--')) {
      throw new Error(`参数无效：${rest[i] ?? ''}`);
    }
    options[key] = rest[i + 1];
  }
  for (const key of allowed) {
    if (!options[key]?.trim()) throw new Error(`缺少 --${key}`);
  }
  if (mode === 'handoff') {
    options.since = Number(options.since);
    if (!Number.isSafeInteger(options.since) || options.since < 0) {
      throw new Error('--since 必须是毫秒时间戳');
    }
  } else if (mode !== 'describe') options.name = shortName(options.name);
  return options;
}

async function entries(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function* sessionFiles(directory) {
  for (const entry of await entries(directory)) {
    const file = path.join(directory, entry.name);
    // Never follow profile junctions/symlinks during recursive session discovery.
    if (entry.isDirectory()) yield* sessionFiles(file);
    else if (entry.isFile() && /^local_.*\.json$/i.test(entry.name)) yield file;
  }
}

export function findGroup(config, sessionId) {
  let scopes = config.preferences?.epitaxyPrefs?.['dframe-group-scopes'];
  if (typeof scopes === 'string') scopes = JSON.parse(scopes);
  const names = new Set();
  for (const account of Object.values(scopes ?? {})) {
    // 实际是一层（键 = 「账号/组织」，值里直接有 groups、assignments）；也兼容多套一层的写法
    for (const scope of account?.assignments ? [account] : Object.values(account ?? {})) {
      const groupId = scope?.assignments?.[`code:${sessionId}`];
      if (groupId == null) continue;
      const group = scope.groups?.find(item => item.id === groupId);
      if (typeof group?.name === 'string' && group.name.trim()) names.add(group.name);
    }
  }
  if (names.size > 1) throw new Error('Claude 对话在多个账号/组织中对应不同分组，无法确定');
  return [...names][0] ?? null;
}

// 用户左侧栏「全部对话」那一栏怎么排：project = 按文件夹，none = 不分，其余照原样报
export function sortOf(config) {
  for (const scope of Object.values(config.preferences?.epitaxyPrefs?.['dframe-code-sections'] ?? {})) {
    const all = (scope?.sections ?? []).find(item => item.kind === 'sessions');
    if (all) return all.groupBy ?? 'none';
  }
  return null;
}

export async function readClaudeSession(cliSessionId, base = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data')) {
  const matches = [];
  for (const profile of await entries(base)) {
    if (!profile.isDirectory() || !profile.name.startsWith('claude_')) continue;
    const directory = path.join(base, profile.name);
    for await (const file of sessionFiles(path.join(directory, 'claude-code-sessions'))) {
      const session = await readJson(file);
      if (session.cliSessionId !== cliSessionId) continue;
      if (typeof session.sessionId !== 'string' || !session.sessionId.startsWith('local_')) {
        throw new Error('Claude 会话缺少 local_ 编号');
      }
      let config;
      try { config = await readJson(path.join(directory, 'claude_desktop_config.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; config = {}; }
      matches.push({ title: session.title, section: findGroup(config, session.sessionId), groupBy: sortOf(config) });
    }
    // Search every profile: reused/copied session IDs must not silently pick the wrong group.
  }
  if (!matches.length) return { title: null, section: null, groupBy: null };
  const distinct = new Set(matches.map(value => JSON.stringify(value)));
  if (distinct.size > 1) throw new Error('多个 Claude 档案中的会话标题或分组不一致');
  return matches[0];
}

function timed(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  })]).finally(() => clearTimeout(timer));
}

// Fallback transport, used only when the official plugin cannot connect.
class StdioClient {
  constructor(cwd) {
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    // The shell command is constant. No user-controlled argument is interpolated.
    this.proc = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex.cmd app-server'],
        { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.lines.on('line', line => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('app-server 返回无效 JSON')); return; }
      if (message.method && message.id !== undefined) {
        this.send({ id: message.id, error: { code: -32601, message: 'Unsupported request' } });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'app-server 请求失败'));
        else pending.resolve(message.result);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.proc.stdin.on('error', error => this.fail(error));
    this.proc.on('error', error => this.fail(error));
    this.proc.on('exit', code => this.fail(new Error(`app-server 已退出 (${code}) ${this.stderr.trim()}`)));
  }
  fail(error) {
    this.error = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  send(message) { this.proc.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params) {
    if (this.error) return Promise.reject(this.error);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async close() {
    this.lines.close();
    this.proc.stdin.end();
    // Closing stdin shuts down app-server; no shell-built process killing commands.
    if (this.proc.exitCode !== null || this.error) return;
    await timed(new Promise(resolve => this.proc.once('exit', resolve)), 2000, '关闭 app-server')
      .catch(() => this.proc.kill());
  }
}

export async function connect(cwd = process.cwd()) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const cache = path.join(configDir, 'plugins', 'cache', 'openai-codex', 'codex');
  let officialError;
  try {
    const versions = (await entries(cache)).filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name))
      .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    if (!versions.length) throw new Error('未找到官方 Codex 插件');
    const url = pathToFileURL(path.join(cache, versions[0], 'scripts', 'lib', 'app-server.mjs'));
    const { CodexAppServerClient } = await import(url.href);
    return await timed(CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      capabilities: { experimentalApi: true, requestAttestation: false },
    }), 30000, '连接官方 app-server');
  } catch (error) { officialError = error; }
  const client = new StdioClient(cwd);
  try {
    await timed(client.request('initialize', {
      clientInfo: { name: 'clawdex-codex-sort', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }), 30000, '初始化 app-server');
    client.send({ method: 'initialized', params: {} });
    return client;
  } catch (error) {
    await client.close();
    throw new Error(`官方连接失败：${officialError.message}；备用连接失败：${error.message}`);
  }
}

async function request(client, method, params, timeout = 30000) {
  return timed(client.request(method, params), timeout, method);
}

export async function findThread(client, { cwd, since, task, deadline = Infinity, now = Date.now }) {
  let cursor;
  const seen = new Set();
  do {
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    const response = await request(client, 'thread/list', {
      limit: 100, sortKey: 'created_at', sortDirection: 'desc',
      modelProviders: [],
      sourceKinds: SOURCE_KINDS, ...(task ? { searchTerm: TASK_PREFIX } : {}),
      ...(cursor ? { cursor } : {}),
    }, Math.min(30000, remaining));
    if (now() >= deadline) return null;
    for (const thread of response.data) {
      if (task ? thread.createdAt * 1000 < since : thread.createdAt * 1000 <= since) return null;
      if (normalizeCwd(thread.cwd) !== normalizeCwd(cwd)) continue;
      if (task ? thread.name?.startsWith(TASK_PREFIX) : thread.preview?.startsWith(HANDOFF_PREFIX)) {
        return thread;
      }
    }
    cursor = response.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('thread/list 返回重复分页游标');
    seen.add(cursor);
  } while (cursor);
  return null;
}

async function putInSection(client, threadId, name) {
  if (!name) return null;
  let cursor;
  const seen = new Set();
  do {
    const response = await request(client, 'threadSection/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    const section = response.data.find(item => item.name === name);
    if (section) {
      await request(client, 'thread/section/move', { threadId, sectionId: section.id });
      return name;
    }
    cursor = response.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('threadSection/list 返回重复分页游标');
    seen.add(cursor);
  } while (cursor);
  const { section } = await request(client, 'threadSection/create', { name });
  await request(client, 'thread/section/move', { threadId, sectionId: section.id });
  return name;
}

export async function run(options, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const wait = dependencies.sleep || sleep;
  const started = now();
  const deadline = options.mode === 'handoff' ? started + WINDOW_MS : Infinity;
  const claude = await (dependencies.readClaudeSession || readClaudeSession)(options['claude-session']);
  if (options.mode === 'describe') return { ok: true, ...claude };   // 只报左侧栏的样子，不连 Codex
  const name = shortName(options.mode === 'handoff' ? claude.title : options.name);
  const client = await (dependencies.connect || connect)(options.cwd || process.cwd());
  try {
    let threadId = options.id;
    if (options.mode !== 'thread') {
      const since = options.mode === 'task' ? started - WINDOW_MS : options.since;
      do {
        let thread;
        try {
          thread = await findThread(client, { cwd: options.cwd, since, task: options.mode === 'task', deadline, now });
        } catch (error) {
          if (options.mode === 'handoff' && now() >= deadline) return null;
          throw error;
        }
        if (options.mode === 'handoff' && now() >= deadline) return null;
        if (thread) { threadId = thread.id; break; }
        if (options.mode === 'task') throw new Error('最近 15 分钟内未找到匹配的 Codex Companion Task 对话');
        const remaining = deadline - now();
        if (remaining <= 0) return null; // Handoff timeout is deliberately silent.
        await wait(Math.min(5000, remaining));
      } while (now() < deadline);
      if (!threadId) return null;
    }
    await request(client, 'thread/name/set', { threadId, name });
    const section = await putInSection(client, threadId, claude.section);
    return { ok: true, threadId, name, section };
  } finally {
    await timed(Promise.resolve(client.close()), 5000, '关闭连接');
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await run(parseArgs(argv));
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error?.message || String(error) }) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
  // Never make the calling plugin fail, including connection/cleanup errors.
  process.exit(0);
}
