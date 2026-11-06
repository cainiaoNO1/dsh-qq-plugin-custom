# 改造清单

基线：`dsh-qq-plugin@1.0.3`（上游 npm 包，纯净副本在 `upstream/1.0.3/`）

当前自用版本 = 上游 1.0.3 + 下面 12 项改造。

---

## 一、文件级改动总览

| 文件 | 类型 | 涉及的改造 |
|---|---|---|
| `lib/runtime.js` | 修改 | 1,2,3,4,5,6,7,8,9,10,11,12 |
| `lib/router.js` | 修改 | 4,8,11,12 |
| `lib/stream-frame.js` | 修改 | 1 |
| `lib/settings.js` | 修改 | 3,9,10 |
| `lib/state.js` | 修改 | 8,9 |
| `lib/session-index.js` | 修改 | 7 |
| `lib/plain-text.js` | **新增** | 10 |
| `client.js` | 修改 | 3,9,10 |

---

## 二、逐项改造

### 改造 1：过程旁白过滤

**问题**：DSH 的 `AssistantStreamAttempt` 按**每个 model attempt** 创建，每个 attempt 结束都发一个 `end` 帧。一个拆成 7 次提交的任务 = 7 个 `end` 帧，旁白（"第 1 次提交完成，继续…"）被切成 7 条 QQ 消息。

**修法**：
- `stream-frame.js`：`tool-call-delta` 只要有 `id` 就识别为工具调用（上游要求 `name`，而宿主**不给** name，导致 `toolCall` 从未被设置）；`block-start` 的 `blockType === 'tool-call'` 也识别
- `runtime.js`：出现过工具调用的 attempt 是旁白，压住不发；只有"没有工具调用"的 attempt 才是真收尾

**关键**：`runtime.js` 里原来有一行提前返回 `if ((text===''||text===undefined) && completed!==true) return`，它把工具调用帧也挡掉了——必须放行带 `toolCall` 的帧，否则整条判据空转。

---

### 改造 2：未绑定会话结果转发（`notifyAllSessions`）

**问题**：默认只有"绑定的那个会话"的结果会送到 QQ。桌面端跑的会话结果只留在电脑上。

**修法**：新增设置 `notifyAllSessions`（默认关）。打开后任何会话收尾都把结果推给 QQ。

**跳过两种情况**：该会话本身绑定着 QQ（不能送两遍）；没有收尾正文（模型纯工具收尾）。

---

### 改造 3：完成推送带提问

**问题**：推送只有结果，用户想不起问的是什么。

**修法**：新增设置 `finishPromptChars`（默认 60）。推送格式变成：

```
提问（截到 N 字，超出加省略号）
--------------------（20 个 -）
结果
```

---

### 改造 4：`/run` 列出正在跑的任务

新增指令。每条三行：

```
1. 工作区名
已运行 12 分 30 秒
提问内容
```

跑得久的在前。`/run <序号>` 切过去，越界（含 `0`）落到最后一个。

**数据来源三级回退**：`#runningSince`（插件提交时记的）→ 宿主行 `lastPromptAt` → 磁盘索引 `lastPromptAt`。都没有显示"开始时间未知"，**绝不拿 `updatedAt` 冒充**。

---

### 改造 5：切换会话后补发最后一次提问

**问题**：切过去后手机上是空白，用户不知道这个会话在干什么。

**修法**：`/switch`、`/list` 回编号、`/run N`、`/new` 成功后，额外发一条：

```
这个会话最后一次提问（已运行 5 分钟 / 提问于 2 小时前）：
xxx
```

**三级取法**：`#runningSince` 原话 → 磁盘 `turnOutline.turns.at(-1).prompt` → 新会话显示"（暂无提问）"。

---

### 改造 6：`111` 快速对话通道

**修法**：新增设置 `quickWorkspacePath`。发 `111 问题` 把内容发到该目录下最新会话，**不动当前绑定**。目录不存在时 `111` 当普通文本。

`/111 x` 是转义，字面发送 `111 x` 给当前会话。

---

### 改造 7：`/run` 与切换的提问兜底

**问题**：`detailsMap` 由 `gateway().listSessions()` 建立，它遍历**会话目录**。某些会话（刚 fork、索引被驱逐）在宿主 `list()` 里但不在目录清单，导致提问显示"内容未知"。

**修法**：`session-index.js` 的 `readIndex` 增加 `lastPrompt` / `lastPromptAt` 字段；新增 `readStoredSessionDetails()` 直接按 sessionId 读投影缓存，不依赖目录遍历。

---

### 改造 8：`rrr` 回话给最近完成的会话

**修法**：新增 `state.lastFinished`（持久化）。发 `rrr 你的话` 把内容发到该会话，**不动当前绑定**。`/rrr x` 是转义。

---

### 改造 9：会话正忙时的四选一

**问题**：原实现"先 steer 被拒再 queue"，默认用户想插话。但 steer 会打断正在跑的多步任务。

**修法**：目标会话 `running` 时先问：

```
1  插入：打断当前任务
2  排队：等这一轮跑完
3  分叉：同工作区复制会话，并把 QQ 切过去
0  撤回
```

`state.pendingBusy` 持久化。非数字回答作废提示，消息走正常路径。

**四种情况不问**：`parkedAuto`（附件停靠到期自动投递）、纯图片无文字、`created`（新建会话）、有 `notice`（换绑已说明）。

---

### 改造 10：Markdown 转纯文本

**问题**：QQ 消息**不渲染 Markdown**，agent 输出在手机上是井号竖线星号。

**修法**：新增 `lib/plain-text.js`（`markdownToPlain` / `hasMarkdown`）；新增设置 `markdownMode`（`plain` 默认 / `raw` / `file`）。

**保护**：代码块内容原样保留；行内代码优先保护（`` `a**b**c` `` 里的星号不动）；纯文本回复不转换。

---

### 改造 11：`/model` 列表支持直接回编号

**问题**：上游 `renderModelList` 印着「回复名字或编号即可切换，例如「2」」，但**没设 browse 状态**，回 `30` 会被当普通聊天发给 AI。

**修法**：`/model` 返回时带 `browse: { level: 'models' }`；`#browseReply` 新增 `models` 分支；抽出 `#doSelectModel()` 复用。

---

### 改造 12：触发词识别放宽

**问题**：旧规则 `/^111(?:\s|$)/` 要求 111 后跟空格。用户发 `111190.254，…`（无空格）或 `…不再用了 111`（结尾）都不触发。

**修法**：`extractTriggerWord()` 认**开头紧贴**、**独立成词**、**结尾**三种位置；挡掉纯数字（`1111`、`111.5`）。

`rrr` 额外允许**句中独立成词**（`/i rrr 要做的事`）；`111` 不允许（`第 111 行` 里剥掉会吃掉内容）。

`//` 转义后**继续检查触发词**（`//i rrr x` → 转给上一个会话）；剥掉残留的 `/i` 前缀。

---

### 改造 13：所有消息投递全路径「已发到」确认提示

**问题**：手机端在会话切换、快速通道或追问后，缺乏明确的反馈感知消息到底发往了哪个会话。

**修法**：在 `#confirmDelivered` 中统一回显 `已发到「<会话名>」。`，覆盖普通消息、`111`、`rrr`、`//x` 转义及忙时分支（新建会话或有 notice 换绑提示时除外，避免刷屏）。

---

### 改造 14：忙时抉择免打扰优化

**问题**：用户单独发送图片（附件）或窗口到期自动投递时，宿主若正在跑任务，会弹出“这句话要怎么处理？”，但此时用户并没有发文字。

**修法**：`#deliverPrompt` 增加 `parkedAuto` 标识并在无文字消息时直接走排队，跳过忙时询问；只有用户主动发送带文字的消息时才触发 1/2/3/0 抉择。

---

### 改造 15：路由绑定缓存失效（`invalidateBindings`）

**问题**：`/run <序号>` 或 fork 分叉切换绑定后，`/list` 依然显示原会话为当前会话。

**修法**：在 `router.js` 中增加 `invalidateBindings()` 接口，在运行时写盘后主动使缓存失效，确保下一次 `/list` 与 `/current` 即时读到最新绑定。

---

### 改造 16：设置菜单修改即自动保存（移除保存按钮）

**问题**：用户每次改动设置必须滚动到底部点击「保存设置」按钮，容易遗漏导致未生效。

**修法**：
- 控件分类自动保存：开关（Toggle）、下拉（Select）、文件夹选择及「恢复默认」在操作后**立即保存**；输入框和说明文本支持 **400ms 防抖自动提交 + 失焦（onBlur）即刻保存**。
- 移除底部的「保存设置」按钮和未保存警告；保存成功显示绿色状态提示，保存失败给出错误通知。

---

### 改造 17：通道状态持久化与 QQ 远程指令（`/start` 与 `/stop`）开关控制

**问题**：
1. 原通道开关关闭后，重启 dsh web 会由于配置覆盖再次强制自动启动；
2. 关闭通道时如果彻底断开 WebSocket 连接，用户在手机 QQ 端就再也无法发送指令唤醒。

**修法**：
- `state.autoStart` 作为通道业务处理的核心状态持久化记录。重启时优先遵循用户设定的 `state.autoStart`（为 false 则保持关闭，绝不强启）。
- 保持底层 QQBot 长连接待命以支持接收控制指令。在入站最顶层拦截：
  - 收到 `/start`（或中文「开启通道」）：将通道状态设置为开启，持久化落盘并回复已开启；
  - 收到 `/stop`（或中文「关闭通道」）：将通道状态设置为关闭，持久化落盘并回复已关闭；
  - 通道处于关闭状态时：拦截所有业务消息（包括图片附件），不调用 agent，友好提示「当前处于关闭状态，发送 /start 可重新开启」。
- 设置页通道状态 Toggle 绑定至该持久化状态，与手机 QQ 指令双向实时联动。

---

### 改造 18：通道关闭期间消息丢弃与防积压补发

**问题**：通道关闭后，桌面端会话结束（notifyAllSessions）或主动工具调用（notify_qq）在发送失败时仍会被推入待发队列（`pendingNotifications`）；当通道重新开启并收到用户第一条消息时，会将关闭期间积压的消息全量补发。

**修法**：
- 通道关闭状态下（`!isChannelEnabled()`），`#deliverOrQueue`、`#forwardUnbound`、`#flushReply`、`notifyFromTool` 直接丢弃消息，不入待发队列、不发送。
- 通道切换为关闭时（`setEnabled(false)` 或 `/stop`），自动清空历史待发队列（`delete next.pendingNotifications`）与运行中暂存回复。
- `#flushPending` 仅在通道开启且非开关控制指令时执行，确保通道关闭期间的消息任何时候都不会补发到 QQ。

---

### 改造 19：兼容纯 UUID 命名的会话与 `rrr` 存活检测修复

**问题**：现代 DSH 的会话目录很多直接以 36 位 UUID 命名（如 `01a13dbc-c9d2-7a71-b68c-166dd6b8f0ca`），而插件源码硬编码了 `.filter((name) => name.startsWith('session-'))`，导致这些会话在 `listSessions()` 中被直接过滤丢弃。用户使用 `rrr` 追问时被误判为「那个会话已经不在了，rrr 发不出去」，且标题丢失为纯 ID。

**修法**：
- 在 `lib/session-index.js` 中新增 `isSessionDir(name)`，同时放行 `session-` 开头及合法 36 位 UUID 的目录；
- 在 `lib/runtime.js` 的 `rrr` 存活检查中，使用 `hasStoredSession(home, target.sessionId)` 作为真实物理存活判定依据；
- 在 `rememberFinished` 中为标题增加投影缓存兜底读取，避免会话标题显示为空。

---

## 三、设置项总表

| 设置 | 默认 | 来源 |
|---|---|---|
| `permissionPreset` | `danger-full-access` | 上游 |
| `requireConfirmation` | `true` | 上游 |
| `allowCrossSessionNotify` | `true` | 上游 |
| `settleMs` | `1200` | 上游（本机改成了 `3600000`） |
| `presenceNote` | 中文说明 | 上游（本机追加了"只在最后发消息"） |
| `mergeWindowMs` | `10000` | 上游 |
| `autoReplyAttachments` | `true` | 上游 |
| `maxReplyChars` | `4000` | 上游 |
| `workspacePath` | `''` | 上游 |
| `notifyAllSessions` | `false` | **改造 2** |
| `quickWorkspacePath` | `''` | **改造 6** |
| `markdownMode` | `plain` | **改造 10** |
| `finishPromptChars` | `60` | **改造 3** |

---

## 四、上游更新后的应用步骤

见 `docs/UPGRADE.md`。
