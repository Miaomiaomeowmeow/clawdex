// 派活程度：关 = 不派；低 / 中 / 高 = 交出去的多少
export type Level = '关' | '低' | '中' | '高'

// 一个能接活的 AI（现在只认 Codex）
export type Mate = { addedBy?: 'auto' | 'manual'; id?: string; icon?: string; models?: { t: string; mine: boolean }[]; jobs?: { t: string; src: string }[]; name: string; model: string; job: string; level: Level; installed?: boolean; login?: 'yes' | 'no' | 'unknown' }

// 设置：委派方式 + 每个 AI 的模型、负责什么、派活程度
export type Settings = { mode: 'quota' | 'order'; mates: Mate[]; removed?: string[] }

// 这个号的额度：用了百分之几、几点回满
export type Usage = { five: number | null; week: number | null; fiveAt: string | null; weekAt: string | null }

// 换号后旧号还没接过来的对话
export type Move = { count: number; sig: string }

declare module 'claude-code' {
  interface PluginState {
    clawdex: { usage: Usage | null; settings: Settings; move: Move | null; job: string | null; help: boolean; float: boolean }
  }
}
