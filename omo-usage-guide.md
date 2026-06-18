# Oh-My-OpenAgent (OmO) 使用指南

## 简介

OmO 是一个 AI 编码 Agent 的超级增强插件，提供两个版本：

- **Ultimate 版**（OpenCode 平台） — 完整功能：11 个自律 Agent、54+ 生命周期钩子、Team Mode、所有 MCP、全部斜杠命令
- **Light 版**（Codex CLI 平台） — 可移植组件：rules、comment-checker、git-bash、LSP、ultrawork、ulw-loop、telemetry

## 一、安装

**强烈建议：让 AI Agent 帮你安装。** 把下面这句话发给 Claude Code / Cursor / AmpCode：

```
Install and configure oh-my-openagent by following the instructions here:
https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/refs/heads/dev/docs/guide/installation.md
```

### 偏要自己装：

```bash
# Ultimate 版（OpenCode）
bunx oh-my-openagent install

# Light 版（Codex CLI）
npx lazycodex-ai install

# 两个都装
bunx oh-my-openagent install --platform=both
```

**不要用 `npm install -g` 或 `bun add -g`** — 全局安装不受官方支持。

### 非交互式安装（给 Agent 用）

```bash
# Claude 订阅
bunx oh-my-openagent install --no-tui --platform=opencode --claude=yes

# Claude Max + ChatGPT + Gemini
bunx oh-my-openagent install --no-tui --platform=opencode --claude=max20 --openai=yes --gemini=yes

# Codex + 自主权限（推荐）
npx lazycodex-ai install --no-tui --codex-autonomous
```

### 订阅标志说明

| 标志 | 含义 |
|------|------|
| `--claude=yes\|no\|max20` | Claude Pro/Max 订阅 |
| `--openai=yes\|no` | ChatGPT Plus 订阅 |
| `--gemini=yes\|no` | Gemini 集成 |
| `--copilot=yes\|no` | GitHub Copilot 订阅 |
| `--opencode-zen=yes\|no` | OpenCode Zen 模型 |
| `--zai-coding-plan=yes\|no` | Z.ai Coding Plan |
| `--opencode-go=yes\|no` | OpenCode Go（$10/月） |
| `--kimi-for-coding=yes\|no` | Kimi for Coding |
| `--vercel-ai-gateway=yes\|no` | Vercel AI Gateway |

## 二、安装后验证

```bash
opencode --version              # 应 >= 1.4.0
bunx oh-my-openagent doctor     # 运行 6 类诊断检查
```

## 三、核心功能

### 3.1 自律军团（Discipline Agents）

| Agent | 推荐模型 | 职责 |
|-------|---------|------|
| **Sisyphus** | claude-opus-4.7 / kimi-k2.6 / glm-5.1 | 主调度，分配任务，推动完成 |
| **Hephaestus** | gpt-5.5 | 自主深度执行，给目标不给步骤 |
| **Prometheus** | claude-opus-4.7 / kimi-k2.6 | 战略规划，动手前先访谈 |
| **Oracle** | gpt-5.5 | 架构决策、复杂调试 |
| **Librarian** | — | 文档检索、代码搜索 |
| **Explore** | grok-code-fast-1 | 代码库快速搜索 |
| **Metis** | — | 需求分析和澄清 |
| **Momus** | — | 计划质量审查 |

### 3.2 `ultrawork` / `ulw` — 一键全自动

输入 `ultrawork` 或 `ulw`，所有 Agent 全部出动，任务不完成不罢休。

### 3.3 Team Mode（需要手动开启）

`.opencode/oh-my-openagent.jsonc`：

```jsonc
{
  "team_mode": {
    "enabled": true,
    "max_parallel_members": 4,
    "tmux_visualization": true
  }
}
```

解锁后可用：
- **`hyperplan`** — 5 个敌对 Agent 从正交角度审查计划
- **`security-research`** — 3 漏洞猎手 + 2 PoC 工程师并行审计

### 3.4 `/init-deep` — 自动生成项目知识库

执行一次，自动生成树状 `AGENTS.md`，Agent 自动加载对应上下文。

### 3.5 哈希行编辑（Hashedit）

每行代码带内容哈希，编辑时验证内容一致性。Grok Code Fast 1 上修改成功率从 6.7% 升至 68.3%。

### 3.6 技能系统

内置：`playwright`（浏览器自动化）、`git-master`（原子提交）、`frontend`（UI 设计）

自定义技能：放入 `.opencode/skills/*/SKILL.md`

### 3.7 内置 MCP

Exa（搜索）、Context7（文档）、Grep.app（代码搜索）、LSP（重构/重命名/诊断）

技能专属 MCP 按需启动，用完销毁。

## 四、Agent 调度机制

Sisyphus 用 **类别（Category）** 调度，系统自动选模型：

| 类别 | 用途 |
|------|------|
| `visual-engineering` | 前端、UI/UX、设计 |
| `deep` | 深度自主调研执行 |
| `quick` | 单文件修改、修错字 |
| `ultrabrain` | 复杂硬核逻辑、架构决策 |

## 五、常用命令

| 命令 | 作用 |
|------|------|
| `ultrawork` / `ulw` | 一键全自动开发 |
| `/init-deep` | 生成项目 AGENTS.md |
| `/start-work` | 召唤 Prometheus 规划 |
| `/hyperplan` | 5 Agent 敌对审查（需 Team Mode） |
| `/security-research` | 安全审计（需 Team Mode） |
| `bunx oh-my-openagent doctor` | 运行诊断 |
| `opencode auth login` | 配置模型认证 |

## 六、卸载

```bash
# 从 opencode.json 移除插件
jq '.plugin = [.plugin[] | select(. != "oh-my-openagent" and . != "oh-my-opencode")]' \
    ~/.config/opencode/opencode.json > /tmp/oc.json && \
    mv /tmp/oc.json ~/.config/opencode/opencode.json

# 清除配置文件
rm -f ~/.config/opencode/oh-my-openagent.jsonc ~/.config/opencode/oh-my-opencode.jsonc

# 清除 Codex Light 版
rm -rf ~/.codex/plugins/cache/sisyphuslabs
# 编辑 ~/.codex/config.toml 删除 [marketplaces.sisyphuslabs] 等区块
```

## 七、最低订阅推荐

即使只订阅以下服务，OmO 也能良好运行：

- ChatGPT 订阅（$20/月）
- Kimi Code 订阅（$19/月）
- GLM Coding 套餐（Z.ai，$10/月）
- 按 token 计费用 Kimi + Gemini 模型花费极低

> **⚠️ 如果没有 Claude 订阅，Sisyphus Agent 可能无法达到最佳效果。** Sisyphus 在 Claude Opus 4.7 上表现最佳。配合 Kimi K2.6 + GPT-5.5 即可超越原生 Claude Code。
