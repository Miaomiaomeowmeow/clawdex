// 克代同堂（真插件 v0.1）：额度 · 委派 · 换号提示 + 把旧号的对话接过来 · 设置
// 浮窗页面在仓库的 pages/
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Level, Mate, Move, Settings, Usage } from '../types'


// 唯一的 AI 清单；CLI 参数据本机 --help。null = 未查证，不能猜。
const KNOWN_AI = [
  { name: 'Codex', display: { zh: 'Codex', en: 'Codex' }, defaultInstall: ["APPDATA","npm/codex.cmd"], command: 'codex', model: null, job: { zh: '照定好的方案写代码、改 bug、写脚本、批量改文件、查资料', en: 'Code from an agreed plan, fix bugs, write scripts, batch-edit files, research' }, auth: { args: ['login', 'status'], homeEnv: null, file: null, envKeys: [], absent: 'unknown' }, install: 'npm.cmd install -g @openai/codex', login: 'codex login', loginCommand: 'codex login', task: { args: ['exec'], read: ['--sandbox', 'read-only'], write: ['--sandbox', 'workspace-write'], prompt: null, model: '--model' } },
  { name: 'Claude', display: { zh: 'Claude', en: 'Claude' }, defaultInstall: ["APPDATA","npm/claude.cmd"], command: 'claude', model: null, job: { zh: '审美和排版、出点子、写给人看的文案、拿主意', en: 'Taste and layout, ideas, copy for people, judgment calls' }, auth: { args: ['auth', 'status'], homeEnv: null, file: null, envKeys: [], absent: 'unknown' }, install: 'npm.cmd install -g @anthropic-ai/claude-code', login: 'claude auth login', loginCommand: 'claude auth login', task: { args: ['-p'], read: ['--permission-mode', 'plan'], write: ['--permission-mode', 'acceptEdits'], prompt: null, model: '--model' } },   // 10-28 用户：Codex 当主 AI 时要能派给 Claude；用的是命令行版登录的号
  { name: 'Kimi', display: { zh: 'Kimi Code', en: 'Kimi Code' }, defaultInstall: null, command: 'kimi', model: null, job: { zh: '读长文、整理文字', en: 'Read long text and organize writing' }, auth: { args: null, homeEnv: null, file: null, envKeys: [], absent: 'unknown' }, install: 'npm.cmd install -g @moonshot-ai/kimi-code', login: 'kimi login', loginCommand: 'kimi login', task: { args: [], read: null, write: [], prompt: '--prompt', model: '--model' } },
  { name: 'Antigravity', display: { zh: 'Gemini', en: 'Gemini' }, defaultInstall: ["LOCALAPPDATA","agy/bin/agy.exe"], command: 'agy', model: null, job: { zh: '查资料、读长文件、照方案改文件', en: 'Research, read long files and implement plans' }, auth: { args: null, homeEnv: null, file: null, envKeys: [], absent: 'unknown' }, install: 'irm https://antigravity.google/cli/install.ps1 | iex', login: 'agy', loginCommand: 'agy', task: { args: ['--print-timeout', '590s'], read: [], write: ['--mode', 'accept-edits'], prompt: '-p', model: '--model' } },
  { name: 'GitHub Copilot', display: { zh: 'GitHub Copilot', en: 'GitHub Copilot' }, defaultInstall: ["APPDATA","npm/copilot.cmd"], command: 'copilot', model: null, job: { zh: '支持 Copilot Free；工具权限组合待验证', en: 'Supports Copilot Free; tool permissions await validation' }, auth: { args: null, homeEnv: null, file: null, envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'], absent: 'unknown' }, install: 'npm.cmd install -g @github/copilot', login: 'copilot login', loginCommand: 'copilot login', task: { args: [], read: null, write: [], prompt: '-p', model: '--model' } },
  { name: 'Cursor', display: { zh: 'Cursor', en: 'Cursor' }, defaultInstall: null, command: 'agent', model: null, job: { zh: 'Ask 只读探索；文件编辑权限待验证', en: 'Ask-mode exploration; edit permissions await validation' }, auth: { args: ['status'], homeEnv: null, file: null, envKeys: ['CURSOR_API_KEY'], absent: 'unknown' }, install: "irm 'https://cursor.com/install?win32=true' | iex", login: 'agent login', loginCommand: 'agent login', task: { args: [], read: ['--mode', 'ask'], write: null, prompt: '-p', model: '--model' } },
] as const
type KnownStatus = { cliOrg?: string; defaultModel?: string | null; lastTrial?: Trial; trialStale?: boolean; install: string | null; notice?: { zh: string; en: string }; failure?: Failure; fingerprint?: string; testing?: boolean; needsNode?: boolean; needsNpm?: boolean; missingOfficialPlugin?: boolean; installMissing?: boolean; capabilities?: { delegate: boolean; readOnly: boolean; readOnlyNote?: { zh: string; en: string }; key: { zh: string; en: string } }; testedAt?: number; blocked?: boolean; command: string; loginCommand: string | null; name: string; display: { zh: string; en: string }; installed: boolean; login: 'yes' | 'no' | 'unknown'; executable?: string; model: string | null; job: { zh: string; en: string } }

// 不经 shell 拼接提示词。Windows npm 的 .cmd 解析出 Node 入口，所有参数通过 stdin JSON 原样传递。
const CLI_RUNNER = `const fs=require('fs'),path=require('path'),cp=require('child_process');
const q=JSON.parse(fs.readFileSync(0,'utf8'));let exe=q.executable,args=q.args;
if(/\\.cmd$/i.test(exe)){const shim=fs.readFileSync(exe,'utf8');const m=shim.match(/"%dp0%[\\\\/]([^"\\r\\n]+\\.(?:m?js|cjs))"/i);if(!m)throw Error('Unsupported CLI launcher');args=[path.resolve(path.dirname(exe),m[1]),...args];exe=process.execPath;}
const r=cp.spawnSync(exe,args,{cwd:process.cwd(),encoding:'utf8',shell:false,windowsHide:true,maxBuffer:8*1024*1024,timeout:q.timeout});
if(r.error)throw r.error;process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`
type Failure = { category: 'login' | 'disabled' | 'timeout' | 'missing' | 'other'; raw: string }
type Trial = { login: 'yes' | 'no'; fingerprint?: string; failure?: Failure; raw: string; testedAt: number }
type Probe = Trial & { fingerprint: string }
const probing = new Set<string>()
function failureOf(raw: string): Failure {
  return { raw, category: /sign\s*in|log\s*in|登录|auth|not logged/i.test(raw) ? 'login' : /no longer supported|停用|discontinued/i.test(raw) ? 'disabled' : /timeout|timed?\s*out|超过 60|超时/i.test(raw) ? 'timeout' : /not installed|not found|ENOENT|没装/i.test(raw) ? 'missing' : 'other' }
}
function fingerprintOf(text: string): string {
  // Never persist credentials or account identifiers in state.json.
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
function knownBlocked(name: string, known: KnownStatus[]): boolean {
  const spec = KNOWN_AI.find(x => x.name === name)
  return !!known.find(x => x.name === name)?.blocked || (!spec?.task.read && !spec?.task.write)
}
async function freshPath($: EngineInterface) {
  const paths: string[] = []
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const r = await $.process.run(['reg', 'query', key, '/v', 'Path'], { timeoutMs: 10000 })
      const m = r.stdout.match(/\bPath\s+REG_\w+\s+(.+)/i)
      if (m) paths.push(m[1]!.trim())
    } catch {}
  }
  paths.push((await $.env.get('PATH')) || '')
  const expand: Record<string, string | undefined> = { USERPROFILE: await $.env.get('USERPROFILE'), APPDATA: await $.env.get('APPDATA'), LOCALAPPDATA: await $.env.get('LOCALAPPDATA'), SystemRoot: await $.env.get('SystemRoot'), ProgramFiles: await $.env.get('ProgramFiles') }
  return paths.join(';').replace(/%([^%]+)%/g, (whole, key: string) => Object.entries(expand).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] || whole)
}
async function findExecutable($: EngineInterface, command: string, path: string) {
  for (const finder of [['where', command], ['which', command]]) {
    try {
      const r = await $.process.run(finder, { env: { PATH: path }, timeoutMs: 10000 })
      if (r.exitCode === 0) {
        const paths = r.stdout.trim().split(/\r?\n/).filter(Boolean)
        const found = paths.find(x => /\.(exe|cmd)$/i.test(x)) ?? paths[0]
        if (found) return found
      }
    } catch {}
  }
  return undefined
}
async function runCLI($: EngineInterface, executable: string, args: readonly string[], timeout: number, cwd?: string) {
  const init = { cwd: cwd ?? await $.session.cwd(), timeoutMs: Math.min(600000, timeout + 5000) }
  if (!/\.cmd$/i.test(executable)) return $.process.run([executable, ...args], init)
  const node = await findExecutable($, 'node', await freshPath($))
  if (!node) throw new Error('Node not installed')
  return $.process.run([node, '-e', CLI_RUNNER], { ...init, stdin: JSON.stringify({ executable, args, timeout }) })
}
async function scanAI($: EngineInterface, only?: string): Promise<KnownStatus[]> {
  const known: KnownStatus[] = []
  const path = await freshPath($)
  const roots: Record<string, string | undefined> = { APPDATA: await $.env.get('APPDATA'), LOCALAPPDATA: await $.env.get('LOCALAPPDATA') }
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const geminiHome = (await $.env.get('GEMINI_CLI_HOME')) || home
  const envKeys: Record<string, string | undefined> = {
    CODEX_HOME: await $.env.get('CODEX_HOME'),
    GEMINI_API_KEY: await $.env.get('GEMINI_API_KEY'),
    GOOGLE_API_KEY: await $.env.get('GOOGLE_API_KEY'),
    GOOGLE_GENAI_USE_VERTEXAI: await $.env.get('GOOGLE_GENAI_USE_VERTEXAI'),
    GOOGLE_CLOUD_PROJECT: await $.env.get('GOOGLE_CLOUD_PROJECT'),
    OPENAI_API_KEY: await $.env.get('OPENAI_API_KEY'),
    BAILIAN_CODING_PLAN_API_KEY: await $.env.get('BAILIAN_CODING_PLAN_API_KEY'),
    COPILOT_GITHUB_TOKEN: await $.env.get('COPILOT_GITHUB_TOKEN'),
    GH_TOKEN: await $.env.get('GH_TOKEN'),
    GITHUB_TOKEN: await $.env.get('GITHUB_TOKEN'),
    CURSOR_API_KEY: await $.env.get('CURSOR_API_KEY'),
  }
  const node = await findExecutable($, 'node', path), npm = await findExecutable($, 'npm', path)
  const tests = ((await $.store.get('aiTests')) || {}) as Record<string, Probe>
  const lastTrials = ((await $.store.get('aiLastTrials')) || {}) as Record<string, Trial>
  const expired = ((await $.store.get('installMissing')) || {}) as Record<string, boolean>
  for (const ai of KNOWN_AI) {
    if (only && ai.name !== only) continue
    let executable = await findExecutable($, ai.command, path)
    if (!executable && ai.defaultInstall) {
      const base = roots[ai.defaultInstall[0]!]
      const candidate = base && base + '/' + ai.defaultInstall[1]
      if (candidate && await $.fs.exists(candidate)) executable = candidate
    }
    let login: KnownStatus['login'] = 'unknown'
    let cliOrg: string | undefined
    let fingerprintText = ''
    let authEvidence = false
    if (executable && ai.auth.args) {
      try {
        const r = await runCLI($, executable, ai.auth.args, 15000)
        const out = `${r.stdout} ${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim()
        fingerprintText += out
        authEvidence = !!out
        if (/not logged in|not signed in|sign\s*in required|未登录/i.test(out)) login = 'no'
        else if (ai.name === 'Codex' && /Logged in/i.test(out)) login = 'yes'
        else if (ai.name === 'Claude') {   // claude auth status 给 JSON：登没登录、哪个组织（拿来对上是 Claude 几号）
          const m = /"loggedIn":\s*(true|false)/.exec(out)
          if (m) login = m[1] === 'true' ? 'yes' : 'no'
          cliOrg = /"orgId":\s*"([^"]+)"/.exec(out)?.[1]
        }
      } catch {}
    }
    for (const key of ai.auth.envKeys) { fingerprintText += key + ':' + (envKeys[key] || '') + ';'; if (envKeys[key]?.trim()) authEvidence = true }
    // Metadata only: do not read token contents. Missing files change the fingerprint too.
    const files = (ai.name as string) === 'Gemini' ? [geminiHome + '/.gemini/oauth_creds.json'] : ai.name === 'Codex' ? [(envKeys.CODEX_HOME || home + '/.codex') + '/auth.json'] : (ai.name as string) === 'Qwen' ? [home + '/.qwen/oauth_creds.json'] : ai.name === 'Kimi' ? [home + '/.kimi/credentials.json'] : ai.name === 'GitHub Copilot' ? [home + '/.copilot/config.json'] : ai.name === 'Antigravity' ? [home + '/.gemini/antigravity/auth.json', (roots.LOCALAPPDATA || home) + '/agy/auth.json'] : ai.name === 'Cursor' ? [home + '/.cursor/auth.json'] : []
    for (const file of files) {
      try { fingerprintText += file + ':' + (await $.fs.stat(file)).mtimeMs; authEvidence = true } catch { fingerprintText += file + ':missing' }
    }
    // Unknown credential formats: no durable success reuse across scans.
    const fingerprint = authEvidence ? fingerprintOf(fingerprintText) : undefined
    const key = ai.name + ':' + fingerprint
    if (login === 'no') {
      for (const k of Object.keys(tests)) if (k.startsWith(ai.name + ':')) delete tests[k]
      if (lastTrials[ai.name]?.failure?.category !== 'login') lastTrials[ai.name] = { login: 'no', fingerprint, failure: failureOf('Not logged in'), raw: 'Not logged in', testedAt: await $.clock.now() }
    }
    const tested = fingerprint && login !== 'no' && tests[key]?.login === 'yes' ? tests[key] : undefined
    const enterprise = /^(true|1)$/i.test(envKeys.GOOGLE_GENAI_USE_VERTEXAI?.trim() || '')
    const hasGeminiKey = !!(envKeys.GEMINI_API_KEY?.trim() || envKeys.GOOGLE_API_KEY?.trim())
    const blocked = (ai.name as string) === 'Gemini' && !hasGeminiKey && !enterprise
    const notice = blocked ? { zh: 'Google 已停用个人账号用 Gemini 命令行，请改用 Antigravity 或填 Key', en: 'Personal Gemini CLI access has ended. Use Antigravity or configure a Key.' } : (ai.name as string) === 'Qwen' ? { zh: '免费登录已停，要填 Key 或买套餐', en: 'Free sign-in has ended. Configure a Key or purchase a plan.' } : undefined
    if (executable && (tested || (!fingerprint && lastTrials[ai.name]?.login === 'yes'))) login = 'yes'
    if (blocked) login = 'no'
    known.push({ install: ai.install, notice, blocked, lastTrial: lastTrials[ai.name], trialStale: !!lastTrials[ai.name] && (!fingerprint || lastTrials[ai.name]?.fingerprint !== fingerprint), failure: login === 'yes' ? undefined : lastTrials[ai.name]?.failure, testedAt: lastTrials[ai.name]?.testedAt, fingerprint, testing: probing.has(ai.name), needsNode: ai.install.startsWith('npm.') && !node, needsNpm: ai.install.startsWith('npm.') && !npm, missingOfficialPlugin: ai.name === 'Codex' && !(await codexScript($)), installMissing: !!expired[ai.name] && !executable, capabilities: { delegate: !!(ai.task.read || ai.task.write), readOnly: !!ai.task.read, readOnlyNote: ai.name === 'Antigravity' ? { zh: '只读：已实测（无人值守时写文件、跑命令都会被自动拒绝，只能读）', en: 'Read-only tested: unattended runs auto-deny writes and terminal commands; reads only' } : undefined, key: (ai.name as string) === 'Gemini' ? { zh: '需 Key 或企业认证', en: 'Key or enterprise authentication required' } : (ai.name as string) === 'Qwen' ? { zh: '需 Key 或套餐', en: 'Key or paid plan required' } : { zh: '可用账号登录，不必填 Key', en: 'Account sign-in supported; no Key required' } }, command: ai.command, loginCommand: ai.loginCommand, name: ai.name, display: ai.display, installed: !!executable, login, executable, model: ai.model, cliOrg, defaultModel: ai.name === 'Codex' ? await codexDefaultModel($, (envKeys.CODEX_HOME || home + '/.codex') + '/config.toml') : null, job: ai.job })
  }
  await $.store.set('aiLastTrials', lastTrials)
  await $.store.set('aiTests', tests)
  const previous = ((await $.store.get('known')) as KnownStatus[] | undefined) ?? []
  const merged = only ? [...previous.filter(ai => ai.name !== only), ...known] : known
  await $.store.set('known', merged)
  return merged
}
function capabilitiesText(ai: KnownStatus, en: boolean): string {
  const c = ai.capabilities
  if (!c) return ''
  return [en ? ai.display.en : ai.display.zh, en ? (c.delegate ? 'Delegation supported' : 'Delegation unavailable') : (c.delegate ? '能接委派' : '暂不接委派'), en ? (c.readOnly ? 'Read-only delegation supported' : 'Can take file-editing tasks; read-only tasks are not assigned yet') : (c.readOnly ? '支持只读派活' : '能接改文件的活；只读的活暂不派'), en ? c.key.en : c.key.zh, c.readOnlyNote ? (en ? c.readOnlyNote.en : c.readOnlyNote.zh) : ''].filter(Boolean).join(' · ')
}

const PANE = 'clawdex'
const DELEGATE_TO = ['Claude', 'Codex']   // 现在能接委派的（10-28 用户：委派先只做 Claude 和 Codex）
const NOT_MATES = ['小克', '另一个 Claude 号']
// 插件替用户写的默认「负责什么」，中英各一句（用户自己改过的不动）
const JOB = { zh: '照定好的方案写代码、改 bug、写脚本、批量改文件、查资料', en: 'Code from an agreed plan, fix bugs, write scripts, batch-edit files, research' }
function floatDir($: EngineInterface): string { return $.plugin.root + '/../../float' }
function normalizeModel(model?: string | null): string { return !model || ['默认', 'Default', 'default'].includes(model) ? 'default' : model }
function mateId(m: Mate, list: Mate[]): string { return m.id || m.name + '#' + (list.slice(0, list.indexOf(m)).filter(x => x.name === m.name).length + 1) }
async function language($: EngineInterface) {
  const en = (await $.store.get('lang')) === 'en'
  return (zh: string, english: string) => en ? english : zh
}
const DEFAULT: Settings = { mode: 'quota', mates: [] }
// 读设置：新开对话时设置可能还没准备好（10-28 报错 s.mates undefined），读不到就用存好的那份，再不行用默认值
async function readSettings($: EngineInterface): Promise<Settings> {
  const s = (await read($, { plugin: 'clawdex', key: 'settings' })) as Settings | undefined
  if (s && Array.isArray(s.mates)) return s
  const stored = (await $.store.get('settings')) as Settings | undefined
  return stored && Array.isArray(stored.mates) ? stored : DEFAULT
}

const usageA = atom({ plugin: 'clawdex', key: 'usage' } as const, null)
const setA = atom({ plugin: 'clawdex', key: 'settings' } as const, DEFAULT)
const moveA = atom({ plugin: 'clawdex', key: 'move' } as const, null)
const jobA = atom({ plugin: 'clawdex', key: 'job' } as const, null)
const helpA = atom({ plugin: 'clawdex', key: 'help' } as const, false)
const floatA = atom({ plugin: 'clawdex', key: 'float' } as const, false)

// 五段姿势：跟小样跑道一样的分界
const POSES = ['rocket', 'skate', 'run', 'drag', 'down'] as const
const stage = (u: number) => (u < 30 ? 0 : u < 60 ? 1 : u < 85 ? 2 : u < 95 ? 3 : 4)
const POSE_ZH = ['火箭', '滑板', '跑', '拖着脚', '趴下']

const CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'default']
const LEVELS: Level[] = ['关', '低', '中', '高']
const LEVEL_SAY: Record<Level, string> = {
  关: '不派',
  低: '只派明显机械、量大的活',
  中: '照着做就行的活都派',
  高: '能派的都派，自己只留拿主意、审美的活',
}

const HELP = `**委派**：照着做就行的小活，主 AI 交给别的 AI 做。交之前主 AI 先把大方向想好，写一张交接单：要做什么、照什么思路做、动哪些文件、做完什么样算好、哪些别碰。做完交回来，主 AI 检查过才告诉你。一件活好几个 AI 都能接时：按额度 = 交给剩得最多的；自定顺序 = 排前面的先接。

**额度**：输入框上方的小克就是这个号的额度：火箭、滑板、跑、拖着脚、趴下，越往后越累。

**换号**：在 Claude 里退出、登录 Claude 2 → 小克头顶冒「换到 Claude 2 了 · 接过来旧号的对话？」→ 点「接过来」→ Claude 里开一个新对话，第一句「搬家」已写好 → 按发送 → 旧号最近 7 天没归档的对话搬过来。原来的对话保留。交给 Codex 前倒数 3 秒，期间可点「撤销」。别家 AI 的第二个号：右键 → 管理队友 → 换号，加一下。`

// 读图只读一次
const pics: Record<string, string> = {}

const fmtTime = (iso: string | null, withDay: boolean) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return withDay ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm
}

const cmpVer = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

// Claude 的文件夹（技能、插件都在这）
async function configDir($: EngineInterface) {
  const c = await $.env.get('CLAUDE_CONFIG_DIR')
  if (c) return c
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.claude`
}

// 当前活动归属由所有对话共享；本会话最近活动时间单独保存。
async function markActive($: EngineInterface) {
  const at = Date.now()
  await $.store.set('activeAt', at)
  await $.fs.write((await configDir($)) + '/clawdex/active.json', JSON.stringify({ session: await $.session.id(), at }))
}

// 写给桌面浮窗：额度、设置、正在委派什么
async function writeState($: EngineInterface) {
  const st = {
    usage: await read($, { plugin: 'clawdex', key: 'usage' }), settings: await read($, { plugin: 'clawdex', key: 'settings' }), job: await read($, { plugin: 'clawdex', key: 'job' }), move: await read($, { plugin: 'clawdex', key: 'move' }), at: Date.now(),
    known: ((await $.store.get('known')) as KnownStatus[] | undefined ?? []).map(({ executable, ...ai }) => ai),
    lang: (await $.store.get('lang')) ?? 'zh',
    quota: (await $.store.get('quota')) ?? {},   // 队友自己记录里的额度（scripts/mate-quota.mjs 读的）
    account: (await $.store.get('claudeAccount')) ?? { ai: 'Claude', label: 'Claude' },
    claudeAccount: (await $.store.get('claudeAccount')) ?? { ai: 'Claude', label: 'Claude' },
    accounts: (await $.store.get('claudeAccounts')) ?? [],
    claudeCurrentId: (await $.store.get('claudeCurrentId')) ?? null,   // 桌面正在用的号（号码，名字以浮窗那份为准）
    claudeOrgMap: (await $.store.get('claudeOrgMap')) ?? {},
    handoff: (await $.store.get('handoff')) ?? null,
    active: { ai: 'Claude', at: ((await $.store.get('activeAt')) as number | undefined) ?? 0 },   // 你最近一次在 Claude 里说话的时间：浮窗拿它把主角换回 Claude
  }
  try {
    const base = (await configDir($)) + '/clawdex'
    let active: { session?: string; at?: number } = {}
    try { active = JSON.parse(String(await $.fs.read(base + '/active.json'))) } catch {}
    if (active.session && active.session !== await $.session.id() && (active.at ?? 0) > (((await $.store.get('activeAt')) as number | undefined) ?? 0)) {
      let previous: Record<string, unknown> = {}
      try { previous = JSON.parse(String(await $.fs.read(base + '/state.json'))) } catch {}
      // 设置、名单仍更新；旧对话不能覆写新对话的额度、账号及活动归属。
      const outgoing: Record<string, unknown> = { ...st }
      for (const key of ['usage', 'quota', 'account', 'claudeAccount', 'accounts', 'active']) {
        delete outgoing[key]
        if (Object.prototype.hasOwnProperty.call(previous, key)) outgoing[key] = previous[key]
      }
      await $.fs.write(base + '/state.json', JSON.stringify(outgoing))
    } else await $.fs.write(base + '/state.json', JSON.stringify(st))
  } catch {
    // 写不了就算了，浮窗下次再读
  }
}

// 只读 Claude 应用会话文件；编号按第一次见到的账号排列，不读凭证。
async function identifyClaude($: EngineInterface) {
  let accountId: string | null = null
  const orgCount: Record<string, Record<string, number>> = {}   // 号 → 各组织底下有几个对话；对话最多的那个才是这个号的组织（换号时另一个组织会顺手建一个空的）
  try {
    const local = await $.env.get('LOCALAPPDATA')
    const sessionId = await $.session.id()
    const base = local ? local + '/Claude-Data' : ''
    if (base && await $.fs.exists(base)) {
      for (const app of await $.fs.list(base)) {
        if (app.kind !== 'dir' || !app.name.startsWith('claude_')) continue
        const sessions = base + '/' + app.name + '/claude-code-sessions'
        if (!(await $.fs.exists(sessions))) continue
        for (const account of await $.fs.list(sessions)) {
          if (account.kind !== 'dir') continue
          const accountPath = sessions + '/' + account.name
          for (const org of await $.fs.list(accountPath)) {
            if (org.kind !== 'dir') continue
            const dir = accountPath + '/' + org.name
            for (const file of await $.fs.list(dir)) {
              if (file.kind !== 'file' || !/^local_.*\.json$/.test(file.name)) continue
              const c = (orgCount[account.name] ??= {}); c[org.name] = (c[org.name] ?? 0) + 1
              try {
                const data = JSON.parse(String(await $.fs.read(dir + '/' + file.name)))
                if (data.cliSessionId === sessionId) accountId = account.name
              } catch {}
            }
          }
        }
      }
    }
  } catch {} // 查不到时只写 Claude，不猜编号。
  const orgMap = Object.fromEntries(Object.entries(orgCount).map(([acc, c]) => [acc, [Object.entries(c).sort((a, b) => b[1] - a[1])[0]![0]]]))
  await $.store.set('claudeOrgMap', orgMap)
  if (accountId) await $.store.set('claudeCurrentId', accountId)
  const ids = ((await $.store.get('claudeAccountIds')) as string[] | undefined) ?? []
  if (accountId && !ids.includes(accountId)) ids.push(accountId)
  await $.store.set('claudeAccountIds', ids)
  // 号的名字以浮窗那份为准（clawdex/accounts.json，浮窗从 Claude 自己的登录记录认的；10-28 插件自己编号把 Claude 2 叫成了 Claude 1）
  let registry: { id: string; name: string; ai: string }[] = []
  try { registry = (JSON.parse(String(await $.fs.read((await configDir($)) + '/clawdex/accounts.json'))).accounts ?? []).filter((a: { ai?: string }) => a.ai === 'Claude') } catch {}
  const accounts = registry.length ? registry.map(a => ({ ai: 'Claude', name: a.name, id: a.id })) : ids.map((_, i) => ({ ai: 'Claude', name: 'Claude ' + (i + 1) }))
  await $.store.set('claudeAccounts', accounts)
  const named = registry.find(a => a.id === accountId)
  const account = { ai: 'Claude', label: named ? named.name : accountId && !registry.length ? 'Claude ' + (ids.indexOf(accountId) + 1) : 'Claude' }
  await $.store.set('claudeAccount', account)
  await $.store.set('account', account)
}

// 队友额度：scripts/mate-quota.mjs 去读它自己的记录（Codex 的对话记录里写着用了多少、几点回满）
async function readQuota($: EngineInterface) {
  const script = `${$.plugin.root}/scripts/mate-quota.mjs`
  try {
    const r = await $.process.run(['node', script], { timeoutMs: 30000 })
    const q = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || '{}')
    if (JSON.stringify(q) !== JSON.stringify(await $.store.get('quota'))) { await $.store.set('quota', q); await writeState($) }
  } catch {}
}

// 同一个队友不存两遍（10-28 名单里出现了两个一模一样的 Codex）
function uniqMates(list: Mate[]): Mate[] {
  const seen = new Set<string>()
  return list.map(m => ({ ...m, id: mateId(m, list), model: normalizeModel(m.model) })).filter(m => {
    if (seen.has(m.id)) return false
    seen.add(m.id); return true
  })
}

type SettingsEdits = { removedIds: string[]; patches: { id: string; fields: Partial<Mate> }[]; added: Mate[]; orderIds: string[] | null; mode?: Settings['mode'] }
// Only the named slots move; the main actor and concurrent additions keep their positions.
function reorderMates(list: Mate[], ids: string[]): Mate[] {
  const byId = new Map(list.map(m => [mateId(m, list), m]))
  const ordered = [...new Set(ids)].filter(id => byId.has(id))
  const moving = new Set(ordered)
  let at = 0
  return list.map(m => moving.has(mateId(m, list)) ? byId.get(ordered[at++]!)! : m)
}
function applyMateEdits(latest: Mate[], edits: SettingsEdits): Mate[] {
  let mates = latest.filter(m => !edits.removedIds.includes(mateId(m, latest))).map(m => {
    const patch = edits.patches.find(p => p.id === mateId(m, latest))
    return patch ? { ...m, ...patch.fields, id: mateId(m, latest), name: m.name } : m
  })
  for (const m of edits.added) if (!NOT_MATES.includes(m.name) && !mates.some(x => mateId(x, mates) === m.id)) mates.push({ ...m, addedBy: 'manual' })
  if (edits.orderIds) mates = reorderMates(mates, edits.orderIds)
  return mates
}

function usableAI(ai?: KnownStatus): boolean {
  return !!ai?.installed && ai.login === 'yes' && !ai.blocked && (ai.name === 'Codex' || ai.name === 'Claude' || ai.lastTrial?.login === 'yes')
}
function reconcileTeam(s: Settings, known: KnownStatus[], migrate: boolean): Settings {
  let mates = s.mates.filter(m => {
    const ai = known.find(k => k.name === m.name)
    return !(migrate && ['Gemini', 'Qwen', 'Kimi', 'Antigravity'].includes(m.name) && !m.addedBy && (!m.id || m.id === m.name + '#1') && (!ai || [ai.job.zh, ai.job.en].includes(m.job) || (m.name === 'Antigravity' && m.job === '查资料、读长文件、照方案改文件')) && ai?.lastTrial?.login !== 'yes' && !usableAI(ai) && ['default','默认','Default'].includes(m.model) && !m.models?.some(x=>x.mine) && !(m.jobs || []).some(j => j.src === '我'))
  })
  for (const ai of known) if (usableAI(ai) && !(s.removed || []).includes(ai.name) && !mates.some(m => m.name === ai.name)) {
    mates.push({ id: ai.name + '#1', name: ai.name, model: ai.model ?? 'default', job: ai.job.zh, level: '中', addedBy: 'auto', installed: true, login: 'yes' })
  }
  return { ...s, mates }
}
async function saveSettings($: EngineInterface, s: Settings) {
  const known = ((await $.store.get('known')) as KnownStatus[] | undefined) ?? []
  s = { ...s, mates: uniqMates(s.mates).map(m => { const ai = known.find(x => x.name === m.name); return { ...m, installed: ai?.installed ?? false, login: ai?.login ?? 'unknown' } }) }
  await update($, { plugin: 'clawdex', key: 'settings' }, () => s)
  await $.store.set('settings', s)
  await writeState($)
}


// Qwen 的 settings.json 可配置其他 provider；Kimi 的 TOML / 系统凭证无法只凭文件存在判断。
// 上述两家未确认的缺省状态保留 unknown，不把普通配置文件当作登录凭证。
type LoginWatch = Record<string, { next: number; end: number }>
async function rescanLogin($: EngineInterface, only?: string) {
  const known = await scanAI($, only)
  const s = (await readSettings($))
  await saveSettings($, reconcileTeam({ ...s, mates: s.mates.map(m => {
    const ai = known.find(ai => ai.name === m.name)
    return { ...m, installed: ai?.installed ?? false, login: ai?.login ?? 'unknown' }
  }) }, known, false))
  const watches = ((await $.store.get('loginWatch')) as LoginWatch | undefined) ?? {}
  for (const ai of known) if (ai.login === 'yes') delete watches[ai.name]
  await $.store.set('loginWatch', watches)
  return known
}
// The lock is acquired before any await; inbox remains free to handle other messages.
function startTry($: EngineInterface, name?: string) {
  if (!name || probing.has(name) || !KNOWN_AI.some(ai => ai.name === name)) return
  probing.add(name)
  void tryAI($, name).catch(async e => {
    const L = await language($)
    const known = ((await $.store.get('known')) || []) as KnownStatus[]
    await $.store.set('known', known.map(ai => ai.name === name ? { ...ai, testing: false, failure: failureOf(String(e)) } : ai))
    await writeState($)
    $.ui.toast(L('试用失败，请再试一次', 'Test failed. Try again.'))
  }).finally(() => probing.delete(name))
}
async function probeFolder($: EngineInterface): Promise<string> {
  const folder = (await configDir($)) + '/clawdex/trial'
  const script = "$p=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8).ReadToEnd(); [IO.Directory]::CreateDirectory($p) | Out-Null"
  const r = await $.process.run(['powershell', '-NoProfile', '-Command', script], { stdin: folder, timeoutMs: 10000 })
  if (r.exitCode !== 0) throw new Error(r.stderr || 'Trial folder creation failed')
  return folder
}
function isTrialReply(raw: string): boolean {
  return /^(好|ok)$/i.test(raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\s\p{P}]/gu, ''))
}
async function tryAI($: EngineInterface, name?: string) {
  const L = await language($)
  let folder: string | undefined
  let ai: KnownStatus | undefined
  let failure: Failure | undefined
  let raw = ''
  try {
    const pending = ((await $.store.get('known')) || []) as KnownStatus[]
    await $.store.set('known', pending.map(ai => ai.name === name ? { ...ai, testing: true } : ai))
    await writeState($)
    const known = await scanAI($, name)
    ai = known.find(x => x.name === name)
    const spec = KNOWN_AI.find(x => x.name === name)
    await writeState($)
    if (!ai?.executable || !spec) throw new Error('not installed')
    if (ai.blocked) throw new Error('no longer supported')
    folder = await probeFolder($)
    const args: string[] = [...spec.task.args, ...(spec.task.read || [])]
    if (spec.name === 'Antigravity') args.splice(0, 2, '--print-timeout', '60s')
    if (spec.task.prompt) args.push(spec.task.prompt)
    args.push(L('只回一个字：好', 'Reply with one word: OK'))
    const started = await $.clock.now()
    const r = await runCLI($, ai.executable, args, 60000, folder)
    if ((await $.clock.now()) - started > 60000) throw new Error('timeout')
    raw = `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`
    if (r.exitCode !== 0 || !isTrialReply(r.stdout)) throw new Error(raw.trim() || 'No reply')
  } catch (e) {
    if (!raw) raw = String(e instanceof Error ? e.message : e)
    failure = failureOf(raw)
  }
  const testedAt = await $.clock.now()
  if (name) {
    const trial: Trial = { login: failure ? 'no' : 'yes', fingerprint: ai?.fingerprint, failure, raw, testedAt }
    const lastTrials = ((await $.store.get('aiLastTrials')) || {}) as Record<string, Trial>
    lastTrials[name] = trial
    await $.store.set('aiLastTrials', lastTrials)
    const tests = ((await $.store.get('aiTests')) || {}) as Record<string, Probe>
    for (const key of Object.keys(tests)) if (key.startsWith(name + ':')) delete tests[key]
    if (!failure && ai?.fingerprint) tests[name + ':' + ai.fingerprint] = { ...trial, fingerprint: ai.fingerprint }
    await $.store.set('aiTests', tests)
  }
  await rescanLogin($, name)
  const latest = ((await $.store.get('known')) || []) as KnownStatus[]
  await $.store.set('known', latest.map(k => k.name === name ? { ...k, testing: false, ...(ai && ai.fingerprint === k.fingerprint && !k.blocked && k.login !== 'no' ? { login: failure ? 'no' as const : 'yes' as const } : {}) } : k))
  const finalKnown = ((await $.store.get('known')) || []) as KnownStatus[]
  if (!failure && name) {
    const s = (await readSettings($))
    await saveSettings($, reconcileTeam({ ...s, removed: (s.removed || []).filter(n => n !== name) }, finalKnown, false))
  }
  await writeState($)
}
async function installOfficial($: EngineInterface) {
  const L = await language($)
  $.ui.toast(L('装好后在 Claude 里重开一次对话才生效', 'After installation, start a new conversation in Claude for it to take effect.'))
  // README: /plugin marketplace add ..., /plugin install ...; run these official commands in a visible Claude terminal.
  await $.process.run(['cmd', '/c', 'start', '""', 'cmd', '/k', 'claude.cmd plugin marketplace add openai/codex-plugin-cc && claude.cmd plugin install codex@openai-codex'], { timeoutMs: 10000 })
}
async function startInstall($: EngineInterface, name?: string) {
  const spec = KNOWN_AI.find(x => x.name === name)
  if (!spec?.install) return
  const known = await scanAI($, name)
  if (known.find(x => x.name === name)?.installed) return
  // 只接受设置页确认后发来的名字；安装命令仅从固定清单取。
  const prereq = known.find(x => x.name === name)
  const installCommand = (prereq?.needsNode || prereq?.needsNpm) ? "winget install OpenJS.NodeJS.LTS; if ($LASTEXITCODE -eq 0) { $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); " + spec.install + " }" : spec.install
  const r = await $.process.run(['cmd', '/c', 'start', '""', 'powershell', '-NoExit', '-Command', installCommand], { cwd: await $.session.cwd(), timeoutMs: 10000 })
  const L = await language($)
  if (r.exitCode !== 0) { $.ui.toast(L('安装窗口没能打开', 'Could not open the installer')); return }
  const watches = ((await $.store.get('installWatch')) || {}) as LoginWatch
  const now = await $.clock.now()
  watches[spec.name] = { next: now + 5000, end: now + 600000 }
  await $.store.set('installWatch', watches)
}
async function pollInstalls($: EngineInterface) {
  const watches = ((await $.store.get('installWatch')) || {}) as LoginWatch
  const now = await $.clock.now()
  for (const [name, watch] of Object.entries(watches)) {
    if (now > watch.end) { delete watches[name]; const missing = ((await $.store.get('installMissing')) || {}) as Record<string, boolean>; missing[name] = true; await $.store.set('installMissing', missing); await rescanLogin($, name); continue }
    if (now < watch.next) continue
    watch.next = now + 5000
    const known = await rescanLogin($, name)
    if (known.find(x => x.name === name)?.installed) { delete watches[name]; startTry($, name) }
  }
  await $.store.set('installWatch', watches)
}
async function startLogin($: EngineInterface, name?: string) {
  const spec = KNOWN_AI.find(ai => ai.name === name)
  const L = await language($)
  if (!spec?.loginCommand) return
  try {
    // 命令只取固定清单，不拼接消息里的 ai 或任意用户输入。
    const r = await $.process.run(['cmd', '/c', 'start', '""', 'cmd', '/k', ((await $.store.get('known')) as KnownStatus[] | undefined)?.find(x => x.name === name)?.executable ? '"' + ((await $.store.get('known')) as KnownStatus[]).find(x => x.name === name)!.executable + '"' + (spec.loginCommand.slice(spec.command.length)) : spec.loginCommand], { cwd: await $.session.cwd(), timeoutMs: 10000 })
    if (r.exitCode !== 0) throw new Error('start failed')
    const now = await $.clock.now()
    const watches = ((await $.store.get('loginWatch')) as LoginWatch | undefined) ?? {}
    watches[spec.name] = { next: now + 30000, end: now + 600000 }
    await $.store.set('loginWatch', watches)
  } catch {
    $.ui.toast(L('登录窗口没能打开，请在终端里运行 ' + spec.loginCommand, 'Could not open sign-in. Run in a terminal: ' + spec.loginCommand))
  }
}
async function pollLogins($: EngineInterface) {
  await pollInstalls($)
  const watches = ((await $.store.get('loginWatch')) as LoginWatch | undefined) ?? {}
  const now = await $.clock.now()
  for (const [name, watch] of Object.entries(watches)) {
    if (now > watch.end) { delete watches[name]; continue }
    if (now < watch.next) continue
    // 先推进下次时间；复用现有 inbox 循环，不启动重复的无限计时器。
    watch.next = now + 30000
    await $.store.set('loginWatch', watches)
    const known = await rescanLogin($, name)
    if (known.find(ai => ai.name === name)?.login === 'yes' || now >= watch.end) delete watches[name]
  }
  await $.store.set('loginWatch', watches)
}

// 收浮窗的消息：改了设置 / 要打开设置面板
async function readInbox($: EngineInterface) {
  const file = `${await configDir($)}/clawdex/inbox.json`
  if (!(await $.fs.exists(file))) return
  let list: { type?: string; ai?: string; from?: string; mates?: Mate[]; edits?: SettingsEdits; mate?: Mate; ids?: string[]; patches?: { id: string; fields: Partial<Mate> }[]; mode?: string; to?: string; requestId?: string }[] = []
  try {
    list = JSON.parse(String(await $.fs.read(file)))
  } catch {
    return
  }
  if (!Array.isArray(list) || !list.length) return
  await $.fs.write(file, '[]')
  for (const a of list) {
    if (a.type === 'login') await startLogin($, a.ai)
    if (a.type === 'install') await startInstall($, a.ai)
    if (a.type === 'try') startTry($, a.ai)
    if (a.type === 'install-official') await installOfficial($)
    if (a.type === 'rescan') await rescanLogin($)
    if (a.type === 'settings' && a.from === 'settings' && Array.isArray(a.mates)) {
      a.mates = a.mates.filter(x => !NOT_MATES.includes(x.name))   // Claude 自己的号不是派活的队友
      if (!a.mates.length && a.from !== 'settings') continue   // 一个队友都没有的设置不收（10-27 浮窗交棒后把 Codex 冲掉了）
      const s = (await readSettings($))
      const mode = a.mode === 'order' || a.mode === 'quota' ? a.mode : s.mode
      let removed = s.removed || []
      if (a.from === 'settings') {
        const names = new Set((a.edits ? applyMateEdits(s.mates, a.edits) : a.mates).map(m => m.name))
        removed = [...new Set([...removed, ...s.mates.filter(m => !names.has(m.name)).map(m => m.name)])].filter(n => !names.has(n))
      }
      await saveSettings($, { ...s, mates: a.edits ? applyMateEdits(s.mates, a.edits) : a.mates, removed, mode: a.edits ? a.edits.mode ?? s.mode : mode })
    }
    if (a.type === 'mate-add' && a.mate && typeof a.mate.id === 'string' && typeof a.mate.name === 'string' && !NOT_MATES.includes(a.mate.name)) {
      const s = (await readSettings($))
      if (!s.mates.some(m => mateId(m, s.mates) === a.mate!.id)) {
        await saveSettings($, { ...s, mates: [...s.mates, { ...a.mate, addedBy: 'manual' }] })
      } else await writeState($)
    }
    if (a.type === 'mate-order' && Array.isArray(a.ids) && a.ids.every(id => typeof id === 'string')) {
      const s = (await readSettings($))
      const mates = reorderMates(s.mates, a.ids)
      await saveSettings($, { ...s, mates })
    }
    if (a.type === 'mate-patch' && Array.isArray(a.patches)) {
      const s = (await readSettings($))
      const mates = s.mates.map(m => {
        const p = a.patches!.find(p => p.id === mateId(m, s.mates))
        if (!p) return m
        const next = { ...m }
        for (const key of ['model', 'job', 'icon', 'models', 'jobs', 'level'] as const) {
          if (Object.prototype.hasOwnProperty.call(p.fields, key)) Object.assign(next, { [key]: p.fields[key] })
        }
        return next
      })
      await saveSettings($, { ...s, mates })
    }
    if (a.type === 'open-settings') await $.ui.open({ id: PANE, title: (await language($))('克代同堂', 'Clawdex'), focus: true })
    if (a.type === 'move') {
      await update($, { plugin: 'clawdex', key: 'move' }, () => null)
      await writeState($)
      await $.prompt.submit({ text: (await language($))('搬家', 'Use the account-move skill to bring over unfinished conversations from the previous account. Report in English.') })
    }
    if (a.type === 'nomove') {
      const mv = await read($, { plugin: 'clawdex', key: 'move' })
      if (mv) await $.store.set('moveDismissed', mv.sig)
      await update($, { plugin: 'clawdex', key: 'move' }, () => null)
      await writeState($)
    }
    if (a.type === 'closed') await $.store.set('floatClosed', true)
    if (a.type === 'lang' && (a.to === 'en' || a.to === 'zh')) {   // 浮窗换了语言：默认那句「负责什么」跟着换
      await $.store.set('lang', a.to)
      await writeState($)
    }
    // 浮窗里交棒：Codex 用官方链接开新对话；Gemini（Antigravity）开一个窗口带着第一句开始（10-28 用户：换号要有 Gemini）
    if (a.type === 'handoff' && (a.to === 'Codex' || a.to === 'Antigravity')) await handToCodex($, a.requestId, a.to)
  }
}

// 浮窗开着吗：浮窗每秒写一次 float-alive.json
async function checkFloat($: EngineInterface) {
  const file = `${await configDir($)}/clawdex/float-alive.json`
  let alive = false
  try {
    if (await $.fs.exists(file)) alive = (await $.clock.now()) - (await $.fs.stat(file)).mtimeMs <= 15000
  } catch {
    alive = false
  }
  if (alive !== (await read($, { plugin: 'clawdex', key: 'float' }))) await update($, { plugin: 'clawdex', key: 'float' }, () => alive)
  const closed = await $.fs.exists((await configDir($)) + '/clawdex/float-closed.json')
  if (alive && !closed) await $.store.set('floatClosed', false)
  if (!alive && !closed && (await $.store.get('floatClosed')) !== true) {
    const now = await $.clock.now()
    const last = ((await $.store.get('floatLaunchAt')) as number | undefined) ?? 0
    if (now - last > 15000) await openFloat($)
  }
}


// Codex 自己设的默认模型（config.toml 第一层的 model = "…"）：页面上「默认」后面写出来（10-28 用户：模型名没同步）
async function codexDefaultModel($: EngineInterface, file: string) {
  try {
    if (!(await $.fs.exists(file))) return null
    for (const line of String(await $.fs.read(file)).split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break
      const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line)
      if (m) return m[1]
    }
  } catch {}
  return null
}

// Codex 官方插件的脚本在哪（找最新的版本）
async function codexScript($: EngineInterface) {
  const base = `${await configDir($)}/plugins/cache/openai-codex/codex`
  if (!(await $.fs.exists(base))) return null
  const vers = (await $.fs.list(base)).filter(x => x.kind === 'dir').map(x => x.name).sort(cmpVer)
  if (!vers.length) return null
  const script = `${base}/${vers[vers.length - 1]}/scripts/codex-companion.mjs`
  return await $.fs.exists(script) ? script : null
}

// Codex 那边的对话改成好认的名字、放进跟 Claude 左侧栏同名的分组（scripts/codex-sort.mjs，只用 Codex 官方接口；10-28 用户：名字全是 Codex Companion Task 分不清）
async function codexSort($: EngineInterface, args: string[], wait: boolean) {
  const sorter = `${$.plugin.root}/scripts/codex-sort.mjs`
  if (!(await $.fs.exists(sorter))) return
  const argv = [...args, '--cwd', await $.session.cwd(), '--claude-session', await $.session.id()]
  try {
    if (wait) await $.process.run(['node', sorter, ...argv], { timeoutMs: 60000 })
    else await $.process.run(['cmd', '/c', 'start', '', '/b', 'node', sorter, ...argv], { timeoutMs: 20000 })   // 交接要等用户在 Codex 按发送，放后台慢慢等
  } catch {}
}

// 交接时告诉接手的 AI：这个对话在用户左侧栏是什么样，请它照样摆。谁交给谁都一样（10-28 用户定：标题一定要改；
// 不确定先列折叠清单给用户看；自己弄不了就问要不要找插件；再不行把清单交给用户自己挑）
const AUTO_SORT = ['Codex']   // 插件能直接替它改名、放分组的 AI
const SORT_WORD: Record<string, string> = { folder: '文件夹', none: '时间', date: '日期' }
async function sidebarNote($: EngineInterface, to: string) {
  const L = await language($)
  const sorter = `${$.plugin.root}/scripts/codex-sort.mjs`
  let info: { title?: string | null; section?: string | null; groupBy?: string | null } = {}
  try {
    const r = await $.process.run(['node', sorter, 'describe', '--claude-session', await $.session.id()], { timeoutMs: 30000 })
    info = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || '{}')
  } catch {}
  const folder = (await $.session.cwd()).split(/[\\/]/).filter(Boolean).pop() ?? ''
  const where = info.section ? `「${info.section}」分组里` : info.groupBy === 'folder' ? `「${folder}」文件夹里` : '左侧栏里'
  const how = `自建分组 + ${SORT_WORD[info.groupBy ?? 'none'] ?? info.groupBy}`
  const head = `【左侧栏】这个对话在用户那边叫「${info.title || '（没名字）'}」，在${where}；用户的左侧栏是按「${how}」排的。`
  if ((await $.store.get('lang')) === 'en') {
    const title = info.title || '(untitled)'
    const place = info.section ? 'section "' + info.section + '"' : 'folder "' + folder + '"'
    const head = '[Sidebar] This chat is named "' + title + '" in ' + place + '. Grouping: ' + (info.groupBy || 'time') + '. '
    if (AUTO_SORT.includes(to)) return head + 'The plugin will rename and file it for you.'
    return head + 'Rename this chat and place it in the same section or folder. If uncertain, show a collapsible section list and ask first. If your tools cannot do this, ask whether to find a plugin; otherwise let the user choose from that list. Use existing tools; do not edit settings files or databases.'
  }
  if (AUTO_SORT.includes(to)) return `${head}插件会替你改名、放好，这段你不用动手。`
  return `${head}请照样整理你这边的左侧栏：
1. 先把这个对话改名为「${info.title || '（没名字）'}」（标题一定要改，用户靠它认对话）。
2. 照上面的样子放：有同名分组 / 文件夹就放进去，没有就建一个。
3. 不确定怎么弄：先把打算摆成什么样列成折叠清单（只列分组名，点开才看对话）给用户看，用户说对了再弄。
4. 自己弄不了（没有改名、建分组的工具）：问用户要不要去找能做这件事的插件。
5. 也找不到：把这份折叠清单交给用户，让用户自己挑开哪个对话。
只用你自己现成的工具，别去改设置文件或数据库；这些都不影响干活，做不到就跳过。`
}

// 交棒给 Codex：搬家脚本把这段对话整理成交接记录，再打开 Codex 的新对话（同一个文件夹），开头让它先读记录接着做
async function handToCodex($: EngineInterface, requestId?: string, to: 'Codex' | 'Antigravity' = 'Codex') {
  const L = await language($)
  const script = `${await configDir($)}/skills/account-move/move.py`
  let ok = false, error = ''
  const known = ((await $.store.get('known')) as KnownStatus[] | undefined) ?? []
  const codex = known.find(ai => ai.name === to)
  const who = to === 'Codex' ? 'Codex' : 'Gemini'
  await update($, { plugin: 'clawdex', key: 'job' }, () => L('正在把这段对话交给 ' + who + '…', 'Handing this conversation to ' + who + '…'))
  await writeState($)
  try {
    if (!codex?.installed) throw new Error(L(who + ' 没装', who + ' is not installed'))
    if (codex.login === 'no') throw new Error(L(who + ' 没登录', who + ' is not signed in'))
    if (!(await $.fs.exists(script))) throw new Error(L('交不过去：缺搬家技能的脚本', 'Handoff failed: the account-move script is missing'))
    const id = await $.session.id()
    const r = await $.process.run(['python', '-I', script, 'digest', id], { env: { PYTHONIOENCODING: 'utf-8' }, timeoutMs: 120000 })
    const digest = r.stdout.trim().split(/\r?\n/).pop() ?? ''
    if (r.exitCode !== 0 || !/\.md$/.test(digest)) throw new Error(L('交接记录没整理出来', 'Could not prepare the handoff note'))
    const cwd = await $.session.cwd()
    const say = L('接着 Claude 那边的活做。交接记录：' + digest + '\n先看最前面的摘要，用两三句话告诉我做到哪了、下一步做什么，我说好再动手。', 'Continue the work from Claude. Handoff note: ' + digest + '\nRead the opening summary. Briefly explain progress and next steps, then wait for my approval.') + (to === 'Codex' ? '\n\n' + await sidebarNote($, 'Codex') : '')
    if (to === 'Antigravity') {   // agy -i = 带着第一句开对话、之后接着聊；路径和话走 stdin JSON，不拼进命令
      if (!codex.executable) throw new Error(L('找不到 Antigravity 的程序', 'Antigravity program not found'))
      const ps = "$q=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8).ReadToEnd()|ConvertFrom-Json; $a='-i \"'+($q.say -replace '\"',\"'\")+'\"'; Start-Process -FilePath $q.exe -ArgumentList $a -WorkingDirectory $q.cwd"
      const opened = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps], { stdin: JSON.stringify({ exe: codex.executable, cwd, say: say.replace(/\r?\n/g, ' ') }), timeoutMs: 20000 })
      if (opened.exitCode !== 0) throw new Error(L('打开 Gemini 失败', 'Could not open Gemini'))
      ok = true
      if ((await $.store.get('toldGemini')) !== true) {   // 只第一次说
        $.ui.toast(L('Gemini（Antigravity）在新窗口里开好了，它先说做到哪，你点头它再接着做', 'Gemini (Antigravity) opened in a new window. It explains progress first and waits for your approval.'))
        await $.store.set('toldGemini', true)
      }
      return
    }
    const url = `codex://threads/new?path=${encodeURIComponent(cwd)}&prompt=${encodeURIComponent(say)}`
    const since = Date.now()
    const opened = await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url], { timeoutMs: 20000 })
    if (opened.exitCode !== 0) throw new Error(L('打开 Codex 失败', 'Could not open Codex'))
    ok = true
    await codexSort($, ['handoff', '--since', String(since)], false)
    if ((await $.store.get('toldCodex')) !== true) {   // 只第一次说，之后不再弹（10-27 用户：提示不要每次都出现）
      $.ui.toast(L('Codex 开好了新对话，第一句已写好，你按发送；它先说做到哪，你点头它再接着做', 'A new Codex chat is open with the first message ready. Press Send; it explains progress and waits for your approval before continuing.'))
      await $.store.set('toldCodex', true)
    }
  } catch (err) {
    error = String(err).replace(/^Error: /, '').slice(0,300)
    $.ui.toast(L('交给 ' + who + ' 失败：', who + ' handoff failed: ') + error)
  } finally {
    await $.store.set('handoff', { to, ok, error, at: Date.now(), requestId })
    await update($, { plugin: 'clawdex', key: 'job' }, () => null)
    await writeState($)
  }
}

// 打开桌面浮窗（已经开着就叫到前面）
async function openFloat($: EngineInterface) {
  const L = await language($)
  const exe = `${floatDir($)}/node_modules/electron/dist/electron.exe`
  if (!(await $.fs.exists(exe))) {
    $.ui.toast(L('浮窗还没装好（缺 Electron）', 'The floating window is not installed yet (Electron is missing)'))
    return
  }
  await writeState($)
  await $.store.set('floatLaunchAt', await $.clock.now())
  const link = (await configDir($)) + '/clawdex/克代同堂.lnk'
  const appdata = await $.env.get('APPDATA')
  const startup = null   // 开机自启要用户自己同意（10-28 系统安全检查拦下自动写启动文件夹），以后做成设置里的开关；这里不自动加
  // stdin JSON 传路径，不把用户路径拼进 PowerShell 代码；只创建缺少的快捷方式。
  const script = '$q=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8).ReadToEnd()|ConvertFrom-Json; if(!(Test-Path -LiteralPath $q.link)){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($q.link))|Out-Null;$s=(New-Object -ComObject WScript.Shell).CreateShortcut($q.link);$s.TargetPath=$q.exe;$s.Arguments=([char]34)+$q.dir+([char]34);$s.WorkingDirectory=$q.dir;$s.Save()};if($q.startup -and !(Test-Path -LiteralPath $q.startup)){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($q.startup))|Out-Null;Copy-Item -LiteralPath $q.link -Destination $q.startup}'
  const made = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { stdin: JSON.stringify({link, exe, dir: floatDir($), startup}), timeoutMs: 20000 })
  if (made.exitCode !== 0) { $.ui.toast(L('小克快捷方式创建失败', 'Could not create the Clawdex shortcut')); return }
  await $.process.run(['explorer.exe', link.replace(/\//g, '\\')], { timeoutMs: 20000 })   // 资源管理器只认反斜杠路径，正斜杠会什么都不做（10-28 实测）
  await update($, { plugin: 'clawdex', key: 'float' }, () => true)
}

async function setUsage($: EngineInterface, limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) {
  const five = limits.find(l => l.kind === 'five_hour')
  const week = limits.find(l => l.kind === 'seven_day')
  const u: Usage = {
    five: five ? five.percentUsed : null,
    week: week ? week.percentUsed : null,
    fiveAt: five?.resetsAt ?? null,
    weekAt: week?.resetsAt ?? null,
  }
  await update($, { plugin: 'clawdex', key: 'usage' }, () => u)
  await writeState($)
}

// 换号后：旧号还有没接过来的对话吗（搬家技能的脚本，只读、不花额度）
async function checkMove($: EngineInterface) {
  const script = `${await configDir($)}/skills/account-move/move.py`
  if (!(await $.fs.exists(script))) return
  try {
    const r = await $.process.run(['python', '-I', script, 'list'], { env: { PYTHONIOENCODING: 'utf-8' }, timeoutMs: 60000 })
    const m = /没搬过的对话：(\d+) 个/.exec(r.stdout)
    const count = m ? Number(m[1]) : 0
    if (!count) return
    const sig = r.stdout.trim().slice(0, 4000)
    if ((await $.store.get('moveDismissed')) === sig) return
    const mv: Move = { count, sig }
    await update($, { plugin: 'clawdex', key: 'move' }, () => mv)
    await writeState($)
  } catch {
    // 没装 python 或脚本出错：不提示
  }
}

// 每次启动都查整张清单，不因已有队友就跳过；保留用户写的模型、负责和顺序。
async function findMates($: EngineInterface, s: Settings): Promise<Settings> {
  const known = await scanAI($)
  const migrated = !!(await $.store.get('teamMigration46'))
  const clean = reconcileTeam({ ...s, mates: s.mates.filter(x => !NOT_MATES.includes(x.name)).map(m => ({ ...m, name: m.name === '通义千问' ? 'Qwen' : m.name })) }, known, !migrated)
  await $.store.set('teamMigration46', true)
  const agy = known.find(ai => ai.name === 'Antigravity')
  if (agy?.installed && !agy.lastTrial && !(await $.store.get('agyAutoTrial46'))) {
    await $.store.set('agyAutoTrial46', true)
    startTry($, 'Antigravity')
  }
  return clean
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await markActive($)
    const started = await next(e)
    await identifyClaude($)
    const stored = ((await $.store.get('settings')) as Settings | undefined) ?? DEFAULT
    const s = await findMates($, stored)
    await saveSettings($, s)
    await $.command.register({ name: 'clawdex', description: '打开克代同堂浮窗（小克、跑道、队友）' })
    await $.tool.register({
      name: 'delegate',
      description:
        '把一件照着做就行的小活（有清楚做法的写代码、改 bug、写脚本、批量改文件、查资料）交给用户电脑上已安装、可接活的 AI 去做，做完返回它的报告。先把大方向想好再交：填好交接单的每一项。审美、拿主意、出点子、改规矩的活不要交。交回来后自己检查再告诉用户。',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '要做什么（一句话）' },
          approach: { type: 'string', description: '照什么思路做：主 AI 已经定好的大方向和做法' },
          files: { type: 'string', description: '要动哪些文件 / 文件夹' },
          done_when: { type: 'string', description: '做完什么样算好（怎么验收）' },
          dont_touch: { type: 'string', description: '哪些别碰' },
          to: { type: 'string', description: '交给谁（设置里的名字#序号，可不填；不填时按额度或顺序挑）' },
          write: { type: 'boolean', description: '能不能改文件；只查资料、诊断就填 false' },
        },
        required: ['goal', 'approach', 'done_when'],
      },
      isDeferred: false,
    })
    const u = await $.session.usage()
    await setUsage($, u.rateLimits)
    // 等新对话自己登记好，再看旧号有没有没接过来的对话
    void (async () => {
      await $.clock.sleep(3000)
      await checkFloat($)

    })()
    void (async () => {
      await $.clock.sleep(20000)
      await checkMove($)
    })()
    void (async () => {
      for (;;) {
        await $.clock.sleep(2000)
        await readInbox($)
        await pollLogins($)
        await checkFloat($)
      }
    })()
    void (async () => {   // 每分钟读一次队友的额度（10-28 用户：Codex 认出来了怎么额度写查不到）
      for (;;) {
        await readQuota($)
        await $.clock.sleep(60000)
      }
    })()
    return started
  })

  // 你在 Claude 里开始说话 = 现在用的是 Claude：记下时间给浮窗（只算主对话，不算助手）
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await identifyClaude($)
    await markActive($)
    await writeState($)
    void readQuota($)   // 顺便看一眼队友额度（每分钟那一圈要等新对话才开始）
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await setUsage($, e.rateLimits)
    return next(e)
  })

  // 每条消息附一句派活提醒（用户看不到，不改用户打的字）：只在开头说一次，对话一长就忘了（10-28 用户：怕它到时候又忘了；照 cc-codex 用钩子反复提醒的做法）
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    const s = await readSettings($)
    const known = ((await $.store.get('known')) || []) as KnownStatus[]
    const on_ = s.mates.filter(m => DELEGATE_TO.includes(m.name) && m.level !== '关' && m.installed !== false && m.login !== 'no' && !knownBlocked(m.name, known))
    if (!on_.length) return next(e)
    const L = await language($)
    const who = on_.map(m => mateId(m, s.mates)).join(L('、', ', '))
    const say = L('克代同堂提醒：这一轮有「照着定好的方案就能做」的活吗（写代码、改 bug、写脚本、批量改文件、查资料）？有就先用 mcp__clawdex__delegate 交出去、跟用户说一声，再做要拿主意的部分。能接活的：' + who,
      'Clawdex reminder: does this turn include work that follows an agreed approach (code, bug fixes, scripts, batch edits, research)? If so, hand it out with mcp__clawdex__delegate first, tell the user, then do the judgment parts. Available: ' + who)
    return next({ ...e, context: [...(e.context ?? []), say] })
  }).catch(($, e, next) => next(e))   // 提醒出错也照常发出用户的消息，绝不挡

  // 告诉主 AI：有谁能接活、各负责什么、派多少
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const s = (await readSettings($))
    const knownForPrompt = ((await $.store.get('known')) || []) as KnownStatus[]
    const on_ = s.mates.filter(m => DELEGATE_TO.includes(m.name) && m.level !== '关' && m.installed !== false && m.login !== 'no' && !knownBlocked(m.name, knownForPrompt))
    if (!on_.length) return r
    const L = await language($)
    const roster = on_.map(m => `- ${mateId(m, s.mates)}（模型 ${m.model}）负责：${m.job}；派活程度：${m.level}（${LEVEL_SAY[m.level]}）`).join('\n')
    const text = `# 克代同堂：主动委派（用户装这个插件，就是要你主动派活，不等用户开口）
每接到一件活，先拆开看：里面有没有「照着定好的方案就能做」的部分？有，就先把大方向想好，用工具 mcp__clawdex__delegate 交出去（交接单填全：要做什么、照什么思路做、动哪些文件、做完什么样算好、哪些别碰），自己去做要拿主意的部分。交出去时跟用户说一声；交回来先检查，再告诉用户。
- 该派：照方案写代码、改说得清的 bug、写脚本、批量改文件、装软件和环境问题、查资料
- 自己做：审美、排版、配色、出点子、写给人看的文案、拿主意、改规矩；三两句话就改完的小改动
- 拿不准时偏向派。别因为「自己顺手」就全部自己做
能接活的：
${roster}
好几个都能接时：${s.mode === 'order' ? '按上面的顺序，排前面的先' : '交给额度剩得最多的'}。`
    const en = '# Clawdex: delegate proactively (the user installed this plugin so you hand work out without being asked)\nBreak each task down. Parts that follow an agreed approach (code from a plan, well-described bugs, scripts, batch edits, installs, research) go out through mcp__clawdex__delegate; keep taste, layout, ideas, copy, judgment, rules and tiny edits. When unsure, lean toward delegating.\nFor small tasks with a clear agreed approach, use mcp__clawdex__delegate with a complete handoff (goal, approach, files, acceptance and do-not-touch). Keep design judgment, ideas and rules with the main AI. Tell the user when delegating; check the result before reporting.\nEligible clones:\n' + on_.map(m => '- ' + mateId(m, s.mates) + ' (model ' + normalizeModel(m.model) + '): ' + m.job + '; delegation: ' + ({关:'Off',低:'Low',中:'Mid',高:'High'})[m.level] + ' (' + ({关:'Do not delegate',低:'Only clearly mechanical or bulk tasks',中:'All tasks with a clear agreed approach',高:'Delegate all eligible work; keep judgment and design with the main AI'})[m.level] + ')').join('\n') + '\nSelection: ' + (s.mode === 'order' ? 'saved order' : 'most remaining quota')
    return { sections: [...r.sections, { id: 'clawdex:delegate', text: L(text, en), scope: 'session' as const }] }
  })

  // 委派：把交接单交给 Codex
  on('tool.call', { tool: 'mcp__clawdex__delegate' }, async ($, e) => {
    const input = e as unknown as { goal: string; approach: string; files?: string; done_when: string; dont_touch?: string; to?: string; write?: boolean }
    const s = (await readSettings($))
    const L = await language($)
    const on_ = s.mates.filter(m => m.level !== '关')
    const known = await scanAI($)
    const codexAvailable = on_.some(m => m.name === 'Codex') ? await codexScript($) : null
    const selfOrgs = (((await $.store.get('claudeOrgMap')) as Record<string, string[]> | undefined) ?? {})[((await $.store.get('claudeCurrentId')) as string | undefined) ?? ''] ?? []
    const eligible = on_.filter(m => {
      const ai = known.find(x => x.name === m.name), spec = KNOWN_AI.find(x => x.name === m.name)
      if (!DELEGATE_TO.includes(m.name)) return false   // 委派目前只做 Claude ↔ Codex（10-28 用户定）；别家先放着
      if (m.name === 'Claude' && ai?.cliOrg && selfOrgs.includes(ai.cliOrg)) return false   // 正在用的号不派给自己，挑人时就排除（不然先挑中它再放弃）
      return ai?.installed && ai.login !== 'no' && !knownBlocked(m.name, known) && spec && (m.name !== 'Codex' || !!codexAvailable) && (input.write === false ? !!spec.task.read : !!spec.task.write)
    })
    const quota = ((await $.store.get('quota')) || {}) as Record<string, Usage>
    const remaining = (m: Mate) => {
      const q = quota[m.name], values = [q?.five, q?.week].filter((v): v is number => typeof v === 'number')
      return values.length ? 100 - Math.max(...values) : -1
    }
    if (s.mode === 'quota') eligible.sort((a,b) => remaining(b) - remaining(a))
    const matches = input.to ? s.mates.filter(m => mateId(m, s.mates) === input.to || m.name === input.to) : []
    if (matches.length > 1) return { result: L('同名分身不止一个，请用名字#序号指定。', 'Multiple clones share that name. Use name#number to choose one.') }
    const mate = input.to ? matches[0] : eligible[0]
    if (!mate) return { result: L('没有能接活的 AI。这件活主 AI 自己做。', 'No AI is available for this task. The main AI should handle it.') }
    const ai = known.find(x => x.name === mate.name)
    if (mate.name === 'Claude') {   // 命令行登录的号就是桌面正在用的号 = 派给自己，不派（10-28 用户：当前的号变灰）
      const orgs = (((await $.store.get('claudeOrgMap')) as Record<string, string[]> | undefined) ?? {})[((await $.store.get('claudeCurrentId')) as string | undefined) ?? ''] ?? []
      if (ai?.cliOrg && orgs.includes(ai.cliOrg)) return { result: L('命令行版 Claude 登录的就是你正在用的号，不派给自己。这件活主 AI 自己做。', 'The Claude command-line tool is signed in to the account you are using now, so the task stays with the main AI.') }
    }
    if (mate.level === '关') return { result: L(`${mate.name} 已暂停派活。这件活主 AI 自己做。`, `${mate.name} is paused. The main AI should handle this task.`) }
    if (!ai?.installed || !ai.executable) return { result: L(`${mate.name} 没装，跳过。这件活主 AI 自己做。`, `${mate.name} is not installed. The main AI should handle this task.`) }
    if (ai.blocked) return { result: L(ai.notice!.zh, ai.notice!.en) }
    if (knownBlocked(mate.name, known)) return { result: L('该 AI 的交活权限参数尚未验证，暂不能派活', 'Delegation permissions for this AI are not verified yet') }
    if (ai.login === 'no') return { result: L(`${mate.name} 没登录，不能委派。这件活主 AI 自己做。`, `${mate.name} is not signed in. The main AI should handle this task.`) }
    const spec = KNOWN_AI.find(x => x.name === mate.name)
    if (!spec?.task || (input.write === false ? !spec.task.read : !spec.task.write)) return { result: L(`${mate.name} 的只读交活参数还没查证，跳过。这件活主 AI 自己做。`, `Read-only delegation is not supported for ${mate.name}. The main AI should handle this task.`) }
    let script: string | null = null
    if (mate.name === 'Codex') {
      script = await codexScript($)
      if (!script) return { result: L('没找到 Codex 插件（openai/codex-plugin-cc），交不出去。这件活自己做，并告诉用户装上 Codex 插件才能委派。', 'The official openai/codex-plugin-cc plugin is missing. Handle this task yourself and explain this dependency to the user.') }
    }
    const sheet = [
      L('只做下面这一件事，别顺手改别处；配色、版式、名字没写「已定」就别自己定。做完用中文报告：改了哪些文件、哪里没做完、哪里没验证。', 'Do only this task. Do not change unrelated files or decide colors, layout or names unless already agreed. Report in English: changed files, unfinished work, and unverified behavior.'),
      '',
      L(`【要做什么】${input.goal}`, `[Goal] ${input.goal}`),
      L(`【照什么思路做】${input.approach}`, `[Agreed approach] ${input.approach}`),
      input.files ? L(`【动哪些文件】${input.files}`, `[Files] ${input.files}`) : '',
      L(`【做完什么样算好】${input.done_when}`, `[Acceptance] ${input.done_when}`),
      input.dont_touch ? L(`【别碰】${input.dont_touch}`, `[Do not touch] ${input.dont_touch}`) : '',
      mate.name === 'Antigravity' ? L('不要跑终端命令，只用读文件、看文件夹、改文件的工具（无人值守时终端命令会被拒绝）。', 'Do not run terminal commands; use only file read, folder listing and file edit tools (terminal commands are denied when unattended).') : '',   // 10-28 实测：它爱用终端命令列文件夹，会被拒，交代一句就改用读文件的工具
    ].filter(Boolean).join('\n')
    const argv: string[] = script ? ['node', script, 'task'] : [...spec.task.args, ...(input.write === false ? spec.task.read ?? [] : spec.task.write ?? [])]
    if (script && input.write !== false) argv.push('--write')
    if (normalizeModel(mate.model) !== 'default') argv.push(script ? '--model' : spec.task.model, mate.model)
    if (!script && spec.task.prompt) argv.push(spec.task.prompt)
    argv.push(sheet)
    await update($, { plugin: 'clawdex', key: 'job' }, () => L(`${mate.name} 在做：${input.goal.slice(0, 40)}`, `${mate.name} is working on: ${input.goal.slice(0, 40)}`))
    await writeState($)
    try {
      // 11-04：Codex 改走后台。原来前台等它做完，$.process.run 最多等 10 分钟，大活必被掐断（用户：「为什么会十分钟是强制停掉的？」）。
      // 官方插件 task --background 立刻返回任务编号、Codex 在后台一直做，没有时间上限；主 AI 用 Bash 后台等结果。
      if (script) {
        const cwd = await $.session.cwd()
        const bg = await $.process.run(['node', script, 'task', '--background', '--json', ...argv.slice(3)], { cwd, timeoutMs: 120000 })
        const id = /"jobId"\s*:\s*"([^"]+)"/.exec(bg.stdout || '')?.[1]
        if (bg.exitCode !== 0 || !id) return { result: L('Codex 没能在后台开工（退出码 ' + bg.exitCode + '）。这件活自己做。', 'Codex could not start in the background (exit code ' + bg.exitCode + '). Handle this task yourself.') + '\n' + (bg.stdout || '').slice(-3000) + '\n' + (bg.stderr || '').slice(-2000) }
        await codexSort($, ['task', '--name', input.goal], false)
        $.ui.toast(L('Codex 在后台开工了：' + input.goal.slice(0, 30), 'Codex started in the background: ' + input.goal.slice(0, 30)))
        const q = (x: string) => '"' + x + '"'
        // 11-04 实测：官方插件按文件夹记任务，换个文件夹查会查不到，所以两条命令都带上 --cwd
        return { result: L(
          `Codex 已在后台开工，任务编号 ${id}，没有时间上限。跟用户说一声；然后用 Bash 或 PowerShell 后台（run_in_background）等它做完：
node ${q(script)} status ${id} --cwd ${q(cwd)} --wait --timeout-ms 7200000 --poll-interval-ms 30000 --json
做完后取报告：node ${q(script)} result ${id} --cwd ${q(cwd)}
报告拿回来先检查，再告诉用户。`,
          `Codex started in the background as ${id}, with no time limit. Tell the user, then wait with Bash or PowerShell run_in_background:
node ${q(script)} status ${id} --cwd ${q(cwd)} --wait --timeout-ms 7200000 --poll-interval-ms 30000 --json
Then fetch the report: node ${q(script)} result ${id} --cwd ${q(cwd)}
Review it before telling the user.`) }
      }
      const r = await runCLI($, ai.executable, argv, 590000)
      const out = (r.stdout || '').slice(-20000)
      if (r.exitCode !== 0) {
        $.ui.toast(L(mate.name + ' 做失败了（退出码 ' + r.exitCode + '）', mate.name + ' failed (exit code ' + r.exitCode + ')'))
        return { result: L(mate.name + ' 出错了（退出码 ' + r.exitCode + '）。', mate.name + ' failed (exit code ' + r.exitCode + ').') + '\n' + out + '\n' + (r.stderr || '').slice(-4000) }
      }
      if (script) await codexSort($, ['task', '--name', input.goal], true)
      $.ui.toast(L(mate.name + ' 做完了：' + input.goal.slice(0,30), mate.name + ' finished: ' + input.goal.slice(0,30)))
      return { result: L(mate.name + ' 交回来的报告，检查后再告诉用户：', 'Report from ' + mate.name + '. Review before telling the user:') + '\n' + out }
    } catch (err) {
      $.ui.toast(L("委派失败", "Delegation failed"))
      return { result: L(`交给 ${mate.name} 没成功：${String(err).slice(0, 500)}。这件活自己做。`, `Delegation to ${mate.name} failed: ${String(err).slice(0, 500)}. Handle this task yourself.`) }
    } finally {
      await update($, { plugin: 'clawdex', key: 'job' }, () => null)
      await writeState($)
    }
  }).catch(async ($) => ({ result: (await language($))('委派这一步出错了，这件活自己做。', 'Delegation failed. Handle this task yourself.') }))

  on('command.run', { command: 'clawdex' }, async $ => {
    await $.store.set('floatClosed', false)
    await openFloat($)
    return { text: (await language($))('已打开克代同堂浮窗。', 'Opened the Clawdex floating window.') }
  })

  // 设置页：委派给谁（模型、负责什么、派活程度）、委派方式、额度、帮助
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const L = await language($)
    const t: any = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = t
    const Select = t.Select
    const Input = t.Input
    const s = (await readSettings($))
    const u = await read($, { plugin: 'clawdex', key: 'usage' })
    const help = await read($, { plugin: 'clawdex', key: 'help' })
    const knownHelp = ((await $.store.get('known')) || []) as KnownStatus[]
    const en = (await $.store.get('lang')) === 'en'
    const setMate = (i: number, patch: Partial<Mate>) =>
      void saveSettings($, { ...s, mates: s.mates.map((m, k) => (k === i ? { ...m, ...patch } : m)) })
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text size="heading" weight="semibold">{L("委派", "Delegate")}</Text>
        {s.mates.length === 0 && <Text dimColor>{L("电脑上还没认出能接活的 AI，请装好命令行工具并登录；Codex 委派还需要官方插件 openai/codex-plugin-cc。", "No available AI detected. Install a CLI and sign in. Codex delegation also needs openai/codex-plugin-cc.")}</Text>}
        {s.mates.map((m, i) => (
          <Box key={`mate-${i}`} flexDirection="column" gap={0} borderStyle="round" paddingX={1}>
            <Text weight="semibold">{knownHelp.find(ai => ai.name === m.name)?.display ? L(knownHelp.find(ai => ai.name === m.name)!.display.zh, knownHelp.find(ai => ai.name === m.name)!.display.en) : m.name}</Text>
            {Select ? (
              <Select
                key={`model-${i}`}
                label={L("模型", "Model")}
                value={m.model}
                options={[...new Set([m.model, ...CODEX_MODELS])].map(v => ({ value: v, label: normalizeModel(v) === 'default' ? L('默认', 'Default') : v }))}
                onSelect={(v: string) => setMate(i, { model: v })}
              />
            ) : (
              <Text dimColor>{L("模型：", "Model: ")}{normalizeModel(m.model) === "default" ? L("默认", "Default") : m.model}</Text>
            )}
            {Input ? (
              <Input key={`job-${i}`} label={L("负责", "Role")} value={m.job} submitLabel={L("存", "Save")} onSubmit={(v: string) => setMate(i, { job: v.trim() || m.job })} />
            ) : (
              <Text dimColor>{L("负责：", "Role: ")}{m.job}</Text>
            )}
            {Select ? (
              <Select
                key={`level-${i}`}
                label={L("派活", "Delegate")}
                value={m.level}
                options={LEVELS.map(v => ({ value: v, label: L(`${v} · ${LEVEL_SAY[v]}`, ({关:"Off",低:"Low",中:"Mid",高:"High"})[v]) }))}
                onSelect={(v: string) => setMate(i, { level: v as Level })}
              />
            ) : (
              <Text dimColor>{L("派活：", "Delegation: ")}{L(m.level, ({关:"Off",低:"Low",中:"Mid",高:"High"})[m.level])}</Text>
            )}
            <Text dimColor>{L("额度：查不到", "Quota: unknown")}</Text>
          </Box>
        ))}
        {Select && s.mates.length > 0 && (
          <Select
            key="mode"
            label={L("好几个都能接时", "When several can take it")}
            value={s.mode}
            options={[
              { value: 'quota', label: L('按额度 · 交给剩得最多的', 'By quota · most remaining first') },
              { value: 'order', label: L('自定顺序 · 排前面的先接', 'Custom order · first eligible') },
            ]}
            onSelect={(v: string) => void saveSettings($, { ...s, mode: v as Settings['mode'] })}
          />
        )}
        <Text size="heading" weight="semibold">{L("额度（这个号）", "Quota (this account)")}</Text>
        {u ? (
          <Text>
            {L("5 小时：", "5-hour: ")}{u.five != null ? `${Math.round(u.five)}%` : '—'}{u.fiveAt ? L(` · ${fmtTime(u.fiveAt, false)} 回满`, ` · resets ${fmtTime(u.fiveAt, false)}`) : ''}{'   '}{L('这周：', 'Week: ')}{u.week != null ? `${Math.round(u.week)}%` : '—'}{u.weekAt ? L(` · ${fmtTime(u.weekAt, true)} 回满`, ` · resets ${fmtTime(u.weekAt, true)}`) : ''}
          </Text>
        ) : (
          <Text dimColor>{L("第一次回答后才有数", "Available after the first response")}</Text>
        )}
        <Button key="help" label={help ? L('收起帮助', 'Hide help') : L('帮助', 'Help')} onPress={() => void update($, { plugin: 'clawdex', key: 'help' }, h => !h)} />
        {help && <Markdown text={L(HELP, "Delegate: the main AI writes an agreed handoff and reviews the result. By quota chooses the most remaining quota; Custom order chooses the first eligible teammate. Codex requires openai/codex-plugin-cc. Handoff currently supports Codex and Claude accounts. When quota runs out, the switch arc appears for you to choose. Sign out in Claude and sign in to Claude 2 → Clawd shows “Switched to Claude 2 · Bring over chats from the old account?” → click Bring over → a new Claude chat opens with “搬家” already written → press Send → unarchived chats from the last 7 days are brought over. Codex handoff waits 3 seconds; click Undo to cancel before it is sent. Original chats stay. Claude accounts are detected after you switch; for other AIs: Right-click → Teammates → Switch, add it. Use the desktop settings Help for details.") + '\n\n' + knownHelp.map(ai => capabilitiesText(ai, en)).join('\n\n')} />}
      </Box>
    )
  })
}
