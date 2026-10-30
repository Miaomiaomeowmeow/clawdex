# AI-SETUP：帮用户装克代同堂（Clawdex）

> 给 AI 看的安装向导。用户说「照 AI-SETUP.md 帮我装克代同堂」时，照下面做。用中文，讲简单；用户不一定懂技术。
> For AI assistants: the user asked you to set up Clawdex. Follow the steps below; talk to the user in their language.

## 规矩

- **先自己检查，再问。** 能自己查到的（装没装、登没登录）别问用户
- **一次只问一个问题**，每题给三种回答：要 / 不要 / 要但还没装（没装就告诉他去哪装，或者问他要不要你来装）
- 跑命令前说一句要做什么；装软件之前先问一句，用户点头再装
- Windows 的 PowerShell 可能不让跑 `.ps1` 脚本：命令一律写 `npm.cmd`、`claude.cmd`、`codex.cmd`
- 下面的「仓库」= 克代同堂这个文件夹（有 `plugin/`、`float/`、`skills/` 的那个）；「配置目录」= 环境变量 `CLAUDE_CONFIG_DIR`，没设就是 `%USERPROFILE%\.claude`

## 第 1 步：自己检查电脑（不用问用户）

依次跑，记下结果：

```
node --version
npm.cmd --version
python --version
claude.cmd --version
codex.cmd --version
codex.cmd login status
claude.cmd auth status
```

再看：配置目录在哪；`%LOCALAPPDATA%\agy\bin\agy.exe`（Antigravity）在不在。

把结果用一张小表告诉用户（有 / 没有 / 没登录）。

## 第 2 步：装必须的三样（缺什么先问再装）

1. **插件**：
   ```
   claude.cmd plugin marketplace add "<仓库>\plugin"
   claude.cmd plugin install clawdex@clawdex --scope user
   claude.cmd plugin list
   ```
   确认列表里 `clawdex@clawdex` 是 enabled
2. **浮窗**：没有 Node.js 就先问用户要不要装（https://nodejs.org/ ，选 LTS）。然后：
   ```
   cd "<仓库>\float"
   npm.cmd install
   ```
3. **搬家技能**：把 `<仓库>\skills\account-move` 整个文件夹复制到 `<配置目录>\skills\account-move`。没有 Python 3 就问用户要不要装（https://www.python.org/downloads/ ，装的时候勾「Add to PATH」）

## 第 3 步：一次问一题

**问 1：要不要让 Claude 把照方案就能做的小活交给 Codex？**（克代同堂最主要的功能）
- 要 → 需要 Codex 命令行和 OpenAI 的 Codex 插件：
  ```
  npm.cmd install -g @openai/codex
  codex.cmd login
  ```
  然后在 Claude Code 里装 OpenAI 的 Codex 插件（https://github.com/openai/codex-plugin-cc ，照它 README 的安装步骤；Claude Code 里打 `/codex:setup` 能检查好没好）
- 不要 → 跳过，以后在设置页里也能加
- 要但没有 ChatGPT 会员 → 告诉用户 Codex 要 ChatGPT 账号登录，有了再来

**问 2：要不要让 Codex 也能把活交给 Claude？**
- 要 →
  ```
  codex.cmd plugin marketplace add sendbird/codex-marketplace
  codex.cmd plugin add cc@sendbird
  ```
  再请用户重启 Codex，在 Codex 里打 `$cc:setup`。提醒：接活的是电脑上**命令行版 Claude 登录的那个号**（`claude.cmd auth status` 能看），不是桌面应用登录的号
- 不要 → 跳过

**问 3：你用 Gemini 会员吗？**
- 用 → 需要 Google 的 Antigravity（https://antigravity.google/ ），用你 Gemini 会员的 Google 账号登录；额度还是你 Gemini 会员那份。装好后克代同堂会自己认出来，界面上叫「Gemini」
- 不用 → 跳过

**问 4：你有不止一个 Claude 号吗？**
- 有 → 不用设置。在 Claude 桌面应用里换号以后，小克会自己认出新号，问你要不要把旧号的对话接过来。终端版想换号可以装 claude-swap（https://github.com/realiti4/claude-swap ，可选）
- 没有 → 跳过

## 第 4 步：打开看看

告诉用户：**新开一个 Claude 对话**（插件在新对话里才加载），小克会出现在桌面上，第一次会教一遍怎么用。找不到小克：在 Claude 里打 `/clawdex`，或双击桌面上的「克代同堂」。

最后说一句：每样功能怎么用，都在「右键小克 → 管理队友 → 帮助」里；以后想加 Codex、Gemini，也是在那里的设置页加。
