/**
 * QQ 渠道运行时。
 *
 * 负责：连上 QQ 官方 WebSocket → 入站消息映射到 DSH 会话 → 助手流聚合为回复 → 发回 QQ。
 *
 * ## 与微信插件对应的结构
 *
 * | 微信插件 | 这里 |
 * |---|---|
 * | `ChannelMonitor`（自研长轮询） | `QQBot.start()`（官方 SDK 的 WebSocket + RESUME） |
 * | `login()` 异步生成器 | `startQrConnect()`（见 `login.js`） |
 * | 自研 sendText / 两段式媒体上传 | `bot.sendText` / `bot.sendMedia`（含 ≥5MiB 自动分片） |
 * | 自研 `-14` 冷却与退避 | SDK 的 `withRetry` + `ReplyLimiter` |
 * | `#sendOrQueue` + `pendingNotifications` | 被动优先 + 主动兜底（见 `#send`） |
 *
 * ## 范围
 *
 * **只做 1:1 私聊**（`scope: 'c2c'`）。不做群聊，所以没有 group 维度、没有 @ 判定、没有群白名单。
 *
 * @module dsh-qq/runtime
 */
import { randomUUID } from 'node:crypto'
import { statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { ReplyLimiter, TEXT_CHUNK_LIMIT, chunkText } from '@tencent-connect/qqbot-nodejs/protocol'
import {
  parseApprovalReply,
  parseQuestionReply,
  presentApproval,
  presentQuestions,
} from './interactions.js'
import { bootLog, describeError, recordOnce } from './log.js'
import { QqBindSession } from './login.js'
import { describeMedia, describeMissing, downloadAttachment, mediaDir } from './media.js'
import { composeDelivery, composePrompt, splitRouteText } from './prompt.js'
import {
  dropPending,
  expirePendingNotifications,
  pendingFor,
  queuePendingNotification,
} from './pending.js'
import { longReplyFileName, planReply } from './reply-limit.js'
import { hasMarkdown, markdownToPlain } from './plain-text.js'
import { resolveWorkspaceDir } from './paths.js'
import { SessionRouter, compareSessionsNewestFirst, mintSessionId, relativeTime, shortId } from './router.js'
import { mediaKindFor, notifyQqToolDefinition, sendToQqToolDefinition } from './send-tools.js'
import {
  TOOL_NAME,
  sessionToolDefinition,
  switchConfirmation,
  switchFailure,
  workspaceLabel,
} from './session-tool.js'
import {
  hasStoredSession,
  isSameWorkspace,
  listAllStoredSessions,
  listStoredSessions,
  readStoredSessionDetails,
  storedSessionWorkspace,
} from './session-index.js'
import { readStreamFrame } from './stream-frame.js'
import { conversationKey, StateStore } from './state.js'
// 设置项的定义**只有一份**（`lib/settings.js`）。原来的三份手抄名单
// （这里的 9 个 `DEFAULT_*` 常量、`#persistSettings()` 的落盘清单、加载逐字段 if）
// 已经全部改成由它派生：加一项设置只需在 schema 里加一行。
import { SETTINGS_DEFAULTS, SETTINGS_KEYS, SETTINGS_SCHEMA, normalizeSettings } from './settings.js'

/** 会话标题前缀。 */
const TITLE_PREFIX = 'QQ'

/**
 * 本频道工作区在桌面端显示的文件夹名。
 *
 * 与微信插件 `WORKSPACE_TITLE = '微信会话'` 对应——那边是「微信会话」，这边是「QQ 会话」。
 */
const WORKSPACE_TITLE = 'QQ 会话'

/*
 * 九项设置的默认值与校验器**不在这里**——它们只有一份，在 `lib/settings.js`。
 *
 * 这里原来摊着九个 `DEFAULT_*` 常量（外加 `boundedMs` / `boundedChars` 两个边界函数），
 * 与 `state.js` 的加载白名单、`#persistSettings()` 的落盘清单是三份各写各的名单。
 * 加一项设置时漏掉其中任何一份都会静默丢字段（见 `settings.js` 文件头）。
 * 现在默认值从 `SETTINGS_DEFAULTS` 取，边界在 schema 的校验器里，只有一处。
 */

/** typing 指示的刷新间隔与单次时长（秒）。 */
const TYPING_REFRESH_MS = 5_000
const TYPING_DURATION_SEC = 8

/**
 * typing 刷新的**总时长上限**（微信的 `TYPING_MAX_MS`）。
 *
 * 超过之后停止刷新：一个卡住的回合不该让"正在输入"永远亮着。
 * 那既泄漏一个定时器，也在**说一句谎话**——它让"还在想"和"已经死了"看起来一样。
 */
const TYPING_MAX_MS = 30 * 60 * 1000

/** 错误环形缓冲上限。 */
const MAX_ERRORS = 50

/**
 * 完成推送里，提问与结果之间的分隔线：**20 个连续的 `-`**。
 *
 * 用户明确要求这个形状。用固定串而不是 `'-'.repeat(20)` 散落各处，
 * 是为了让"改分隔线"只有一处要改，且测试能钉住它。
 */
const FINISH_SEPARATOR = '-'.repeat(20)

/**
 * 把一段提问压成推送里那一行。
 *
 * 取**第一行非空内容**再截断：用户的原话里可能有换行与附件描述，
 * 整段塞进去会把"提问 / 分隔线 / 结果"这个三段式撑坏。
 *
 * @param text - 用户原话。
 * @param limit - 最多多少字；`<= 0` 表示不显示。
 * @returns 一行提问，可能为空串（不显示）。
 */
function clipQuestion(text, limit) {
  if (limit <= 0) return ''
  const line = firstLine(text)
  if (line === '') return ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/**
 * 把一个目录路径压成"工作区名"——取最后一段。
 *
 * `/run` 的第一行要的是"哪个项目"，完整路径在手机上会长到折行，
 * 反而看不出是哪几个任务。取末段正好是用户给那个目录起的名字。
 *
 * @param path - 绝对路径。
 * @returns 末段；路径异常时返回原样。
 */
function workspaceName(path) {
  if (typeof path !== 'string' || path === '') return '未知工作区'
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/**
 * 把毫秒数说成人话（`12 分 30 秒`）。
 *
 * 只保留最大的两级单位：`1 小时 5 分` 足够，`1 小时 5 分 12 秒 340 毫秒` 在手机上是噪音。
 *
 * @param ms - 毫秒。
 * @returns 可读时长。
 */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return hours > 0 ? `${String(days)} 天 ${String(hours)} 小时` : `${String(days)} 天`
  if (hours > 0) return minutes > 0 ? `${String(hours)} 小时 ${String(minutes)} 分` : `${String(hours)} 小时`
  if (minutes > 0) return seconds > 0 ? `${String(minutes)} 分 ${String(seconds)} 秒` : `${String(minutes)} 分`
  return `${String(seconds)} 秒`
}

/**
 * 取一段文本的第一行非空内容。
 *
 * `/run` 的第三行只放一句提问——用户的原话里可能有换行和附件描述，
 * 整段塞进去会把"一条三行"的格式撑坏。
 *
 * @param text - 原文。
 * @returns 第一行非空内容，可能为空串。
 */
function firstLine(text, maxChars = 60) {
  if (typeof text !== 'string') return ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed
  }
  return ''
}

/**
 * 从一段文本里认出快捷触发词（`111` / `rrr`），并把它剥掉。
 *
 * ## 为什么不能只认"开头 + 空格"
 *
 * 真实故障：用户想发「111190.254，132.231 两个服务器已经回收了」，
 * 三个 1 与内容之间**没有空格**，于是旧规则 `/^111(?:\s|$)/` 一个都没匹配上——
 * 那条消息被当成普通聊天发进了当前会话，快捷通道毫无反应。
 * 用户另一条消息把 `111` 放在了**结尾**，同样没被认出来。
 *
 * ## 只认**边界**，不认句子中间
 *
 * | 写法 | 结果 |
 * |---|---|
 * | `111 你好` | 触发，正文「你好」 |
 * | `111你好` | 触发（紧贴也算），正文「你好」 |
 * | `111190.254，…` | 触发，正文「190.254，…」 |
 * | `你好 111` | 触发（结尾也算），正文「你好」 |
 * | `第 111 行有问题` | **不触发**——111 在句子中间，那是内容 |
 * | `算一下 111 乘以 3` | **不触发**，同上 |
 * | `1111` / `111.5` | **不触发**——那是数量 |
 *
 * 中间不认是有意的：`111` 出现在句子中段时（「第 111 行」），
 * 把它当命令剥掉会**吃掉用户的内容**，而那比"少触发一次"糟得多。
 * 用户真正会用的两种写法——开头贴一个、结尾补一个——都认。
 *
 * ## 纯数字保护
 *
 * `111` 之后紧跟数字时（`1111`、`111.5`、`111190`），纯靠前缀分不清
 * "快捷前缀 + 内容"与"一个数字"。所以这里加一条：**首词整体是纯数字/小数**
 * 且不是恰好等于触发词时，判定为数量而不是前缀。
 * `111190.254，132.231` 里带逗号，不是纯数字，于是照样触发——这正是用户要的那条。
 *
 * @param text - 用户原文。
 * @param word - 触发词（`111` 或 `rrr`）。
 * @returns 剥掉触发词后的正文；不是触发时 `undefined`。
 */
function extractTriggerWord(text, word, options = {}) {
  const { allowMiddle = false } = options
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '' || !trimmed.includes(word)) return undefined

  /*
   * 整条就是触发词的重复（`1111`、`rrrr`）：那不是命令，是一个词。
   * 纯数字那条已经挡住 `1111`，这里再挡住 `rrrr` 这类。
   */
  const repeated = new RegExp(`^${word[0] === '1' ? '1' : word[0]}+$`)
  if (repeated.test(trimmed) && trimmed !== word) return undefined

  /*
   * 纯数字保护：只看**首词**。`1111` 的首词是 `1111`（纯数字，且不等于 `111`）→ 不是前缀。
   * `rrr` 是字母，这条对它天然不成立（`/^[\d.]+$/` 不会命中）。
   */
  const firstToken = trimmed.split(/\s/)[0] ?? ''
  if (firstToken !== word && /^[\d.]+$/.test(firstToken)) return undefined

  const leading = new RegExp(`^${word}`)
  const trailing = new RegExp(`(?:^|\\s)${word}$`)
  /*
   * 句中**独立成词**（两侧都是空白）的位置。
   *
   * 只有 `rrr` 允许这一条：字母词出现在句中（`//i rrr 要做的事`）几乎没有歧义，
   * 而 `111` 出现在句中常常是内容本身（「第 111 行」），剥掉会吃掉用户的话。
   */
  const middle = new RegExp(`(?:^|\\s)${word}(?=\\s|$)`)

  const hasLeading = leading.test(trimmed)
  const hasTrailing = trailing.test(trimmed)
  const hasMiddle = allowMiddle && middle.test(trimmed)
  if (!hasLeading && !hasTrailing && !hasMiddle) return undefined

  let body = trimmed
  if (hasLeading) body = body.replace(leading, ' ')
  if (hasTrailing) body = body.replace(trailing, ' ')
  if (hasMiddle) body = body.replace(middle, ' ')
  body = body.replace(/\s+/g, ' ').trim()
  /*
   * 剥掉残留的**斜杠指令前缀**（`/i`、`/help` 之类）。
   *
   * 场景：`//i rrr 要做的事` —— 剥掉 `//` 一层得到 `/i rrr 要做的事`，
   * 再剥掉 `rrr` 只剩 `/i 要做的事`。那个 `/i` 是给 DSH 的技能手势，
   * 不该跟着正文一起发给目标会话（目标会话收到 `/i` 会去找一个叫 i 的技能，
   * 而用户的意图是"开启 ADHD 模式 + 转达要求"两件事）。
   *
   * 只在**正文里只剩下指令词**时剥：`/i 要做的事` → `要做的事`。
   * 正文本身以 `/` 开头但不是已知指令形态时（`/usr/bin`）不动。
   */
  const loneCommand = /^\/([a-z][a-z0-9-]*)\s+([\s\S]+)$/i.exec(body)
  if (loneCommand !== null) body = loneCommand[2].trim()
  return body
}

/**
 * `/notify` 指令接受的"开"与"关"词表。
 *
 * 中英文都收，因为用户在手机上可能用任一语言；`1`/`0` 收是因为
 * 设置页显示的就是布尔，而有人习惯用数字表达。
 *
 * 这两个集合同时充当"无分隔符写法的白名单"（见 `#handleNotifyCommand`）：
 * 只有整体落在其中一个里，`/notifyon` 才被认成指令，`/notifications` 不会。
 */
const ON_WORDS = new Set(['on', '1', '开', '开启', '打开', 'true', 'yes'])
const OFF_WORDS = new Set(['off', '0', '关', '关闭', 'false', 'no'])

/**
 * 安全地读一个可选服务。
 *
 * 可选服务用 `ctx.get` 而不是 `inject`：声明了拿不到的服务会让插件 pending/failed，
 * 而本插件在缺 `webServer` / `workspaceRegistry` / `permissionPresets` 时只该**降级**，不该不加载。
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 从事件载荷的 `agent` 上取会话 id。
 *
 * `approval/request` 与 `user-questions/request` 都带 `agent`，而会话 id 在
 * `agent.session.id`——与 `agent/assistant-stream` 的载荷同构，所以两处用同一套读法。
 *
 * @param agent - 事件载荷里的 agent。
 */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * 从宿主的模型选择对象里挑出本插件要用的字段。
 *
 * 宿主有两种同形但**不等价**的来源：会话投影里的
 * `{ provider, model, reasoningEffort? }`，以及会话请求头里的配置对象
 * （同一组字段，外加模型参数、适配器默认值等一堆东西）。
 * 逐字段挑出来，是为了不让请求头里的其余内容进入回复文本或日志。
 *
 * @param source - 宿主的模型选择，或请求头配置。
 * @returns `{ provider, model, reasoningEffort? }`，读不到模型 id 时 `undefined`。
 */
function selectionOf(source) {
  const model = typeof source?.model === 'string' ? source.model : ''
  if (model === '') return undefined
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model,
    ...(typeof source.reasoningEffort === 'string' ? { reasoningEffort: source.reasoningEffort } : {}),
  }
}

/**
 * 把一个设置值渲染成日志里的一小段。
 *
 * `JSON.stringify` 而不是 `String`：空串、首尾空格、引号、`false` 与 `undefined`
 * 在日志里必须**看得出区别**——设置页"改了没生效"的排查全靠这个。
 *
 * @param value - 任意设置值。
 * @returns 一段文本。
 */
function formatSettingValue(value) {
  const text = JSON.stringify(value)
  return text === undefined ? 'undefined' : text
}

/**
 * 给一条会话索引记录带上它自己的工作目录。
 *
 * 路由靠这个字段分组出**会话夹**（`/list all`）；没有目录的记录就不带这个键，
 * 那在路由那边的含义是"本频道自己的"——记录里没有目录时，
 * 本对话是唯一能说它属于哪里的东西。
 *
 * @param session - `session-index` 交出来的行。
 * @param path - 它记录的工作目录，可能是空串。
 */
function withWorkspace(session, path) {
  const workspace = typeof path === 'string' ? path : ''
  return workspace === '' ? session : { ...session, workspace }
}

/**
 * 会话 id 相关工具。
 *
 * **唯一实现在 `router.js`**（那里是会话 id 的真正归属：`/list` 打印它、`/switch` 接受它）。
 * 这里只做转出，避免两处各写一份而慢慢漂移。
 */
export { mintSessionId, shortId } from './router.js'

export class QqRuntime {
  #ctx
  #home
  /**
   * 会话工作区目录。
   *
   * **不是只读的**：用户可在设置里改（`workspacePath`），改完立即生效于之后新建的对话。
   *
   * ⚠️ 它有两条硬约束（见 `paths.js` 文件头），改路径时都要守住：
   * 已存在的会话钉着它自己的 `cwd`（宿主比对不一致会直接抛 `ApiSessionCwdConflict`），
   * 所以**改路径只影响之后新建的对话**，旧对话留在旧文件夹——这是对的，
   * 但必须在设置页里说清楚，否则用户会以为旧对话丢了。
   */
  #workspace
  #credentials
  #store

  /** @type {QQBot | undefined} */
  #bot
  /** 当前账号 appId。 */
  #appId
  /** sessionId → 待发回复。 */
  #replies = new Map()
  /**
   * sessionId → 未绑定会话的待发结果（`notifyAllSessions` 用）。
   *
   * 与 `#replies` 分开的理由见 `#forwardUnbound`：绑定会话与未绑定会话可能同时
   * 在跑，共用一张表会让两边的旁白区互相污染。
   */
  #unboundReplies = new Map()
  /** conversationId → 最近一条入站消息（用于被动回复）。 */
  #lastInbound = new Map()
  /** 被动回复限流：SDK 默认每条消息最多 4 次、1 小时窗口（平台规则是 60 分钟内 5 次，插件没有改默认值）。 */
  #limiter = new ReplyLimiter()
  /** typing 刷新定时器。 */
  #typing = new Map()
  /** 诊断去重桶。 */
  #seen = new Set()
  /**
   * 上一次保存设置时**本版本不认识**的字段名。
   *
   * 只在"页面与宿主版本不一致"时非空（见 `applySettings`）。留着它是为了让
   * `settingsForPage()` 能把它回传给设置页——用户需要看到"这个字段没生效"，
   * 而不是一条「已保存」。
   */
  #ignoredSettings = []
  #errors = []
  /** 已处理的入站消息 id（去重）。 */
  #handledMessages = new Set()
  /**
   * sessionId → `{ startedAt, prompt }`：**这一轮是什么时候开始的、问的是什么**。
   *
   * `/run` 要用它回答"跑了多久"和"在跑什么"，而宿主的两样东西都给不全：
   *
   * - `sessionController.list()` 只给 `running: true/false` 与 `updatedAt`
   *   （后者是**最后一次写入**的时间，不等于回合开始时间）；
   * - 回合开始时间藏在会话事件流的 `turn/start` 里，读它要按会话去翻日志，
   *   每查一次 `/run` 就把所有会话的历史读一遍，代价与收益不成比例。
   *
   * 所以这里在**提交提示词那一刻**记下时间与内容。代价是：插件启动之前就已经在跑的
   * 会话没有记录（那种情况下面显示"开始时间未知"，而不是编一个数）。
   *
   * 只放内存：它是瞬时状态，重启后 `running` 本身也归零，持久化没有意义。
   */
  #runningSince = new Map()
  /**
   * 全部设置项（**一个对象，九个字段**）。
   *
   * 它由 `SETTINGS_DEFAULTS` 建出来，所以**"运行时持有的设置字段集"与
   * `SETTINGS_SCHEMA` 的键集在构造上就相同**——不存在第二份手抄名单可以漂移。
   * 原来的九个私有字段（`#settleMs` / `#permissionPreset` / …）就是这么没的：
   * 每个字段名都要在"落盘清单"里再抄一遍，而漏抄的那一项会静默丢失。
   *
   * 字段名只用于读写（`this.#settings.settleMs`），语义仍由各处注释负责。
   * 对外只读的入口是 `settingsSnapshot()` / `settingsForPage()`，
   * 字段名与默认值都从 schema 派生；`settingsSchema()` 把 schema 本身交出去，
   * 供测试断言键集一致（见 `scripts/verify.mjs`）。
   */
  #settings = { ...SETTINGS_DEFAULTS }
  /** 本频道工作区的 id，解析成功后缓存（避免每次都查注册表）。 */
  #workspaceId
  /** 会话路由：持有"哪个 QQ 对话对应哪个 DSH 会话"以及全部聊天内指令。 */
  #router
  /** 扫码绑定会话（设置页轮询它的状态）。 */
  #bindSession
  /**
   * conversationId → 正在等待回答的交互（审批或提问）。
   *
   * 同一对话里后来的提示会**替换**先前的：用户看的是最新那条，
   * 同时挂着两条会让一个含糊的回复无法归属。
   */
  #interactions = new Map()
  /** 已注册工具的注销函数，供设置变更后重新注册。 */
  #toolDisposer
  /**
   * 停靠中的附件批次：`conversationId → { lines, text, timer, accountId, peerId }`。
   *
   * 用户先发图、再打字问「这是什么」；两条各投一次的话，agent 只拿到图片那一轮
   * 就开始答，而问题落在下一轮。停靠把"图 + 紧随其后的说明"合成一次提交。
   */
  #pending = new Map()
  /** 媒体目录路径，按需创建并缓存。 */
  #mediaDirPath

  /**
   * @param ctx - 宿主上下文。
   * @param options.home - DSH 主目录。
   * @param options.stateFile - 状态文件路径。
   * @param options.workspace - 会话工作目录（**必须与已存在会话的 cwd 一致**）。
   * @param options.credentials - {@link import('./credentials.js').CredentialStore}
   * @param options.settleMs - 覆盖回复聚合静默窗口（测试用）。
   * @param options.permissionPreset - 覆盖会话权限预设（`'default'` 表示沿用 profile 策略）。
   */
  constructor(ctx, options) {
    this.#ctx = ctx
    this.#home = options.home
    this.#workspace = options.workspace
    this.#credentials = options.credentials
    this.#store = new StateStore(options.stateFile, {
      onError: (message) => this.#recordError(`state: ${message}`),
      /*
       * 重试**成功**的那一次走日志、不进错误环：它不是失败，不该出现在设置页的"错误"里
       * （那是"狼来了"）。
       *
       * 但它必须留下痕迹：否则没有人能知道这台机器上究竟有没有遇到过 Windows 的占用错误
       * ——而"重试到底有没有被用到"正是微信那边留着没修时最缺的那条证据。
       */
      onRetry: (message) => bootLog(`state: ${message}`),
    })
    this.#appId = options.appId ?? ''
    if (typeof options.settleMs === 'number') this.#settings.settleMs = options.settleMs
    if (typeof options.permissionPreset === 'string') this.#settings.permissionPreset = options.permissionPreset

    // 路由持有会话映射与指令实现；它通过下面这个窄接口回调本运行时。
    // 与微信插件同构：路由不知道 QQ 的存在，运行时不知道指令的存在。
    this.#router = new SessionRouter({
      gateway: this.#gateway(),
      store: {
        load: async () => (await this.#store.read()).bindings,
        save: async (bindings) => {
          await this.#store.update((next) => {
            next.bindings = bindings
          })
        },
        /*
         * 浏览位置与编号清单也交给状态文件。
         *
         * 微信把这两样都存在它的状态文件里，理由对本插件一样成立：
         * 「查看其余」没有目标（位置是唯一知道"在看哪份"的东西），
         * 而"引用一屏清单再回编号"要按那条消息印的编号解析（正文就是 QQ 引用给的东西）。
         * 不落盘的话，一次插件重载就会让两者同时失效。
         */
        loadRouteState: async () => {
          const state = await this.#store.read()
          return { browsing: state.browsing, sessionLists: state.sessionLists }
        },
        saveRouteState: async (routeState) => {
          await this.#store.update((next) => {
            next.browsing = routeState.browsing
            next.sessionLists = routeState.sessionLists
          })
        },
      },
      titlePrefix: TITLE_PREFIX,
      // 工作区：`/list` 只列属于它的会话，`/list all` 把它排在会话夹第一位。
      ownWorkspace: this.#workspace,
      ownWorkspaceLabel: WORKSPACE_TITLE,
      onDiagnostic: (line) => bootLog(line),
    })

    // 扫码绑定与手工录入共用 `rememberCredentials` 这一条落地路径——
    // 两者只有入口不同，落地逻辑必须一致。
    this.#bindSession = new QqBindSession({
      onConfirmed: async (credentials) => {
        await this.rememberCredentials(credentials)
      },
    })
  }

  /**
   * 把宿主会话控制器适配成路由需要的窄接口。
   *
   * 所有实现都是"幂等"的：`ensureSession` 对已存在的会话是**采纳**，不是重建。
   */
  #gateway() {
    return {
      /**
       * 创建一条新会话，并把它的**会话标题**一并交给宿主。
       *
       * ## 为什么与 `ensureSession` 分开
       *
       * 只有**创建**这一刻该给标题：采纳一条已有会话时改名会把它的标题覆盖掉
       * （用户自己起过、或宿主已经生成过一个，都不该被"这条消息的第一句话"盖掉）。
       * 而"这次是创建还是采纳"只有路由知道（`#bind` 是创建，`#switchTo` 是采纳），
       * 所以由它挑方法，而不是让这个方法去猜。
       *
       * ## 为什么必须给
       *
       * 不给的话宿主会拿**首条消息的措辞**当标题（`fallbackSessionTitle`，见
       * `#nameSession`），而那条消息是频道拼出来的：用户的话 + 附件描述 + 渠道说明
       * ——标题里会混进渠道说明。路由给的是由**用户自己的话**推导出来的标题。
       *
       * @param sessionId - 刚铸造出来的会话 id。
       * @param title - 会话标题；`undefined` 表示没有可命名的东西
       *   （`/new` 不带参数就是这样），让宿主自己从首条消息取。
       */
      createSession: async (sessionId, title) => {
        await this.#adoptSession(sessionId)
        if (typeof title === 'string' && title !== '') await this.#nameSession(sessionId, title)
      },

      /**
       * 绑定或恢复一条会话（**不动它的标题**）。
       *
       * 采纳时用**会话自己的工作区**而不是本插件的——见 `#adoptSession`。
       *
       * 这里刻意**没有** title 参数：它原来有，但宿主收不到（`#adoptSession` 从不用它），
       * 于是"路由传了标题"这件事看起来成立、实际什么也没发生。要给的标题走
       * `createSession`，要采纳的会话走这里，两条路各自只有一个调用者。
       */
      ensureSession: async (sessionId) => {
        await this.#adoptSession(sessionId)
      },

      prompt: async (sessionId, text) => {
        await this.#ctx.sessionController.prompt(
          {
            requestId: `qq-${randomUUID()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
      },

      /**
       * 整台机器上的全部会话，最新在前——`/list all` 与 `/switch` 的搜索空间。
       *
       * 每一行带上它自己的工作目录：`/list all` 的**会话夹**就是按它分组的，
       * 而路由只能信这条记录（文件夹名是有损编码，会把无关目录并到一起）。
       * 记录里没有目录的行**不带这个字段**，含义是"本频道自己的"——
       * 那是只有一个对话能为之背书的工作区。
       */
      listSessions: async () => {
        const byWorkspace = await listAllStoredSessions(this.#home)
        const flat = []
        for (const [path, list] of byWorkspace) {
          for (const session of list) flat.push(withWorkspace(session, path))
        }
        return flat.sort(compareSessionsNewestFirst)
      },

      /**
       * 只属于本频道工作区的会话。
       *
       * `/list` 用它来把本聊天创建的对话排在前面、其余仅报数量；
       * 没有它的话每条会话都会被当成本频道的，列表会显示整台机器。
       */
      listOwnSessions: async () => {
        const rows = await listStoredSessions(this.#home, this.#workspace)
        return rows.map((session) => withWorkspace(session, session.cwd))
      },

      cancel: async (sessionId) => {
        await this.#ctx.sessionController.cancel({ sessionId })
      },

      /**
       * 一条绑定绑着的会话还能不能收活（`router.js` 的 `sessionState` 契约）。
       *
       * ## 为什么要在复用绑定之前问
       *
       * 两种死法最终落到同一个地方——用户的提示词被"接受"，然后无声无息地消失，
       * 没有任何一层记下一个字——所以这个问题问在**复用之前**，而收不了活的会话被换掉。
       *
       * `archived` 从**工作区注册表**读，那是 DSH 记录这件事的地方：被归档的会话，
       * 它的提示词会被接受，而提示词提出的**步骤**被拒（`dsh-api-session-controller`
       * 的归档门卫），于是回合以 `blocked` 结束、永远不会有答案。
       * 磁盘上没有任何东西标记这条会话，所以注册表是唯一能答对的来源。
       *
       * ## ⚠️ 与微信不同的两处，以及不确定的地方
       *
       * 1. **微信读 `ctx.workspaceRegistry?.archivedSessionIds`**（`bundle/src/host.ts` 的
       *    `sessionState`，HEAD `6997579`）。QQ 这里**同一形状**，但 `archivedSessionIds`
       *    这个成员**我没有在 QQ 的宿主上核对过**——微信是拿它的 0.2.0-rc.2 组合核对的。
       *    所以读法写成"拿不到就当没有归档集合"，于是缺这个能力时退化成**只看磁盘**：
       *    那会让一条被归档的会话答 `usable`，也就是 QQ 保持现状（消息照旧被静默吞掉），
       *    **不会**造成新的错误行为。要真正生效，需要用户在一台装好 QQ 插件的机器上
       *    确认 `workspaceRegistry.archivedSessionIds` 存在。**未实测。**
       * 2. 微信先问 `storedSessionWorkspace`（读得出来的记录）再问 `hasStoredSession`（在不在）。
       *    这里合并成一次 `hasStoredSession`：它就是前者的超集——一条**读得出来**的记录
       *    必然 `stat` 得到，所以先问那一句只是重复读一次同一个文件。
       *
       * `missing` 与列表走的是同一份磁盘索引，意思是这条会话哪里都没有记录。
       * 那**同样**是一条会话在"被创建"与"第一个回合"之间的样子——所以路由不会相信
       * 年龄小于 `MISSING_BINDING_GRACE_MS` 的绑定给出的这个判定，而这里只报**原始事实**，
       * 不做决定。
       *
       * **存在但读不出来**的记录答 `usable` 而不是 `missing`：那是坏掉的存储而不是被删的会话，
       * 凭它换掉对话，就会每当绑定年龄越过宽限期再来一次。
       *
       * 没有工作区注册表时就没有归档集合，于是只有磁盘那一问。**失败照旧往上抛**：
       * 路由把抛错的探针按 `usable` 处理并记一行，一个坏掉的探针不该弄丢一条能用的对话。
       *
       * @param sessionId - 正要被复用的那条会话。
       * @returns `'archived'` / `'missing'` / `'usable'`。
       */
      sessionState: async (sessionId) => {
        const archived = safeGet(this.#ctx, 'workspaceRegistry')?.archivedSessionIds
        if (Array.isArray(archived) && archived.includes(sessionId)) return 'archived'
        return (await hasStoredSession(this.#home, sessionId)) ? 'usable' : 'missing'
      },

      /*
       * 模型三件事也是**注入**给路由的，与 `listOwnSessions` 同一条理由：
       * 路由不持有宿主服务，规则才能脱离 DSH 单测（见 `router.js` 的 `#gateway` 注释）。
       */
      listModels: async () => this.listModels(),
      currentModel: async (sessionId) => this.currentModel(sessionId),
      selectModel: async (sessionId, provider, model, reasoningEffort) =>
        this.selectModel(sessionId, provider, model, reasoningEffort),
    }
  }

  /** 会话工作目录。 */
  get workspace() {
    return this.#workspace
  }

  /** 状态存储。 */
  get store() {
    return this.#store
  }

  /** 当前连接的 appId，未连接时为空串。 */
  get appId() {
    return this.#appId
  }

  /** 当前会话权限预设。 */
  get permissionPreset() {
    return this.#settings.permissionPreset
  }

  /**
   * 本频道会话的权限预设目录。
   *
   * ⚠️ **预设名由部署方配置，不是固定的。** `@deepseek-ai/dsh-permission-presets` 的
   * `names` = `[...配置表键名, ...(Auto integration 存活时再加 'auto')]`。
   * 所以**不能硬编码**可选值——必须问服务。
   *
   * 其中 `auto` 是保留名，旋钮组合固定为 **Full access 沙箱 + `ask` 审批策略**，
   * 也就是"能弹权限提示"的那一个。`custom` 也是保留名，但它只能被推导出来、不能被选中。
   *
   * 本插件 `permissionPreset` 的取值语义：
   * - 任一真实预设名 → 施加它
   * - `'default'`（**哨兵值，不是预设名**）→ 不施加任何预设，沿用 profile 自己的策略
   *
   * @returns `{ applied, sentinel, available, note }`
   */
  permissionPresetsInfo() {
    const service = safeGet(this.#ctx, 'permissionPresets')
    let available = []
    let note
    if (service === undefined) {
      note = '此组合没有权限预设服务'
    } else {
      try {
        available = Array.isArray(service.names) ? [...service.names] : []
      } catch (error) {
        note = `读取 names 失败：${describeError(error)}`
      }
      if (available.length === 0 && note === undefined) note = '服务报出的可选预设为空'
    }
    return { applied: this.#settings.permissionPreset, sentinel: 'default', available, note }
  }

  /**
   * 切换本频道会话的权限预设。
   *
   * 只影响**之后新建或采纳**的会话：DSH 在会话第一个回合开始后就锁定预设
   * （`agent-preset/locked`），已经跑过回合的会话改不了。
   *
   * @param preset - 真实预设名，或哨兵值 `'default'`（不施加任何预设）。
   * @param options.persist - 是否立即写回状态文件（默认 `true`）。
   *   `applySettings` 传 `false`——它自己末尾就写一次盘，不必为同一次变更写两遍。
   */
  setPermissionPreset(preset, { persist = true } = {}) {
    this.#settings.permissionPreset = preset
    bootLog(
      `权限预设已改为 '${preset}'${preset === 'default' ? '（哨兵：不施加任何预设，沿用 profile 策略）' : ''}（对之后新建或采纳的会话生效）`,
    )
    /*
     * ★ 这里的落盘**不能省**——它曾经漏掉，造成"设置不会保存"。
     *
     * 设置页切换预设走的是独立的 `POST /permission-preset`，那条路只调用本方法。
     * 少了这一句，界面显示新预设、状态文件里仍是旧值，**重启就回退**。
     * 而权限预设是设置页最显眼的控件，所以这个 bug 几乎必然被用户先撞上。
     *
     * 持久化放在 **setter** 而不是路由里，是为了让下一个调用者自动获得它：
     * 放在路由里的话，将来任何新入口（工具、命令行、别的页面）都会再漏一次。
     * 这与 `#targetFor`、`#mediaDir` 那些"只留一个判定点"的做法是同一条原则。
     */
    if (persist) this.#fire('保存权限预设', () => this.#persistSettings())
  }

  // ------------------------------------------------------------------ 模型

  /**
   * 本频道会话可用的模型清单（provider 分组已展平）。
   *
   * ## 这些调用对应宿主的哪一个接口
   *
   * 全部来自会话控制器服务 `sessionController`（`lib/types/index.js:208`
   * 以 `sessionController` 为键注册，本插件的 `inject` 已经拿到它）：
   *
   * - **列出**：`sessionController.modelCatalog()`
   *   （`dsh-api-session-controller/lib/types/index.js:373`，实现在
   *   `lib/types/catalog.js:10` 的 `buildModelCatalog`）。返回
   *   `{ default, routableProviders, groups: [{ id, name, models: [{ id, name, description?, reasoning? }] }], failures }`。
   *   它按 provider 分组，而选择模型要 `provider` + `model` **两个**值，
   *   所以这里展平成一行一个模型，并带上 provider。
   *   每个模型还带上它发布的 `reasoning.efforts`（id + 名字）与 `defaultEffort`——
   *   等级是模型自己的属性，`/model` 的清单要靠它印出"这个模型能想多深"，
   *   而那个信息在手机上别处看不到（见 `router.js` 的 `renderModelList`）。
   * - **读**：见 {@link currentModel}。
   * - **写**：见 {@link selectModel}。
   *
   * `failures` 里是**读不出来的提供方**（例如凭据没配好）。这里只把它们记进日志：
   * 一个坏提供方不该让整个清单变成空，否则用户看到的是"一个模型都没有"。
   *
   * @returns `{ provider, providerName, model, name, description?, levels?, defaultLevel? }[]`；
   *   没有接口时为空数组。
   */
  async listModels() {
    const controller = this.#ctx.sessionController
    if (typeof controller?.modelCatalog !== 'function') {
      this.#recordError('此组合的会话控制器没有 modelCatalog 接口，无法列出模型')
      return []
    }
    let catalog
    try {
      catalog = await controller.modelCatalog()
    } catch (error) {
      // **读目录失败不能让 `/model` 什么都不回**：命令抛出去会被入站处理的 catch 接住，
      // 用户看到的是"发了 /model 却没有任何反应"。回落空清单至少换来一句人话。
      this.#recordError(`读取模型目录失败: ${describeError(error)}`)
      return []
    }
    for (const failure of catalog?.failures ?? []) {
      // 每读一次记一次是有意的：这是"模型列表为什么少了一块"的唯一线索。
      bootLog(`模型目录：提供方 ${String(failure?.id)} 读取失败：${String(failure?.message)}`)
    }
    const rows = []
    for (const group of catalog?.groups ?? []) {
      for (const model of group.models ?? []) {
        const reasoning = model?.reasoning
        const levels = Array.isArray(reasoning?.efforts)
          ? reasoning.efforts
              .map((effort) => ({
                id: String(effort?.id ?? ''),
                name: String(effort?.name ?? effort?.id ?? ''),
              }))
              .filter((level) => level.id !== '')
          : []
        rows.push({
          provider: String(group.id),
          providerName: String(group.name ?? group.id),
          model: String(model.id),
          name: String(model.name ?? model.id),
          ...(model.description === undefined ? {} : { description: String(model.description) }),
          ...(levels.length === 0 ? {} : { levels }),
          ...(typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort !== ''
            ? { defaultLevel: reasoning.defaultEffort }
            : {}),
        })
      }
    }
    return rows
  }

  /**
   * 某个会话**当前生效**的模型选择。
   *
   * 两个来源，按可靠性排序：
   *
   * 1. 会话投影 `modelSelection`（`sessionController` 在构造时注册，
   *    `dsh-api-session-controller/lib/types/model-selection-projection.js:42-53`）。
   *    它的状态是 `{ lastUsed, pending }`，对外视图是 `{ lastUsed, next }`，
   *    而 `next = pending ?? lastUsed`——桌面端的模型选择器读的正是 `next`
   *    （`dsh-client-ui-model-selection/lib/client.js:316,333`）。
   *    这里的读法与它一致，于是手机与桌面显示的是同一个模型。
   * 2. 会话最近一次请求头 `session.requestHeader()?.config`
   *    （`dsh-session/lib/types/index.js:629`）。投影服务缺失时的兜底。
   *
   * 都没有时返回 `undefined`：含义是"这个会话还没有自己的选择，用的是部署默认"，
   * 由调用方（`/model` 的清单）用目录里的 `default` 补上。
   *
   * @param sessionId - 目标会话。
   */
  currentModel(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const session = safeGet(this.#ctx, 'sessions')?.get?.(sessionId)
    if (session === undefined) return undefined

    const state = safeGet(this.#ctx, 'sessionProjections')?.stateOf?.(session, 'modelSelection')
    const next = state?.pending ?? state?.lastUsed ?? undefined
    if (next !== undefined && next !== null) return selectionOf(next)

    const header = session.requestHeader?.()?.config
    if (header !== undefined && header !== null) return selectionOf(header)
    return undefined
  }

  /**
   * 切换某个会话使用的模型。
   *
   * 调的是 `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`
   * （`dsh-api-session-controller/lib/types/index.js:349`，实现
   * `lib/types/commands.js:126-159`——它把 `reasoningEffort` 一起交给
   * `llm.resolveCallConfig`，所以推理等级与模型是**同一次**选择）。三条与"能不能用"直接有关的事实：
   *
   * 1. **会话跑过第一个回合之后仍然可以改。** 这一点与权限预设**不同**：
   *    预设被 `agent-preset/locked` 挡在"会话已经开始"之后
   *    （`dsh-agent-preset-registry/lib/index.js:755-756`），而 `selectModel`
   *    没有这道闸——它先 `resolveAgent`（必要时恢复会话），再把选择记成
   *    会话自己的 `model/selection` 事件（`lib/types/agent.js:349-352`）。
   * 2. **对正在跑的那一步不生效，对下一步生效。** 宿主在组装提示词时先给选择拍快照，
   *    再在 `agent/request` 上套用 provider/model，注释写明这是为了
   *    "让并发的切换落在后面的一步上，而不是把两个面撕开"
   *    （`dsh-agent/lib/types/model-selection.js:27-34`）。
   *    所以本方法返回后**不能**声称"这一步就已经是新模型了"。
   * 3. **换 provider/model 会往下一次被接纳的请求里追加一条持久通知**
   *    （`[model changed: ...]`，`model-selection.js:12-26`），告诉模型它上面那些回合是别人写的。
   *
   * 副作用（宿主行为，本插件不额外做任何事）：`selectModel` 还会**在后台把部署默认模型
   * 也改成它**（`commands.js:165-167`），所以这里切一次，之后新建的会话也会用它——
   * 前提是这个组合挂了 `configEditor`，没有的话宿主直接跳过保存。
   *
   * @param sessionId - 目标会话。
   * @param provider - 提供方 id。
   * @param model - 提供方自己的模型 id。
   * @param reasoningEffort - 可选的推理等级 id（适配器的取值，例如 `high`）。
   *   **等级随模型一起交下去，不留给宿主去默认**（微信同一条注释）：漏掉它等于把
   *   "想多深"的决定交给一个用户看不见的解析步骤，而同一个模型在不同等级上是两个回答。
   *   与当前相同的 provider/model 再指名一个等级，就是"只改等级"。
   * @returns 宿主归一化后的选择 `{ provider, model, reasoningEffort? }`。
   * @throws 宿主拒绝时抛出（不可用的模型、找不到的会话、写者被占用…）。调用方负责说出来。
   */
  async selectModel(sessionId, provider, model, reasoningEffort) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.selectModel !== 'function') {
      throw new Error('此组合的会话控制器没有 selectModel 接口，无法切换模型')
    }
    const result = await controller.selectModel({
      sessionId,
      provider,
      model,
      // 没指名等级时**不带这个键**：宿主据此应用模型自己的默认等级，
      // 而写一个 undefined 进去会让"没指名"与"指名了空值"变成同一件事。
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    return result?.selected ?? { provider, model }
  }

  /**
   * 设置项的定义（schema 本身）＋**运行时此刻实际持有的字段集**，供宿主内省与测试断言。
   *
   * `heldKeys` 是照着 `#settings` 现场取出来的键数组（**不是**另一份写死的名单，
   * 也不是那份默认值模板），所以它就是"运行时真正持有的设置字段"。
   *
   * 为什么要有它：`#settings` 初始化为 `{ ...SETTINGS_DEFAULTS }`，所以"加了设置却忘了
   * 加进 schema"这一类漏改会让**运行时比 schema 多一个字段**。
   *
   * ⚠️ 这类漏改**只有这一条断言抓得住**，下面两条都抓不住：
   * `settingsSnapshot()` 的循环也走 `SETTINGS_KEYS`（多出来的字段根本不出现），
   * 而 `#persistSettings()` 同样只写 schema 的键（**于是那个字段永远写不出去**，
   * 用户重启后设置就没了）。所以这个测试断言不是装饰，它是这条漏改唯一的出口。
   * 测试把 `heldKeys` 与 schema 的键集对起来，这一漏改当场变红
   * （见 `scripts/verify.mjs`；它就是微信那个"加了设置却没加校验器是编译错误"的等价物）。
   *
   * @returns `{ schema, keys, heldKeys, defaults, normalize }`。
   */
  settingsSchema() {
    return {
      schema: SETTINGS_SCHEMA,
      keys: SETTINGS_KEYS,
      heldKeys: Object.keys(this.#settings),
      defaults: SETTINGS_DEFAULTS,
      normalize: normalizeSettings,
    }
  }

  /**
   * 设置页要用的可调项快照（扁平）。
   *
   * 每个字段都与它的默认值并列，页面才能同时显示"当前值"与"默认值"并提供一个重置入口。
   *
   * **由 schema 驱动**：字段名遍历 `SETTINGS_KEYS`，默认值取 `SETTINGS_DEFAULTS`。
   * 所以加一项设置不需要动这个方法——原来这里也是手抄的九项（值 + 默认值共十八行）。
   */
  settingsSnapshot() {
    const snapshot = {}
    for (const key of SETTINGS_KEYS) {
      snapshot[key] = this.#settings[key]
      // 页面读的键名是 `<字段>Default`（`client.js` 与既有测试都按这个名字读），保持不变。
      snapshot[`${key}Default`] = SETTINGS_DEFAULTS[key]
    }
    return snapshot
  }

  /**
   * 设置页要用的形状：当前值与默认值**分成两个对象**。
   *
   * 方法名与返回形状都照抄 `dsh-wechat-plugin` 的同名方法（它在
   * `client.js` 里被解构成 `settings?.settings` 与 `settings?.defaults`），
   * 这样设置页移植过去无需改写数据流。
   *
   * 两个对象同键，键集同样来自 schema。
   */
  settingsForPage() {
    const settings = {}
    const defaults = {}
    for (const key of SETTINGS_KEYS) {
      settings[key] = this.#settings[key]
      defaults[key] = SETTINGS_DEFAULTS[key]
    }
    /*
     * `unknown` 是**上一次保存时被忽略的字段名**，随每次读回一起交出去。
     *
     * 为什么要回传而不是只在日志里写一行：设置页拿到它才能当场提示
     * "这个字段没被接受"，否则用户看到的仍然是「已保存」——
     * 而那正是这次真实故障的样子（页面比宿主新，字段被静默丢弃）。
     * 正常情况下它是空数组，页面不需要做任何事。
     */
    return { settings, defaults, unknown: [...this.#ignoredSettings] }
  }

  /**
   * 从状态文件读回用户调过的设置。
   *
   * 在 `start()` 里调用一次，也就是在任何消息到达、任何工具被调用之前。
   * 缺字段保持默认值，所以老状态文件与全新安装都是同一套代码路径。
   *
   * **由 schema 驱动**：逐字段过 schema 的校验器，通过才写进 `#settings`。
   * 校验器同时负责"类型对不对"与"值合不合理"（上下限、取整），
   * 而 `state.js` 用的是同一张表——所以两层边界不可能各自漂移。
   */
  async hydrateSettings() {
    try {
      const { settings } = await this.#store.read()
      /*
       * 状态文件可能被手工编辑过，而一个十小时的窗口在运行时的表现就是
       * "设置生效了但什么都不工作"，所以读回时**照旧过一遍上下限**——
       * 与 `applySettings` 用的是同一批校验器，"读回"与"施加"因此不会分家。
       *
       * 类型不对或越界**整条丢弃**：保持默认值（对读回而言就是默认值）。
       */
      Object.assign(this.#settings, normalizeSettings(settings))
      /*
       * 会话文件夹：读回时就把路径落实（校验与回落都在 `#switchWorkspace` 里），
       * 否则重启后仍会用构造时那个目录。
       *
       * ⚠️ `workspacePath` 与其余字段有一处**刻意的不同**：它在运行时的值是 trim 过的
       * （见 `applySettings`），而那一步在 schema 里——schema 只判类型、不动字符，
       * 因为设置页要显示用户填的原文。所以这里补一次 trim。
       */
      this.#settings.workspacePath = this.#settings.workspacePath.trim()
      this.#switchWorkspace(this.#settings.workspacePath)
      /*
       * 快速对话目录：读回时同样 trim，并把目录建出来（`resolveWorkspaceDir` 会 mkdir）。
       *
       * 这里**不切工作区**——它是一条旁路，本频道的 cwd 不受影响。
       * 建不出来只记一行：`111` 真正到来时会回退成普通文本并告诉用户原因，
       * 而这里抛错会把整个渠道的启动带下去。
       */
      this.#settings.quickWorkspacePath = this.#settings.quickWorkspacePath.trim()
      if (this.#settings.quickWorkspacePath !== '') {
        const quickResolved = resolveWorkspaceDir(this.#home, this.#settings.quickWorkspacePath)
        if (quickResolved.fellBack) {
          bootLog(`快速对话目录不可用：${String(quickResolved.reason)}（111 将按普通文本处理）`)
          this.#recordError(`快速对话目录不可用：${String(quickResolved.reason)}`)
        } else {
          bootLog(`快速对话目录：${quickResolved.path}`)
        }
      }
      bootLog(
        `设置已读回：preset=${this.#settings.permissionPreset} confirm=${String(this.#settings.requireConfirmation)} ` +
          `crossNotify=${String(this.#settings.allowCrossSessionNotify)} settle=${String(this.#settings.settleMs)}`,
      )
    } catch (error) {
      // 读不回设置不该阻止渠道启动：默认值是安全的，用户顶多需要再设一次。
      this.#recordError(`读回设置失败（按默认值继续）: ${describeError(error)}`)
    }
  }

  /**
   * 把当前设置写回状态文件。失败只记录——写不进去不该让这次设置变更看起来"没发生"。
   *
   * 落盘清单**由 schema 派生**（遍历 `SETTINGS_KEYS`），不再手抄第二遍。
   * 这一点是这次修复的核心：原来 `state.js` 的加载白名单与本方法的落盘清单是
   * 两份各写各的九项名单，加设置时漏掉任何一份都会静默丢字段，
   * 而**每次写盘都会重新加载并重新规范化**，于是下一次写盘把丢失持久化。
   */
  async #persistSettings() {
    try {
      const settings = {}
      for (const key of SETTINGS_KEYS) settings[key] = this.#settings[key]
      await this.#store.update((next) => {
        next.settings = settings
      })
    } catch (error) {
      this.#recordError(`保存设置失败: ${describeError(error)}`)
    }
  }

  /**
   * 施加一批设置变更。
   *
   * **由 schema 驱动**：每个字段过它自己的校验器，通过才写。校验器返回 `undefined`
   * 的含义是"这个字段不改"（保持原值），而不是"回落到默认值"——一个畸形请求不该把
   * 用户已经调好的设置重置掉。
   *
   * 两个字段额外做事：
   *
   * - `permissionPreset` 走 `setPermissionPreset()`（`persist: false`：本方法末尾统一
   *   写一次盘，不必为同一次变更写两遍），因为它还要打日志；
   * - `workspacePath` 要 trim 并立即落实路径（坏路径只能"没生效"，绝不能抛到这里）。
   *
   * ⚠️ **`requireConfirmation` 变更后必须重新注册工具**：那个策略只存在于
   * `session_control` 的**描述**里，而注册表是按值取走描述的（见 `session-tool.js`）。
   * 不重新注册的话，设置页看起来"改了但没效果"。
   *
   * @param patch - 要改的字段。
   * @returns 变更后的快照。
   */
  applySettings(patch) {
    const before = this.#settings.requireConfirmation
    /*
     * 变更前的生效值，以及请求里**真正带了**的字段名。
     *
     * 这两样加上变更后的值，是 `state.json` 给不出的信息：状态文件只记"现在存的是什么"，
     * 于是"这次保存根本没发出来"和"发出来了、主机没收下"在文件里长得一模一样。
     * 三个都在手里的地方只有这里，所以日志就在这里写（见下面 `设置已存档`）。
     */
    const prior = {}
    for (const key of SETTINGS_KEYS) prior[key] = this.#settings[key]
    const requested = []
    /** 请求带了、但校验不过因此被丢弃的字段（"发了没收下"的那一类）。 */
    const dropped = []
    /*
     * ★ 本地扩展：请求里带了**本版本不认识的**字段名。
     *
     * ## 为什么必须单独报出来
     *
     * 真实故障：设置页（浏览器缓存的旧 `client.js`）提交了 `quickWorkspacePath`，
     * 而当时宿主还没有这个键——循环只遍历 `SETTINGS_KEYS`，表外的键**被静默忽略**，
     * 日志里连一个字都没有。用户看到的是"保存成功"，而那个值从来没进过状态文件。
     *
     * 两种版本不一致（页面比宿主新、或宿主比页面新）都会长这个样子，而它**无法从
     * `state.json` 反推**：文件里只有"现在存的是什么"，说不出"刚才有人想存别的东西"。
     *
     * 所以这里把它挑出来，下面既写日志、也**回传给调用方**——设置页据此提示用户
     * "这个字段没被接受"，而不是继续显示"已保存"。
     */
    const unknown = []
    for (const key of Object.keys(patch ?? {})) {
      if (!SETTINGS_KEYS.includes(key)) unknown.push(key)
    }
    // 记下供 `settingsForPage()` 回传；一次保存覆盖一次，不留陈旧值。
    this.#ignoredSettings = unknown
    for (const key of SETTINGS_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch ?? {}, key)) continue
      requested.push(key)
      const normalized = SETTINGS_SCHEMA[key].normalize(patch?.[key])
      if (normalized === undefined) {
        // 越界/类型不对：**保持原值**（schema 的语义，不是回落默认值）。丢弃这件事下面会写进日志。
        dropped.push(key)
        continue
      }
      if (key === 'permissionPreset') {
        this.setPermissionPreset(normalized, { persist: false })
      } else if (key === 'workspacePath') {
        /*
         * 会话文件夹：空串合法（含义是"用默认位置"）。
         * 具体的校验与回落交给 `#switchWorkspace`——它保证坏路径只是"没生效"，
         * 而不是把异常抛到 `apply` 上去让整个应用起不来。
         */
        this.#settings.workspacePath = normalized.trim()
        this.#switchWorkspace(this.#settings.workspacePath)
      } else if (key === 'quickWorkspacePath') {
        /*
         * 快速对话目录：空串 = 不启用（不是"用默认"）。
         *
         * 保存时就把目录**建出来**（`resolveWorkspaceDir` 内部 mkdir + 写探针），
         * 这样第一条 `111` 不必先撞一次 ENOENT。建不出来只是"没生效"——
         * 它会回落，而回落理由在真正用到 `111` 时才回报给用户，不在这里抛。
         */
        this.#settings.quickWorkspacePath = normalized.trim()
        if (this.#settings.quickWorkspacePath !== '') {
          const resolved = resolveWorkspaceDir(this.#home, this.#settings.quickWorkspacePath)
          if (resolved.fellBack) {
            bootLog(`快速对话目录不可用：${String(resolved.reason)}（111 将按普通文本处理）`)
            this.#recordError(`快速对话目录不可用：${String(resolved.reason)}`)
          } else {
            bootLog(`快速对话目录已就绪：${resolved.path}`)
          }
        }
      } else {
        this.#settings[key] = normalized
      }
    }
    if (this.#settings.requireConfirmation !== before) {
      bootLog(`requireConfirmation 已改为 ${String(this.#settings.requireConfirmation)}，重新注册工具`)
      this.refreshTools()
    }
    /*
     * 一行一次存档，**旧值和新值都写**。
     *
     * 被丢弃的字段会记成 `旧 -> 旧`，而这一行本身就是证据：字段出现在请求里、值却没人动，
     * 只能是"发了没收下"。所以还额外写出请求里的原始值——只有"值没动"这一半信息时，
     * 排查的人仍然得去猜是越界、类型不对，还是页面压根没发。
     *
     * ⚠️ 这里写的是**生效值**（内存里的设置），不是磁盘：落盘是 `#persistSettings`，
     * 它自己会为写失败记一行。两者分开写，是为了让"改生效了但没落盘"也看得出来。
     */
    const changes = requested.map((key) => {
      const pair = `${key} ${formatSettingValue(prior[key])} -> ${formatSettingValue(this.#settings[key])}`
      return dropped.includes(key)
        ? `${pair}（请求 ${formatSettingValue(patch?.[key])}，被丢弃，保持原值）`
        : pair
    })
    /*
     * 未知字段单独记一行，而且**不并进上面那条**：它说明的是"版本对不上"，
     * 与"值不合法"是两种完全不同的故障，混在一行里会被当成后者。
     */
    if (unknown.length > 0) {
      bootLog(
        `设置已忽略：请求里有本版本不认识的字段 ${unknown.join(', ')}——` +
          '设置页与宿主版本可能不一致，请刷新页面（Ctrl+Shift+R）后重试',
      )
      this.#recordError(
        `设置页提交了未知字段：${unknown.join(', ')}（页面与宿主版本不一致，请刷新页面）`,
      )
    }
    bootLog(
      changes.length === 0
        ? '设置已存档：请求里没有可用的设置字段——什么也没改'
        : `设置已存档：${changes.join('; ')}`,
    )
    this.#fire('保存设置', () => this.#persistSettings())
    return this.settingsSnapshot()
  }

  /**
   * 注销并重新注册全部工具。
   *
   * 用于描述按值被取走的那些设置发生变更之后。
   */
  refreshTools() {
    this.disposeTools()
    this.registerTools()
  }

  /** 是否已连上 QQ。 */
  get connected() {
    return this.#bot !== undefined
  }

  /**
   * 是否应当在启动时自动连接。
   *
   * 先看 config 的 `autoStart`，再看状态文件里用户上次的选择。
   */
  async enabled(configAutoStart) {
    if (configAutoStart === true) return true
    const state = await this.#store.read()
    return state.autoStart === true
  }

  /**
   * 连接 QQ。
   *
   * @param appId - 要连接的机器人。省略时取状态里第一个已启用的账号。
   */
  async start(appId) {
    if (this.#bot !== undefined) {
      bootLog('start: 已经在运行，忽略重复调用')
      return
    }
    // 先读回用户调过的设置：这样在任何消息到达之前，权限预设与会话工具描述都已经是用户选的那份。
    await this.hydrateSettings()
    const state = await this.#store.read()
    const targetAppId = appId ?? Object.keys(state.accounts).find((id) => state.accounts[id]?.enabled !== false)
    if (targetAppId === undefined) {
      bootLog('start: 没有已绑定的账号，等待扫码绑定')
      return
    }
    if (!this.#credentials.available) {
      bootLog('start: 此组合没有凭据服务，无法取回 AppSecret')
      return
    }
    const credential = await this.#credentials.load(targetAppId)
    if (credential === undefined) {
      bootLog(`start: 找不到 ${targetAppId} 的凭据（可能被清理了），需要重新扫码绑定`)
      return
    }

    this.#appId = targetAppId
    const bot = new QQBot({
      appId: credential.appId,
      appSecret: credential.appSecret,
      accountId: credential.appId,
      /*
       * ⚠️ **这个 logger 不是可选的装饰。**
       *
       * SDK 会把 handler 里抛出的异常**接住并打到 `logger.error`**，不让它变成
       * unhandled rejection（`USAGE.md:265`）。不传 logger 就落到 SDK 的默认空 logger 上，
       * 于是 handler 出错时日志里**一片空白**——现象只是"连上了、但发消息没反应"。
       *
       * 这不是假想的风险：第三步探针的 message handler 因为在箭头函数里用了 `arguments`
       * 而第一行就 ReferenceError，因为没有接日志，查了一整轮才找到
       * （见 `docs/STEP3-能力调研与实现规格.md` 顶部第 5 条）。
       *
       * **空白应当被当成"缺少观测"，而不是"没有发生"。** 所以三条都接到 `bootLog` 上，
       * 与插件自己的日志共用一份时间线。
       */
      logger: {
        info: (message) => bootLog(`sdk info  ${message}`),
        warn: (message) => bootLog(`sdk warn  ${message}`),
        error: (message) => bootLog(`sdk error ${message}`),
      },
    })

    bot.on('ready', () => bootLog(`READY appId=${credential.appId}`))
    bot.on('resumed', () => bootLog('RESUMED'))
    bot.on('error', (error) => this.#recordError(`qq sdk error: ${describeError(error)}`))
    // 只处理私聊。群里的事件直接忽略——本插件不做群聊。
    bot.on('rawEvent', (eventCtx) => {
      recordOnce(this.#seen, '#rawEventTypes', `rawEvent: ${eventCtx.eventType}`)
    })
    bot.on('message', (middlewareCtx, message) => this.#handleInbound(middlewareCtx, message))

    this.#bot = bot
    bootLog(`start: 正在连接 appId=${credential.appId}`)

    // start 会一直挂着直到 stop/abort，所以不 await。
    void bot.start().catch((error) => {
      this.#recordError(`连接失败: ${describeError(error)}`)
      bootLog(`start: 连接失败 ${describeError(error)}`)
      this.#bot = undefined
    })
  }

  /** 断开连接。 */
  async halt() {
    this.#stopTypingAll()
    // 停靠批次的定时器必须在这里清掉：**不能有定时器活得比插件长**，
    // 否则它会在运行时被拆除之后触发，去碰已经不存在的东西。
    this.#clearParked()
    await this.flushReplies()
    const bot = this.#bot
    this.#bot = undefined
    if (bot !== undefined) {
      try {
        bot.stop()
      } catch (error) {
        bootLog(`halt: stop 抛错 ${describeError(error)}`)
      }
    }
  }

  /**
   * 保存一份凭据并尝试连接。
   *
   * **扫码绑定与手工录入共用这一条路径**——两者的差别只在入口，落地逻辑必须一致，
   * 否则"手填能用、扫码不能用"这类分歧会长期潜伏。
   *
   * @param params.appId - 机器人 AppID。
   * @param params.appSecret - 机器人 AppSecret。
   * @param params.userOpenid - 扫码人 openid（可选）。
   * @returns 保存后的 payload（含 appSecret，仅返回给调用方，不落日志）。
   */
  async rememberCredentials({ appId, appSecret, userOpenid }) {
    const saved = await this.#credentials.save({ appId, appSecret, userOpenid })
    await this.#store.update((next) => {
      next.accounts[appId] = {
        appId,
        userOpenid: saved.userOpenid,
        boundAt: saved.boundAt,
        enabled: true,
      }
      next.autoStart = true
    })
    bootLog(`凭据已保存 appId=${appId} openid=${saved.userOpenid ?? '(未提供)'}`)
    if (this.#bot === undefined) {
      await this.start(appId)
    }
    return saved
  }

  /**
   * 忘记某个账号：删除凭据与其状态。断开连接。
   *
   * @param appId - 机器人 AppID。
   */
  async forget(appId) {
    await this.halt()
    await this.#credentials.remove(appId)
    await this.#store.update((next) => {
      delete next.accounts[appId]
      for (const [conversationId, binding] of Object.entries(next.bindings)) {
        if (binding.accountId === appId) delete next.bindings[conversationId]
      }
    })
    if (this.#appId === appId) this.#appId = ''
    /*
     * 把扫码状态也复位。
     *
     * 不复位的话，设置页会**继续显示「已连接：<刚解绑的 appId>」**——因为
     * `QqBindSession` 的 `succeeded` 是终态、没有过期机制（微信有
     * `LOGIN_RESULT_TTL_MS = 30s` 来清它，QQ 这边没有）。
     *
     * 刚解绑却显示已连接，是那种"看起来正常所以没人报"的错误：
     * 用户会以为解绑没成功，然后再点一次。
     */
    this.#bindSession.cancel()
    bootLog(`已解绑 appId=${appId}`)
  }

  // ------------------------------------------------------------ 设置页支撑

  /** 扫码绑定的当前状态，供设置页轮询。 */
  bindSnapshot() {
    return this.#bindSession.snapshot()
  }

  /** 开始扫码绑定。 */
  async startBind(source) {
    await this.#bindSession.start({ source })
    return this.#bindSession.snapshot()
  }

  /** 取消扫码绑定。 */
  cancelBind() {
    this.#bindSession.cancel()
    return this.#bindSession.snapshot()
  }

  /**
   * 打开或关闭这个渠道。
   *
   * 关闭只停止监听，**保留凭据**——这与 `forget()` 的区别正是设置页上半部分
   * "停用"与下半部分"解绑"的区别。
   *
   * @param enabled - 目标状态。
   */
  async setEnabled(enabled) {
    await this.#store.update((next) => {
      next.autoStart = enabled
    })
    if (enabled) await this.start()
    else await this.halt()
    return await this.status()
  }

  /**
   * 已绑定账号的清单，供设置页展示与解绑。
   */
  async accountsSnapshot() {
    const state = await this.#store.read()
    const rows = []
    for (const [appId, account] of Object.entries(state.accounts)) {
      let configured = false
      try {
        const described = await this.#credentials.describe(appId)
        configured = described?.configured === true
      } catch {
        configured = false
      }
      rows.push({
        appId,
        userOpenid: account.userOpenid,
        boundAt: account.boundAt,
        enabled: account.enabled !== false,
        hasCredentials: configured,
        active: this.#appId === appId && this.#bot !== undefined,
      })
    }
    return rows
  }

  // ---------------------------------------------------------------- 入站

  /**
   * 一条私聊消息 → 一次 DSH 提交。
   *
   * @param middlewareCtx - SDK 中间件上下文（保留给后续中间件使用）。
   * @param message - SDK 归一化后的入站消息。
   */
  async #handleInbound(middlewareCtx, message) {
    try {
      if (message.kind !== 'c2c') {
        // 不做群聊。记录一次见过的类型即可。
        recordOnce(this.#seen, `#ignoredKind:${message.kind}`, `忽略非私聊消息 kind=${message.kind}`)
        return
      }
      // 官方文档明确：极端情况下同一条 msg_id 可能重复推送。必须去重。
      if (typeof message.messageId === 'string') {
        if (this.#handledMessages.has(message.messageId)) {
          bootLog(`入站: 重复消息，已忽略 ${message.messageId.slice(0, 24)}…`)
          return
        }
        this.#handledMessages.add(message.messageId)
        if (this.#handledMessages.size > 2000) {
          // 粗略裁剪即可——去重只需要覆盖重投递窗口。
          this.#handledMessages = new Set([...this.#handledMessages].slice(-1000))
        }
      }

      const accountId = this.#appId
      const peerId = message.senderId
      if (peerId === undefined || peerId === '') {
        this.#recordError('入站消息没有 senderId，无法定位会话')
        return
      }
      const conversationId = conversationKey(accountId, peerId)

      // 记住这条消息，回复时才能走被动通道。
      this.#lastInbound.set(conversationId, {
        peerId,
        msgId: message.messageId,
        at: Date.now(),
      })

      const attachments = message.attachments ?? []

      /*
       * 用户说话了 → 窗口重新打开 → **先补发积压的待发消息**，再处理这条。
       *
       * 顺序是有意的（微信的注释）：用户自己的消息才是"重新打开窗口"的东西，
       * 所以积压的通知属于这条回答**之前**——否则用户等着的通知会出现在
       * 一条毫不相干的回复下面，看起来像是答非所问。
       */
      await this.#flushPending(conversationId)

      /*
       * 带附件的消息先**停靠**，不立刻投递。
       *
       * 理由（微信的注释写得很清楚）：用户先发一张图，再打字问「这是什么」——
       * 如果两条各自投递，agent 只拿到图片那一轮就开始答，而问题在下一轮。
       * 停靠把"图 + 紧随其后的说明"合成一次提交。
       *
       * **下载在停靠时就做**，因为 QQ 的附件是**会过期的 CDN 链接**，
       * 等窗口关闭再去取可能已经失效。
       */
      if (attachments.length > 0) {
        await this.#park(conversationId, message, attachments)
        return
      }

      /*
       * 引用与正文**分开**（见 `prompt.js` 的 `splitRouteText`）：
       * 引用里的正文要单独交给路由（它靠比对正文认出被引的那一屏清单），
       * 而"引用清单再回 `/switch 3`"必须按 `/switch` 解析——合成文本以 `[引用]` 开头时
       * 它看起来不是指令，会整条落进 agent 那一支。
       * `composed`（带引用的原形态）留给交互拦截与交付，那两条路一个字都不变。
       */
      const { text, quoted, composed } = splitRouteText(message)
      /*
       * 只引用、什么都没写也是一条消息（交给 agent 时就是那句引用），不该被丢掉。
       *
       * 反过来，走到这个 return 说明这条消息**没有任何可投递内容**：正文为空、没有引用、
       * 也没有附件（带附件的在上面就停靠了）。也就是说用户确实发了东西，而我们这边空空如也
       * ——协议里没映射到的形态（卡片 / 类型不在我们认识的表里）就是长这样。
       * 从前它是裸 `return`：消息消失，而日志里一个字都没有，连"收到过这条"都查不出来。
       *
       * ⚠️ 为什么是 `bootLog` 而**不是** `#recordError`：这一条不是"别处失败的结果"，而是
       * "平台递过来一个我们解析不出内容的形态"。它必须有声音（否则用户的消息凭空消失、
       * 任何地方都查不到），但不该占错误环的位置——用户的可见面是 `boot.log`（`logPath()`，
       * 设置页读的就是它），而错误环要留给真正失败的操作。`scripts/verify-send-path.mjs`
       * 那 60 项测试正是拿"空内容的入站消息"当**脚手架**（它设计上什么都不碰，
       * 见那里的 `seeInbound`），把它记成错误会让那些守着的断言变红——那等于把脚手架的约定
       * 误当成缺陷。
       */
      if (composed.trim() === '') {
        bootLog(
          `入站消息没有可投递内容，已丢弃：conversation=${conversationId} ` +
            `message=${String(message.messageId ?? '(none)')} ` +
            `msgType=${String(message.msgType ?? '(none)')} ` +
            `elements=${String(Array.isArray(message.msgElements) ? message.msgElements.length : 0)}`,
        )
        return
      }

      /*
       * 交互拦截必须在这里——**投递链的最前面**。
       *
       * 否则用户对一个权限提示回的「1」会被当成新请求发给 agent，
       * 而那条提示永远悬在那里。带附件的消息已在上面分流，不参与拦截。
       */
      if (await this.#settleInteraction(conversationId, composed)) return

      // 认领停靠的批次：它的说明文字排在本条之前（先发的图，后问的话）。
      const parked = this.#claimParked(conversationId)
      const combined = [parked.text, text].filter((part) => part.trim() !== '').join('\n\n')

      await this.#deliverPrompt({
        conversationId,
        accountId,
        peerId,
        text: combined,
        attachmentLines: parked.lines,
        ...(quoted === undefined ? {} : { quoted }),
      })
    } catch (error) {
      this.#recordError(`处理入站消息失败: ${describeError(error)}`)
    }
  }

  /**
   * 投递一次提示词：路由 → 提交。
   *
   * 从 `#handleInbound` 里拆出来，因为**停靠窗口到期**时也要走同一条路
   * （那时没有新的入站消息，只有一批停靠的附件）。一份实现、两个调用者。
   *
   * @param params.quoted - 被引用消息的正文；只交给路由（它靠它认出被引的那一屏清单），
   *   交付给 agent 时按原来的顺序拼回正文之前。
   * @param params.parkedAuto - 这条是**附件停靠窗口到期**自动投递的（用户没在说话）。
   *   为真时即使目标会话正忙也**不弹忙时抉择**，直接排队——
   *   那个提示问的是"你说的这句话怎么办"，而自动投递时压根没有"这句话"。
   */
  async #deliverPrompt({
    conversationId,
    accountId,
    peerId,
    text,
    attachmentLines,
    quoted,
    parkedAuto = false,
  }) {
    /*
     * ★ 本地扩展：`/notify` 指令，在路由之前拦截。
     *
     * 为什么在这里而不在 `router.js`：路由不持有设置（它只有 `#gateway`，见那里的注释），
     * 而读写这个开关需要运行时。放在这里等于"一份实现、一个入口"，
     * 且不影响路由"指令要么回话、要么给提示词"的两分法。
     */
    const notifyReply = await this.#handleNotifyCommand(text)
    if (notifyReply !== undefined) {
      await this.#send(conversationId, notifyReply)
      return
    }

    /*
     * `/run`：列出正在跑的任务。
     *
     * 同样抢在路由之前——路由的 `default` 分支会把未知 `/` 指令当成
     * 「未知指令」吞掉，`/run` 永远到不了这里。
     */
    const runReply = await this.#handleRunCommand(text, conversationId)
    if (runReply !== undefined) {
      await this.#send(conversationId, runReply)
      return
    }

    /*
     * ★ 本地扩展：先看这条消息是不是在回答"目标会话正忙，你要怎么办"。
     *
     * 必须排在**所有**其它分支之前（包括 `//` 转义和 `111`）：
     * 用户此刻眼前的是一条带 1/2/3/0 的提示，他回的就是那个数字。
     * 若让 `111` 之类的规则先跑，用户回一个 `1` 时插件会去找快速目录——
     * 而他的意思明明是"插入到那个正在跑的会话里"。
     */
    const busyChoice = await this.#handleBusyChoice(conversationId, peerId, text)
    if (busyChoice === true) return

    /*
     * ★ 本地扩展：`//x` 转义，以及 `111` 快速通道。
     *
     * 两者都在**路由之前**拦截，因为它们的语义都优先于插件自己的指令解析：
     *
     * - `//i` → 去掉一个斜杠得到 `/i`，**直接交给 agent**（DSH 认作 skill 手势）。
     *   不能只改文本再交回路由：路由见到 `/` 就走 `#command`，而它的 `default`
     *   分支会回一句「未知指令 /i」并吞掉消息——那正是要绕开的东西。
     * - `111 x` → 发到「快速对话」目录的最新会话，**不动当前绑定**。
     *   必须早于路由的浏览编号判定，否则刚看过 `/list` 时 `111` 会被当成编号。
     */
    const escaped = this.#unescapeSlashCommand(text)
    if (escaped !== undefined) {
      /*
       * ★ 转义出来的文本**仍然要过一遍触发词**。
       *
       * 真实故障：用户发「//i rrr 要等添加过滤条件…」，想同时开 ADHD 模式
       * 并把要求转给上一个跑完的会话。旧实现里 `//` 一转义就整条交给当前会话，
       * `rrr` 一次都没被检查——用户看到的是"没能识别三个 r"。
       *
       * 顺序是有意的：先认转义（那是明确的"我要发这个"），
       * 再从剥完的结果里认触发词。于是 `//i rrr x` 的语义是
       * "把 `/i rrr x` 当作指令处理" → 里面还有 `rrr` → 转给上一个会话。
       */
      const innerRrr = await this.#handleFinishedReply(conversationId, peerId, escaped)
      if (innerRrr === true) return
      const innerQuick = await this.#handleQuickChannel(conversationId, peerId, escaped)
      if (innerQuick === true) return

      // 没有触发词：转义出来的命令**跳过路由**，作为普通提示词交给当前绑定会话。
      await this.#deliverToBound(conversationId, accountId, peerId, escaped, attachmentLines)
      return
    }

    /*
     * `/111 x`：**字面发送**「111 x」给当前绑定会话（用户定义的转义写法）。
     *
     * 为什么必须在这里拦：`/111` 以单斜杠开头，会落进路由的 `#command`，
     * 而它的 `default` 分支回一句「未知指令 /111」并吞掉消息——
     * 于是"字面发送 111"这个约定根本执行不了。
     */
    const literal111 = this.#unescapeLiteral111(text)
    if (literal111 !== undefined) {
      await this.#deliverToBound(conversationId, accountId, peerId, literal111, attachmentLines)
      return
    }

    /*
     * `/rrr x`：**字面发送**「rrr x」给当前绑定会话（与 `/111` 同一种转义）。
     *
     * 同样必须抢在路由之前：`/rrr` 会落进 `#command` 的 `default`，
     * 被当成未知指令吞掉。
     */
    const literalRrr = this.#unescapeLiteralRrr(text)
    if (literalRrr !== undefined) {
      await this.#deliverToBound(conversationId, accountId, peerId, literalRrr, attachmentLines)
      return
    }

    /*
     * `rrr x`：回话给**最近跑完任务**的那个会话。
     *
     * 与 `111` 的区别：`111` 去固定的「快速对话目录」，`rrr` 去**刚推送过结果的那个会话**——
     * 用户看到一条"任务完成"的推送，想接着说一句，`rrr` 就是那个"接着说"。
     * 同样**不动当前绑定**。
     */
    const replyRrr = await this.#handleFinishedReply(conversationId, peerId, text)
    if (replyRrr === true) return

    const quick = await this.#handleQuickChannel(conversationId, peerId, text)
    if (quick === true) return

    // 交给路由：它要么直接回一句（指令），要么给出该交给哪个会话的提示词。
    // 与微信插件同构——`/new` `/list` `/switch` `/current` `/cancel` `/help` 都在路由里实现，
    // 本运行时只负责传输。
    const routed = await this.#router.route({
      conversationId,
      accountId,
      peerId,
      text,
      ...(quoted === undefined ? {} : { quoted }),
    })

    if (routed.kind === 'reply') {
      /*
       * 浏览位置只在这一屏**真的发出去**之后才前进。
       *
       * 与微信同一条：一个没送到的消息不该让位置往前挪，否则下一次「查看其余」会跳过一整屏——
       * 而用户从没见过那一屏。
       */
      if (await this.#send(conversationId, routed.text)) {
        await this.#router.delivered(conversationId, routed)
        /*
         * ★ 本地扩展：切换类指令成功后，把目标会话的**最后一次提问**补发一条。
         *
         * 切过去之后手机上是一片空白（历史在电脑上），用户不知道这个会话在干什么。
         * 贴出最后一次提问，等于给这条对话一个可见的开头。
         */
        await this.#sendLastPromptIfSwitched(conversationId, routed.text)
      }
      return
    }

    // 交给 agent 就意味着用户已经走开：这一次浏览到此为止（与微信同一条）。
    await this.#router.delivered(conversationId, routed)

    /*
     * ★ 对话被搬到新会话时，**先说这句话**。
     *
     * 路由会换掉一条会话已经归档、或磁盘上已经不存在的绑定；没有这句话，用户看到的
     * 就是"回答来自一条没有任何历史的对话，且完全没有解释"——而那次搬家只出现在日志里。
     * 所以它在提示词**之前**发，而且**即使下面的提交失败也已经发出去了**：
     * 它解释的是用户现在所处的那条对话的**身份**，与这一条消息送没送到无关。
     *
     * ⚠️ 与微信实现的差别（如实写明）：微信在 `bundle/src/host.ts` 里发送 notice 之前
     * 会先查一次账号、查不到就记一行"notice not sent"，因为它的发送入口需要账号对象。
     * 这里 `#send(conversationId, text)` 自己就带账号（按 appId 直取），没有那个前置条件，
     * 所以这里少一层；发送失败由 `#send` 自己记错（它不静默）。
     */
    if (routed.decision.notice !== undefined) {
      bootLog(
        `会话已换绑并回话：conversation=${conversationId} session=${routed.decision.sessionId}`,
      )
      await this.#send(conversationId, routed.decision.notice)
    }

    this.#startTyping(conversationId, peerId)

    /*
     * 渠道上下文说明（`presenceNote`）。
     *
     * 没有它，agent 会对着**手机**说「打开 C:\…」——那正是这条说明要防的失败。
     * 它告诉对方：你在和一个手机用户说话，他看不到这台电脑的屏幕和文件系统，
     * 要给他看东西就**直接发**，并且回复要短。
     *
     * **它和用户的话在同一条消息里**（说明排在最后），会话的第一条也一样。
     * 从前不是：命名那条被拆成两条，用"少一条消息"换一个不被污染的标题。
     * 现在标题在**创建会话时显式交给宿主**（`router.js` 的 `#bind` →
     * `sessionController.rename`，见本文件的 `#nameSession`），所以首条消息
     * 不必再为标题让路——而"两条先后独立的用户消息"正是用户报的那个 bug。
     * 形状与理由都在 `prompt.js` 的 `composeDelivery` 里。
     */
    const note = this.#settings.presenceNote.trim()

    // 引用排在最前，与 `prompt.js` 合成时的顺序一致（那里专门有断言钉着）。
    const promptText = [quoted === undefined ? '' : `[引用] ${quoted}`, routed.decision.prompt]
      .filter((part) => part !== '')
      .join('\n')

    const outbound = composeDelivery({ promptText, attachmentLines, note })

    /*
     * 目标会话正在跑任务时，先问用户怎么办（插入/排队/分叉/撤回）。
     *
     * 原来的做法是"先 steer、被拒再 queue"——默认用户想插话。
     * 但 steer 会打断正在跑的多步任务，让它偏离原计划，而这个代价不可逆。
     * 所以这里交给用户当场决定，而不是替他猜。
     *
     * ⚠️ 两种情况下**不问**：
     *
     * 1. `parkedAuto`：附件停靠窗口到期自动投递的，用户此刻没有在说话，
     *    弹"这句话要怎么处理"问的是一个不存在的东西。
     * 2. **只有附件、没有文字**：用户发来一张图，没有任何"这句话"。
     *    真实故障——用户发图后立刻看到四选一提示，而他能选的只有
     *    "把这张图插进去还是排队"，那不是他想回答的问题。
     *    这种情况直接排队，图会照常送达。
     */
    const hasUserText = promptText.trim() !== ''
    const shouldAsk = !parkedAuto && hasUserText
    if (shouldAsk && (await this.#isSessionRunning(routed.decision.sessionId))) {
      this.#stopTyping(conversationId)
      await this.#askBusyChoice(
        conversationId,
        routed.decision.sessionId,
        outbound.join('\n\n'),
        'bound',
      )
      return
    }

    let accepted = false
    for (const part of outbound) {
      // 被拒的 steer 是一个真实结果（它瞄准的那个回合可能刚好结束），所以退到队列再试，
      // 而不是把消息丢掉。
      if (await this.#submit(routed.decision.sessionId, part, 'steer')) accepted = true
      else if (await this.#submit(routed.decision.sessionId, part, 'queue')) accepted = true
    }

    if (!accepted) {
      this.#stopTyping(conversationId)
      /*
       * ★ 这条失败**必须留一行**（微信那批修复的第四条：提交失败没带会话 id）。
       *
       * 上面 `#submit` 记的是**每一次尝试**（steer 被拒 / queue 也失败），而"整条消息一个字都没交出去"
       * 是另一件事：它从前只把内容还给用户，日志里没有任何一行说明"哪条会话、哪条对话投递失败了"。
       * 用户看到的是一句重发提示，排查的人看到的是一片空白。
       */
      this.#recordError(
        `提交任务失败：插话与排队都未成功（conversation=${conversationId} session=${routed.decision.sessionId}）`,
      )
      // 消息是这里唯一不可重建的东西，绝不能丢。
      await this.#send(conversationId, `没能把消息交给会话，请重发一次。\n\n你的内容：\n${text}`)
      return
    }

    /*
     * 普通消息也要回一句「已发到」。
     *
     * ## 为什么普通消息需要它
     *
     * 用户的要求是"每次发消息都提示发到了哪个会话"，而普通消息恰恰是最容易
     * **发错地方**的一条路径：`/switch` 之后绑定变了、或某个会话被归档后自动换绑，
     * 用户下一句话就落进了另一条会话，而界面上看不出来。
     * 一句「已发到「xxx」」是唯一能当场发现这件事的东西。
     *
     * ## 什么时候不说
     *
     * **新建会话时不说**：那一刻 `routed.decision.created` 为真，标题还是宿主刚取的、
     * 常常就是这句话本身，回一句「已发到「这句话」」纯属噪音。
     * 换绑时的 `notice` 已经把去向说清楚了，也不必重复。
     */
    if (routed.decision.created !== true && routed.decision.notice === undefined) {
      await this.#confirmDelivered(conversationId, routed.decision.sessionId)
    }
  }

  /**
   * 停靠一批附件，等用户补一句指令（或等窗口到期）。
   *
   * `autoReplyAttachments` 关掉时**不设定时器**，于是一直等下去。批次本身仍然记着，
   * 所以之后任何一条文字消息都会把它一起带上——这才是"只在我说了话时才回答"，
   * 而不是"忽略附件"（微信的原话）。
   */
  async #park(conversationId, message, attachments) {
    const existing = this.#pending.get(conversationId)
    if (existing !== undefined) clearTimeout(existing.timer)

    const lines = [...(existing?.lines ?? [])]
    const dir = this.#mediaDir()
    for (const [index, attachment] of attachments.entries()) {
      const downloaded = await downloadAttachment({ attachment, dir, index })
      lines.push(
        downloaded === undefined ? describeMissing(attachment, index) : describeMedia(downloaded),
      )
    }

    const text = [existing?.text ?? '', this.#composePrompt({ ...message, attachments: [] })]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n')

    const timer = this.#settings.autoReplyAttachments
      ? setTimeout(() => {
          // 窗口关闭时仍没有指令，就把附件单独交出去。
          // `#deliverParked` 自己认领这批，先删掉会把附件丢掉并发出一轮空的。
          this.#fire('停靠窗口到期', () => this.#deliverParked(conversationId))
        }, this.#settings.mergeWindowMs)
      : undefined
    timer?.unref?.()

    this.#pending.set(conversationId, {
      lines,
      text,
      timer,
      accountId: this.#appId,
      peerId: message.senderId,
    })
    bootLog(
      `附件已停靠：conversation=${conversationId} 附件=${String(lines.length)} ` +
        `${timer === undefined ? '（自动回复已关，等指令）' : `窗口=${String(this.#settings.mergeWindowMs)}ms`}`,
    )
  }

  /** 认领停靠的批次：清掉定时器、删除、交回内容。 */
  #claimParked(conversationId) {
    const parked = this.#pending.get(conversationId)
    if (parked === undefined) return { lines: [], text: '' }
    clearTimeout(parked.timer)
    this.#pending.delete(conversationId)
    return { lines: parked.lines, text: parked.text }
  }

  /** 停靠窗口到期：把这一批单独投递出去。 */
  async #deliverParked(conversationId) {
    const parked = this.#pending.get(conversationId)
    if (parked === undefined) return
    const { lines, text } = this.#claimParked(conversationId)
    // 附件本身也算内容：即使没有说明文字也要投递，否则用户的图就石沉大海。
    await this.#deliverPrompt({
      conversationId,
      accountId: parked.accountId,
      peerId: parked.peerId,
      text,
      attachmentLines: lines,
      /*
       * ★ 这一批是**窗口到期自动投递**的，用户此刻并没有在说话。
       *
       * 所以目标会话正忙时**不要弹「这句话要怎么处理？」**——那个提示问的是
       * "你说的这句话怎么办"，而此时压根没有"这句话"（只有一张图）。
       * 用户看到提示会莫名其妙，而且 1/2/3/0 选完之后投递的仍是那张图，
       * 与他以为自己在回答的东西对不上。
       *
       * 正确行为：直接排队，安静地把图交出去。
       */
      parkedAuto: true,
    })
  }

  /** 丢弃全部停靠批次。卸载时调用，避免定时器活得比插件长。 */
  #clearParked() {
    for (const parked of this.#pending.values()) clearTimeout(parked.timer)
    this.#pending.clear()
  }

  /** 媒体目录，按需创建并缓存。 */
  #mediaDir() {
    if (this.#mediaDirPath === undefined) {
      // 用**工作区路径本身**，不是 home + 常量目录名：路径可自定义后，
      // 后者会把媒体落到别的地方去。
      this.#mediaDirPath = mediaDir(this.#workspace)
    }
    return this.#mediaDirPath
  }

  /**
   * 切换会话文件夹。
   *
   * **坏路径绝不能让它抛出去**：这里是在设置变更或启动读回时被调用的，
   * 一个抛出的异常会顺着 apply 上去把启动搞失败。所以校验不过就回落到
   * 默认位置并记下理由——用户看到的是"没生效"，而不是"应用起不来"。
   *
   * 切换时必须清掉两个缓存：
   * - `#workspaceId`：它记的是**旧目录**对应的工作区 id，不清会继续往旧工作区里塞会话
   * - `#mediaDirPath`：它派生自旧目录
   *
   * @param candidate - 用户填的路径（空串 = 默认）。
   * @returns 实际生效的路径。
   */
  #switchWorkspace(candidate) {
    const resolved = resolveWorkspaceDir(this.#home, candidate)
    const changed = !isSameWorkspace(resolved.path, this.#workspace)
    this.#workspace = resolved.path
    // 路由也有一份"本工作区是哪个"（`/list` 用它分组与计数），所以必须一起换。
    this.#router?.setOwnWorkspace(resolved.path)
    if (changed) {
      this.#workspaceId = undefined
      this.#mediaDirPath = undefined
    }
    if (resolved.fellBack) {
      bootLog(`会话文件夹回落默认：${String(resolved.reason)}（仍用 ${resolved.path}）`)
      this.#recordError(`会话文件夹路径不可用，已回落默认位置：${String(resolved.reason)}`)
    } else if (resolved.reason !== undefined) {
      /*
       * `fellBack: false` 却带着理由 = **默认位置自己不可用**（用户没填自定义路径）。
       * 这一条同样必须可见：返回的路径正是"要用的那个"，只是它建不出来/写不进去，
       * 拿出来会正好撞上会话 cwd 的 `ENOENT`。`resolveWorkspaceDir` 的契约是"永不抛"，
       * 所以理由只能由这里说出来。
       */
      bootLog(`会话文件夹不可用：${String(resolved.reason)}（仍用 ${resolved.path}）`)
      this.#recordError(`会话文件夹路径不可用：${String(resolved.reason)}`)
    } else if (changed) {
      bootLog(`会话文件夹已切换为 ${resolved.path}（只影响之后新建的对话）`)
    }
    return resolved.path
  }

  /**
   * 把入站消息拼成给 agent 的文本。
   *
   * 实现已抽到 `prompt.js`（纯函数、可测）。这里保留方法只是为了调用点读起来连续。
   * 合成的三件事与各自理由都在那个模块里。
   */
  #composePrompt(message) {
    return composePrompt(message)
  }

  /**
   * 让宿主采用（或创建）一条会话，并把它归到正确的工作区。
   *
   * ## 为什么要用 workspaceId 而不是 cwd
   *
   * 微信插件的原话：**"指名工作区而不是目录，才是把会话归进一个真正的文件夹的东西；
   * 工作区在底下提供同一个 cwd。"** 只给 `cwd` 会让会话落进「未分组」。
   *
   * ## 为什么要读"会话自己的工作区"
   *
   * 宿主钉死一条会话的 `cwd`，所以采纳一条属于别的项目的会话时，
   * 必须指名**那个项目**的工作区。到处都用本插件的工作区会静默地把用户限制在
   * "经本频道创建的会话"里，其它会话一选就失败。
   *
   * @param sessionId - 目标会话。
   * @param dirOverride - 可选：强制用这个目录作为 cwd（「快速对话」用）。
   *   省略时按原有逻辑：会话存储里的 cwd，否则本频道工作目录。
   */
  async #adoptSession(sessionId, dirOverride) {
    const stored =
      typeof dirOverride === 'string' && dirOverride !== ''
        ? dirOverride
        : await storedSessionWorkspace(this.#home, sessionId)
    const path = stored ?? this.#workspace
    const own = isSameWorkspace(path, this.#workspace)
    const workspaceId = await this.#workspaceIdFor(path, own ? WORKSPACE_TITLE : '')
    if (workspaceId === '') {
      // 没有工作区服务：退回钉死的 cwd，会话显示在「未分组」下。
      await this.#ctx.sessionController.create({ sessionId, cwd: path })
    } else {
      await this.#ctx.sessionController.create({ sessionId, workspaceId })
    }
    this.#applyPermissionPreset(sessionId)
  }

  /**
   * 把一个标题**显式**交给宿主。
   *
   * ## 为什么必须显式给
   *
   * 会话还没有标题时，DSH 会**从首条消息猜**一个
   * （`fallbackSessionTitle`，实现 `dsh-session-title/lib/types/normalize.js:66`，
   * 参数 5 词 / 40 字节见 `@deepseek-ai/dsh-base/cordis.patch.yml:58-59`），
   * 而那条消息是频道拼出来的：用户的话 + 附件描述 + 渠道说明。
   * 于是标题里混进渠道说明——这就是"标题被污染"。
   *
   * 从前绕开它的办法是把命名那条拆成两条消息（先用户的话、再说明），
   * 代价正是用户报的 bug：agent 收到两条**先后独立的用户消息**。
   * 标题在这里显式给出之后，首条消息就不必再为它让路。
   *
   * ## 为什么落在 `rename` 上
   *
   * `sessionController.create` 的请求里**没有标题字段**
   * （"requested identity, location, and Agent preset"，
   * `dsh-api-session-controller/lib/types/commands.js:107`），
   * 所以"创建时给标题"只能落在这里。而 `rename` 会把标题**钉住**：
   * 自动生成被取代、之后的消息也不再触发
   * （`dsh-session-title/lib/types/index.js:243-267`），
   * 那正是"标题不被首条消息污染"所需要的那条保证——**普通的重命名做不到这件事**。
   *
   * ## 顺序：必须 await 在提交提示词之前
   *
   * 宿主侧的首条消息一到就可能起自动命名，而这里做的正是抢在它前面把标题钉死。
   * 所以这条路**不走 `#fire`**（那会让两者去赛跑，结果取决于调度）。
   * 它整条都在 await 链上：`#handleInbound` → `#deliverPrompt` → `route` → `#bind`。
   *
   * ## 失败：记下来，但不丢消息
   *
   * 尽力而为。没有 `rename` 接口（旧宿主）或调用失败时只记一行，消息照发——
   * 最坏情况是标题退回"宿主自己从首条消息猜"，也就是修复前的行为。
   * 一个不理想的标题远不如丢掉用户的消息严重。
   *
   * @param sessionId - 刚创建的会话。
   * @param title - 要钉住的标题，调用方保证非空。
   */
  async #nameSession(sessionId, title) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.rename !== 'function') {
      bootLog(`会话标题未显式给出（此组合的会话控制器没有 rename 接口，将回落自动命名）：${title}`)
      return
    }
    try {
      await controller.rename({ sessionId, title })
      bootLog(`会话标题已给出：${title}`)
    } catch (error) {
      // 记下来而不是只吞掉：这一行是"为什么桌面上的标题是渠道说明"的唯一线索。
      this.#recordError(`会话标题未能给出（回落宿主自动命名）: ${describeError(error)}`)
    }
  }

  /**
   * 解析——或创建——拥有某目录的工作区。
   *
   * @param path - 工作区拥有的目录。
   * @param title - 仅当这是本频道自己的工作区时施加的标题。
   * @returns 工作区 id；组合里没有注册表时返回 `''`。
   */
  async #workspaceIdFor(path, title) {
    const registry = safeGet(this.#ctx, 'workspaceRegistry')
    if (registry === undefined || typeof registry.resolveByPath !== 'function') {
      // 没有工作区服务不算错误：会话照常收发，只是显示在「未分组」下。只记一次。
      if (isSameWorkspace(path, this.#workspace)) {
        recordOnce(this.#seen, '#noWorkspaceRegistry', '此组合没有工作区服务，会话将显示在「未分组」下')
      }
      return ''
    }
    // 本频道自己的工作区保留 id，且强制标题，让桌面端的文件夹读起来正确。
    // 别人的工作区原样保留它主人的命名。
    if (isSameWorkspace(path, this.#workspace) && this.#workspaceId !== undefined) {
      return this.#workspaceId
    }
    const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path))
    if (title !== '' && workspace.title !== title) await workspace.setTitle(title)
    if (isSameWorkspace(path, this.#workspace)) this.#workspaceId = workspace.id
    return workspace.id
  }

  /**
   * 给会话套上本频道选择的权限预设。
   *
   * **为什么必须有**：策略为 `ask` 的会话会把权限提示发到 QQ 然后等。在手机上那是死路——
   * 用户离开电脑正是为了不必守着提示，而一个卡在提示上的任务等于跑不了。
   * 所以默认给本频道的会话松掉这道闸。
   *
   * 两个决定成败的细节：
   * - **必须在会话第一个回合之前**：DSH 在回合开始后拒绝改预设（`agent-preset/locked`），
   *   所以它从 `#adoptSession` 调用，而那总是早于任何 prompt。
   * - **尽力而为**：服务可能不存在，失败也不能让用户丢消息——最坏情况是会话沿用 profile 的策略。
   *
   * @param sessionId - 刚创建或采纳的会话。
   */
  #applyPermissionPreset(sessionId) {
    const preset = this.#settings.permissionPreset
    if (preset === 'default') return
    try {
      const sessions = safeGet(this.#ctx, 'sessions')
      const presets = safeGet(this.#ctx, 'permissionPresets')
      const session = sessions?.get?.(sessionId)
      if (session === undefined || typeof presets?.set !== 'function') {
        bootLog(`权限预设 '${preset}' 未施加到 ${sessionId}：服务不可用`)
        return
      }
      presets.set(session, preset)
      bootLog(`权限预设 '${preset}' 已施加到 ${sessionId}`)
    } catch (error) {
      // 记录而非抛出：会话已跑过第一个回合是预期内的失败方式，
      // 为一个权限偏好丢掉用户的消息更糟。
      bootLog(`权限预设施加失败 ${sessionId}: ${describeError(error)}`)
    }
  }

  /**
   * 提交一次 prompt。
   *
   * `mode` 由调用方指定：默认 `'steer'`（插话，能打断正在跑的回合）。
   * 微信插件的理由同样成立：steer 被拒只意味着"晚一点回答"，而丢消息是不可修复的。
   *
   * @param sessionId - 目标会话。
   * @param prompt - 文本。
   * @param mode - `'steer'` 或 `'queue'`；省略时先 steer、被拒再 queue。
   */
  async #submit(sessionId, prompt, mode) {
    const content = [{ type: 'text', text: prompt }]
    const signal = new AbortController().signal
    if (mode !== undefined) {
      try {
        await this.#ctx.sessionController.prompt(
          { content, requestId: `qq-${randomUUID()}`, sessionId, mode },
          signal,
        )
        this.#noteSubmitted(sessionId, prompt, mode)
        return true
      } catch (error) {
        // 带上会话 id：微信那批修复的第四条就是"提交失败没带会话 id"，
        // 而没有它，这行日志说不出"哪条会话被拒了"——正是排查时最需要的那一个字段。
        bootLog(`${mode} 提交被拒: session=${sessionId} ${describeError(error)}`)
        return false
      }
    }
    try {
      await this.#ctx.sessionController.prompt(
        { content, requestId: `qq-${randomUUID()}`, sessionId, mode: 'steer' },
        signal,
      )
      this.#noteSubmitted(sessionId, prompt, 'steer')
      return true
    } catch (error) {
      bootLog(`steer 被拒，退回 queue: ${describeError(error)}`)
    }
    try {
      await this.#ctx.sessionController.prompt(
        { content, requestId: `qq-${randomUUID()}`, sessionId, mode: 'queue' },
        signal,
      )
      this.#noteSubmitted(sessionId, prompt, 'queue')
      return true
    } catch (error) {
      this.#recordError(`排队提交也失败: session=${sessionId} ${describeError(error)}`)
      return false
    }
  }

  /**
   * 记下"这个会话这一轮是什么时候开始的、问的是什么"，供 `/run` 展示。
   *
   * ## 只在**还没有记录**时写入
   *
   * 一个正在跑的回合里可能又被 steer 进来好几条消息。若每次都覆盖，
   * 计时会不断被重置，`/run` 显示的就成了"最后一条消息等了多久"——
   * 而用户问的是"这个任务跑了多久"。所以首次提交记时间，后续只更新提问内容。
   *
   * @param sessionId - 会话 id。
   * @param prompt - 提交的文本（用于展示"在跑什么"）。
   * @param mode - `'steer'` 或 `'queue'`。
   */
  #noteSubmitted(sessionId, prompt, mode) {
    const existing = this.#runningSince.get(sessionId)
    if (existing !== undefined) {
      /*
       * 已有记录：只更新提问内容。
       *
       * `queue` 意味着"等这一轮跑完再处理"，它**不是当前这一轮**的提问，
       * 所以不该覆盖显示内容——覆盖了会让 `/run` 显示一个还没开始的问题。
       */
      if (mode !== 'queue') existing.prompt = prompt
      return
    }
    this.#runningSince.set(sessionId, { startedAt: Date.now(), prompt })
  }

  // ---------------------------------------------------------------- 出站

  /**
   * 助手流的每一帧。
   *
   * 保持**同步**：两个帧交错会丢掉回复的前半段。
   */
  onAssistantFrame(payload) {
    const { sessionId, text, completed, toolCall, frameShape } = readStreamFrame(payload)
    /*
     * ★ 帧里没有会话 id = **这一帧的内容无处可投**。
     *
     * 只在它**确实带着要送的东西**（可见正文或"回合结束"）时才记：那种帧按定义就是该发给用户的
     * 东西，丢掉的是真回复。而没有正文的元数据帧（`usage` / `block` 边界 / `finish`…）本来就无事可做，
     * 记它们只会把有用的行淹掉——这一步的仪器曾经就是这么变成障碍的（见下面 `frameShape` 那条）。
     *
     * 这一条同时是**宿主改了事件词汇的警报**：若 `agent.session.id` 换了位置或改了名，
     * 每一帧都会走到这个 return（而不是走到下面 `frameShape` 那一条），现象是"机器人整个不再回复"
     * 而日志里一个字都没有。`recordOnce` 保证一个形态只记一次。
     */
    if (sessionId === undefined) {
      if ((text !== undefined && text !== '') || completed === true) {
        // 桶按**形态**分：宿主换字段名（`frameShape` 有值）与"这一帧本来就没有会话 id"
        // 是两件事；"带正文的帧"与"回合结束帧"也是两件事，各记一条才看得出是哪一种。
        const shape = frameShape ?? (completed === true ? 'end' : 'chunk')
        recordOnce(
          this.#seen,
          `#framesWithoutSession:${shape}`,
          `帧没有会话 id，其中 ${String(text?.length ?? 0)} 字正文无处投递（已丢弃` +
            `${completed === true ? '，且是回合结束帧' : ''}）`,
        )
      }
      return
    }

    /*
     * ★ 只留这一条，其余四条"帧形态观测"已删除。
     *
     * 删掉的是 `#chunkTypes` / `#toolShapes` / `#blockShapes` / `#toolNames`——
     * 第一步能力体检留下的仪器。宿主的事件词汇没有文档，只能把它们印出来学；
     * 事实已经学到并**记进 `docs/HOST-STREAM-SHAPES.md`**，那里比日志更该待。
     *
     * 删它们不是嫌占地方，而是**它们把有用的行淹没了**：排查"会话夹进不去"时，
     * 日志尾部的非 sdk 行全是那五条，而想找的"路由做了什么"一个字都没有。
     * **观测手段本身变成了观测的障碍。**
     *
     * 留下的这一条性质不同：它是**警报**，只在宿主发了本解析器不认识的帧时触发
     * （那三个在正常流量上每次都会触发）。如果将来 DSH 改了事件词汇，
     * 机器人会**静默地不再回复**，而这一行是唯一能让人当场看见"帧变了"的东西。
     */
    if (frameShape !== undefined) {
      recordOnce(this.#seen, `#frameShapes:${frameShape}`, `未知帧形态（宿主可能改了事件词汇）: ${frameShape}`)
    }

    /*
     * ★ 本地补丁：**工具调用帧必须放行**，这是旁白过滤能成立的前提。
     *
     * 原来这里是：
     *
     *     if ((text === undefined || text === '') && completed !== true) return
     *
     * 看起来无害——"没有正文、也不是结束帧，那就没事可做"。但 `block-start` 与
     * `tool-call-delta` 恰好**两样都不是**：它们没有 `text`，也不是 `end`。
     * 于是它们在到达下面的 `entry.sawTool = true` **之前**就被这一行挡掉了，
     * `sawTool` 永远是 `false`，所有"这一轮用过工具"的判断全部空转——
     * 表现就是过程旁白照旧一条条发到手机上。
     *
     * 现在多放行一种：**带 `toolCall` 的帧**。它不产生正文，只用来给这一轮做标记。
     * 其余（纯 reasoning/usage/block-end 等）照旧提前返回，不进聚合路径。
     */
    const hasToolCall = toolCall !== undefined
    if ((text === undefined || text === '') && completed !== true && !hasToolCall) return

    this.#fire('回复聚合', async () => {
      const state = await this.#store.read()
      const conversationId = Object.keys(state.bindings).find(
        (key) => state.bindings[key]?.sessionId === sessionId,
      )
      /*
       * ★ 助手流找不到绑定的对话 → **这一轮的回答整个丢在这里**（微信的"助手流找不到绑定会话"）。
       *
       * 它是**观察**而不是错误：用户自己在电脑上开的会话每答一轮都会经过这里，那些回答本来就不该
       * 发给手机。但它同样是"绑定没了"的样子，而那时答案是**真的丢了**——没有这一行，
       * 现象就是"模型明明答完了，手机上什么都没有"，任何地方都查不到。所以每条会话记一次
       * （`recordOnce`），既留下痕迹又不把日志刷爆。
       */
      if (conversationId === undefined) {
        /*
         * ★ 本地扩展：`notifyAllSessions` 打开时，未绑定会话的结果也送到 QQ。
         *
         * 判定顺序是有意的——**先判开关，再判旁白**：开关关着时完全走上游行为
         * （记一行、丢弃），一个字节都不多发，免得"关了却还在推"。
         *
         * 打开后的取舍：
         * - 只推**真正的收尾**（`completed` 且本轮没有工具调用），过程旁白一律不推。
         *   这与绑定会话用的是同一条判据，避免"开了开关就被旁白刷屏"。
         * - 用 `#boundConversation()` 解析目标：它已经处理了"多个绑定取最近使用"，
         *   且在没有绑定时返回 undefined（那就没地方可推，只能记日志）。
         * - 走 `#deliverOrQueue`：发不出去就排队，用户等的那条结果不该凭空消失。
         */
        if (this.#settings.notifyAllSessions === true) {
          await this.#forwardUnbound(sessionId, { text, completed, toolCall })
          return
        }
        recordOnce(
          this.#seen,
          `#unboundStreams:${sessionId}`,
          `助手流：没有 QQ 对话绑定到 ${sessionId}，这一轮的回答不会送达` +
            `（本帧 ${String(text?.length ?? 0)} 字）`,
        )
        return
      }

      const existing = this.#replies.get(sessionId)
      if (existing !== undefined) clearTimeout(existing.timer)
      const entry = existing ?? { text: '', conversationId, timer: undefined, sawTool: false, narrationLen: 0 }
      if (text !== undefined) entry.text += text

      /*
       * ★ 本地补丁（上游 1.0.3 没有这一条）。
       *
       * ## 问题
       *
       * DSH 的 `AssistantStreamAttempt` 是**按每个 model attempt** 创建的
       * （`dsh-agent-loop` 里 `++this.assistantAttemptCounter`），每个 attempt 结束都发一个
       * `frame.type === 'end'`。所以一个「拆成 7 次提交」的任务 = 7 个 attempt = 7 个 end 帧，
       * 而原本"见到 end 就立刻发"的逻辑会把它切成 7 条 QQ 消息，
       * 内容正是模型在工具调用之间的旁白（"第 1 次提交完成，继续第 2 次…"）。
       *
       * `settleMs` 对这条路径**无效**——它只管非 end 帧，end 帧是立即发送的。
       *
       * ## 判据
       *
       * **一个 attempt 里出现过工具调用 = 模型还在干活，不是任务完成。**
       * 那种 attempt 的正文是过程旁白，压住不发，并把它记为"旁白区"
       * （`narrationLen` 记住当前正文里属于旁白的长度）。
       * 直到出现一个**没有工具调用**的 attempt——那才是真正的收尾，
       * 此时只发这个收尾 attempt 自己的正文，旁白区整段丢弃。
       *
       * `sawTool` 必须在每个 end 帧后复位，否则第一个工具调用就会让它永久为 true。
       */
      if (toolCall !== undefined) entry.sawTool = true

      if (completed === true) {
        if (entry.sawTool === true) {
          // 这一轮用过工具：仍在干活。把已累积的正文标记为旁白，等真正的收尾。
          entry.narrationLen = entry.text.length
          entry.sawTool = false
          this.#replies.set(sessionId, entry)
          return
        }
        /*
         * 真正的收尾（这一轮没有工具调用）。
         *
         * 只发收尾 attempt 自己的正文（跳过旁白区）。若它一个字都没有
         * （模型直接以工具调用收尾的极端情况），退回发全部正文——
         * 宁可带上旁白，也不能让回答凭空消失。
         */
        const finalText = entry.text.slice(entry.narrationLen)
        this.#replies.set(sessionId, entry)
        this.#stopTyping(conversationId)
        await this.#flushReply(sessionId, finalText.trim() === '' ? undefined : finalText)
        /*
         * 绑定会话收尾时也记一笔。
         *
         * 不记的话会出现一种别扭的落差：用户在桌面端让一个会话跑完（收到了推送），
         * 然后又回到 QQ 绑定的这个会话问了一句，此时 `rrr` 指的还是上一个未绑定的会话——
         * 而用户心里"刚跑完的那个"已经换人了。
         */
        await this.#rememberFinished(sessionId)
        return
      }
      entry.timer = setTimeout(() => {
        this.#fire('静默窗口到期发送', () => this.#flushReply(sessionId))
      }, this.#settings.settleMs)
      entry.timer.unref?.()
      this.#replies.set(sessionId, entry)
    })
  }

  /**
   * `/111 x` → 字面 `111 x`（用户定义的转义写法）。
   *
   * ## 规则
   *
   * | 输入 | 结果 |
   * |---|---|
   * | `/111 你好` | `111 你好` 发给**当前绑定**会话 |
   * | `/111` | `111` |
   * | `/1111` | `undefined`（不是本函数的事） |
   * | `//111 你好` | `undefined`（`//` 已被 `#unescapeSlashCommand` 先吃掉） |
   *
   * ## 与 `111` 的关系
   *
   * `111 你好` = 发到**快速对话目录**的最新会话（不切绑定）；
   * `/111 你好` = 把字面量「111 你好」发给**当前**会话。
   * 两者互不干扰，`/111` 是"我要打这三个数字本身"的写法。
   *
   * @param text - 用户原文。
   * @returns 去掉前导斜杠的文本，或 `undefined`。
   */
  #unescapeLiteral111(text) {
    if (typeof text !== 'string') return undefined
    /*
     * 只要求"以 `/111` 开头"，**不再要求后面跟空格**：
     * 用户既然已经打了斜杠，意图就是"我要发字面的 111"，紧贴内容同样成立
     * （`/111190.254…` 与 `/111 190.254…` 等价）。
     */
    if (!/^\/111/.test(text)) return undefined
    const literal = text.slice(1)
    bootLog(`字面 111：${text.slice(0, 24)} -> ${literal.slice(0, 24)}`)
    return literal
  }

  /**
   * 某个会话**此刻是否正在跑任务**。
   *
   * ## 依据
   *
   * `sessionController.list()` 的每一项带 `running` 字段
   * （`dsh-api-session-controller` 的 `summaryFor`：`agents.get(id)?.status === 'running'`）。
   * 那是宿主自己维护的实时状态，比自己记账可靠。
   *
   * ## 拿不到时怎么办
   *
   * 服务不存在、或这条会话不在清单里（还没被创建过），一律当**不忙**。
   * 这个方向是有意的：误判"忙"会让每条消息都弹一次选择，把正常对话拖成审问；
   * 而误判"不忙"最多是退回原来的行为（steer 被拒后自动排队），没有损失。
   *
   * @param sessionId - 目标会话。
   * @returns 是否正在运行。
   */
  async #isSessionRunning(sessionId) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.list !== 'function') return false
    const rows = await this.#listSessionsSafe(controller)
    if (rows === undefined) return false
    const row = rows.find((item) => item?.sessionId === sessionId)
    return row?.running === true
  }

  /**
   * 调用宿主的 `sessionController.list()`，把**返回值形状**统一成一个数组。
   *
   * ## 为什么需要包一层
   *
   * 真实故障：`list` 的签名是 `list(_request, signal)`，**先要一个请求对象**，
   * 而原来只传了 signal，于是请求对象成了 signal、signal 成了 `undefined`。
   * 宿主没抛错，只是返回了**别的形状**——`/run` 于是回了一句
   * 「拿到的会话状态格式不对」，用户看到的就是一个不能用的功能。
   *
   * 除了参数顺序，返回形状也不止一种（`SessionListValue` 可能是数组，
   * 也可能是个带 `sessions` / `items` 的包装）。这里把三种常见形状都认下来，
   * 而不是赌其中一种。
   *
   * @param controller - 会话控制器。
   * @returns 会话行数组；调用失败或形状不认识时 `undefined`。
   */
  async #listSessionsSafe(controller) {
    let result
    try {
      // 先按宿主签名传请求对象；老组合（只要 signal）再试一次。
      result = await controller.list({}, new AbortController().signal)
    } catch (first) {
      try {
        result = await controller.list(new AbortController().signal)
      } catch (second) {
        bootLog(`查询会话清单失败: ${describeError(second)}`)
        return undefined
      }
    }
    if (Array.isArray(result)) return result
    if (Array.isArray(result?.sessions)) return result.sessions
    if (Array.isArray(result?.items)) return result.items
    bootLog(
      `会话清单形状不认识（可能宿主改了返回类型）: ${Object.keys(result ?? {}).join(',') || String(result)}`,
    )
    return undefined
  }

  /**
   * 从宿主的清单行里读出"这一轮提问"的时间戳，作为**开始时间**。
   *
   * ## 为什么需要它
   *
   * `#runningSince` 只记本插件自己提交的那些。桌面端直接开的会话没有记录，
   * `/run` 于是显示「开始时间未知」——而它明明在跑，只是"[我们不知道什么时候开始的]"。
   *
   * ## 取哪个字段
   *
   * 宿主每行带 `projections.values.sessionListMetadata.lastPromptAt`
   * （`SessionListMetadata.lastPromptAt`：折叠前缀里**最近一次人类提问的时间**）。
   * 那是这一轮的起点，正是"跑了多久"该从哪儿算。
   *
   * 取不到就 `undefined`，调用方按"未知"显示——**不拿 `updatedAt` 冒充开始时间**：
   * 后者是会话最后一次写入（工具调用也在写），会高估本轮的运行时长。
   *
   * @param row - `list()` 返回的一行（`SessionSummary`）。
   * @returns 时间戳（毫秒），或 `undefined`。
   */
  #promptAtFromRow(row) {
    const values = row?.projections?.values
    if (values === undefined || values === null) return undefined
    const at = values.sessionListMetadata?.lastPromptAt
    return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined
  }

  /**
   * 目标会话正忙时，**不直接投递**，而是问用户怎么办。
   *
   * ## 四个选项
   *
   * | 回复 | 行为 |
   * |---|---|
   * | `1` | 插入（steer）：打断当前回合，agent 立刻看到这句话 |
   * | `2` | 排队（queue）：等这一轮跑完再处理 |
   * | `3` | 分叉（fork）：在同工作区复制一个会话，消息发到那里，**并把 QQ 绑定切过去** |
   * | `0` | 撤回：这条消息不发了 |
   *
   * ## 为什么要问
   *
   * 原来的实现是"先 steer、被拒再 queue"——它默认用户想插话。
   * 但在手机上补一句话，用户常常只是想**排队**；而 steer 会打断正在跑的多步任务，
   * 让它偏离原计划。这个代价不可逆，所以交给用户当场决定。
   *
   * @param conversationId - 提问的对话。
   * @param sessionId - 目标会话。
   * @param text - 用户原话（存起来等回答）。
   * @param mode - 来源：`'bound'` / `'quick'` / `'rrr'`（决定 `3` 之后怎么切）。
   * @returns 永远 `true`（已处理，调用方不该继续投递）。
   */
  async #askBusyChoice(conversationId, sessionId, text, mode) {
    await this.#store.update((next) => {
      next.pendingBusy[conversationId] = { sessionId, text, mode, at: Date.now() }
    })
    await this.#send(
      conversationId,
      [
        '那个会话正在跑任务，这句话要怎么处理？',
        '',
        '1  插入：打断当前任务，立刻让它看到这句话',
        '2  排队：等这一轮跑完再处理',
        '3  分叉：在同工作区复制一个会话处理这句话，并把 QQ 切到新会话',
        '0  撤回：这条不发了',
        '',
        '直接回数字即可。',
      ].join('\n'),
    )
    bootLog(`忙时抉择：conversation=${conversationId} session=${sessionId} mode=${mode}`)
    return true
  }

  /**
   * 处理用户对"正忙"提示的回答。
   *
   * @param conversationId - 提问的对话。
   * @param peerId - 对端 id（typing 用）。
   * @param text - 用户原文。
   * @returns `true` 表示已处理（吞掉这条消息）。
   */
  async #handleBusyChoice(conversationId, peerId, text) {
    const state = await this.#store.read()
    const pending = state.pendingBusy[conversationId]
    if (pending === undefined) return false

    const raw = typeof text === 'string' ? text.trim() : ''
    // 只认单个数字。其它内容说明用户改主意了、想说别的——
    // 那就把提示作废，让这条消息走正常路径（不把他困在一个答不了的提示里）。
    if (!/^[0123]$/.test(raw)) {
      await this.#store.update((next) => {
        delete next.pendingBusy[conversationId]
      })
      return false
    }

    await this.#store.update((next) => {
      delete next.pendingBusy[conversationId]
    })

    const { sessionId, text: original, mode } = pending

    if (raw === '0') {
      await this.#send(conversationId, '已撤回，这条没有发出去。')
      bootLog(`忙时抉择：撤回 conversation=${conversationId}`)
      return true
    }

    if (raw === '2') {
      const ok = await this.#submit(sessionId, original, 'queue')
      if (ok) {
        await this.#send(conversationId, `已排队，等这一轮跑完就处理。\n${await this.#deliveredLine(sessionId)}`)
      } else {
        await this.#send(conversationId, '排队失败，请重发一次。')
      }
      bootLog(`忙时抉择：排队 conversation=${conversationId} ok=${String(ok)}`)
      return true
    }

    if (raw === '1') {
      const ok = await this.#submit(sessionId, original, 'steer')
      if (ok) {
        await this.#send(conversationId, `已插入，它会立刻看到这句话。\n${await this.#deliveredLine(sessionId)}`)
      } else {
        // steer 被拒（回合刚好结束）时退回排队——这是最接近用户意图的降级。
        const queued = await this.#submit(sessionId, original, 'queue')
        await this.#send(
          conversationId,
          queued
            ? `插入没成功（那一轮可能刚好结束），已改为排队。\n${await this.#deliveredLine(sessionId)}`
            : '插入和排队都失败了，请重发一次。',
        )
      }
      bootLog(`忙时抉择：插入 conversation=${conversationId} ok=${String(ok)}`)
      return true
    }

    // raw === '3'：分叉
    return await this.#forkAndSwitch(conversationId, peerId, sessionId, original, mode)
  }

  /**
   * 分叉一个会话，把这条消息发到新会话，并把 QQ 绑定切过去。
   *
   * ## 为什么用宿主的 `fork`
   *
   * `sessionController.fork` 会复制到**最近的已完成回合边界**，子会话继承源会话的
   * `cwd` 并挂到同一个工作区（`forkWorkspace(source.header)`）。这正是用户说的
   * "在同工作区通过这个会话分支出一个会话"——插件不该自己拼一份历史。
   *
   * ## 边界可能不存在
   *
   * 源会话如果**一个回合都没跑完过**，`fork` 会抛 `session/fork-unavailable`。
   * 那种情况下分叉没有意义（没有可继承的上下文），所以直接退回排队并说明。
   *
   * @param conversationId - 提问的对话。
   * @param peerId - 对端 id。
   * @param sessionId - 源会话。
   * @param text - 要发送的话。
   * @param mode - 来源。
   * @returns `true`（已处理）。
   */
  async #forkAndSwitch(conversationId, peerId, sessionId, text, mode) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.fork !== 'function') {
      const queued = await this.#submit(sessionId, text, 'queue')
      await this.#send(
        conversationId,
        queued
          ? '这个版本没有分叉功能，已改为排队。'
          : '没有分叉功能，排队也失败了，请重发一次。',
      )
      return true
    }

    let childId
    try {
      const result = await controller.fork({ sessionId })
      childId = typeof result?.sessionId === 'string' ? result.sessionId : undefined
      if (childId === undefined) throw new Error('fork 没有返回 sessionId')
    } catch (error) {
      /*
       * 分叉失败时**不丢消息**：退回排队。
       *
       * 最常见的原因是源会话没有已完成的回合（`session/fork-unavailable`），
       * 那时没有可继承的上下文，分叉本来也没有意义。
       */
      this.#recordError(`分叉失败，改为排队: ${describeError(error)}`)
      const queued = await this.#submit(sessionId, text, 'queue')
      await this.#send(
        conversationId,
        queued
          ? `分叉失败（${describeError(error)}），已改为排队。`
          : '分叉和排队都失败了，请重发一次。',
      )
      return true
    }

    /*
     * 采纳子会话——否则宿主不认识它、prompt 会被拒（与快速对话同一条理由）。
     * 然后提交那句话。
     */
    try {
      await this.#adoptSession(childId)
    } catch (error) {
      this.#recordError(`分叉出的会话采纳失败: ${describeError(error)}`)
    }
    const sent = await this.#submit(childId, text, 'queue')

    /*
     * 把 QQ 绑定切到新会话。
     *
     * 用户明确要求"qq 的当前会话也一起切过去"——分叉出来的会话就是为了接着聊，
     * 不切的话用户下一条消息还回到原来那个正在跑的会话，等于白分。
     */
    try {
      await this.#store.update((next) => {
        const existing = next.bindings[conversationId]
        next.bindings[conversationId] = {
          ...(existing ?? {}),
          conversationId,
          accountId: existing?.accountId ?? this.#appId,
          peerId: existing?.peerId ?? '',
          sessionId: childId,
          title: existing?.title ?? 'QQ',
          createdAt: existing?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
        }
      })
    } catch (error) {
      this.#recordError(`切换绑定到分叉会话失败: ${describeError(error)}`)
    }
    // 与 `/run` 同一条：直接写盘后要让路由重新读，否则 `/list` 仍报旧会话。
    this.#router?.invalidateBindings()

    await this.#send(
      conversationId,
      sent
        ? `已分叉出新会话并切过去。\n${await this.#deliveredLine(childId)}`
        : `已分叉出新会话并切过去，但这句话没发出去，请重发一次。\n${shortId(childId)}`,
    )
    bootLog(`忙时抉择：分叉 conversation=${conversationId} 源=${sessionId} 新=${childId} mode=${mode}`)
    return true
  }

  /**
   * `/rrr x` → 字面 `rrr x`（与 `/111` 同一种转义）。
   *
   * @param text - 用户原文。
   * @returns 去掉前导斜杠的文本，或 `undefined`。
   */
  #unescapeLiteralRrr(text) {
    if (typeof text !== 'string') return undefined
    // 与 `/111` 同一条：只要以 `/rrr` 开头就认，不要求后面跟空格。
    if (!/^\/rrr/.test(text)) return undefined
    const literal = text.slice(1)
    bootLog(`字面 rrr：${text.slice(0, 24)} -> ${literal.slice(0, 24)}`)
    return literal
  }

  /**
   * `rrr <内容>`：回话给**最近跑完任务**的那个会话。
   *
   * ## 为什么需要
   *
   * `notifyAllSessions` 打开后，任何会话跑完都会推一条结果到 QQ。
   * 用户看到那条推送，常常想**接着说一句**——「你真厉害」「再改一下这里」。
   * 但那条推送来自一个**没绑定**的会话，普通消息只会落到当前绑定的会话上。
   * `rrr` 就是那个"接着说"的入口。
   *
   * ## 目标从哪来
   *
   * `state.lastFinished`（见 `#rememberFinished`）。它持久化，所以中间重启过也还认得。
   * 目标**不切换绑定**——回完这一句，用户继续说话照旧回到原来的会话。
   *
   * ## 没有任何已完成会话时
   *
   * 回一句说明并**吞掉**这条消息（返回 `true`）。不降级成普通文本：
   * 用户明确打了 `rrr`，静默改成别的意思比报错更糟。
   *
   * @param conversationId - 提问的对话（回复发这里）。
   * @param peerId - 对端 id（typing 指示用）。
   * @param text - 用户原文。
   * @returns `true` 表示已处理。
   */
  async #handleFinishedReply(conversationId, peerId, text) {
    /*
     * 与 `111` 用同一套识别规则，但**额外允许句中独立成词**。
     *
     * 真实故障：用户发「//i rrr 要等添加过滤条件…」，想同时开 ADHD 模式并把要求
     * 转给上一个跑完的会话。`//` 转义先命中，整条被原样交给当前会话，
     * `rrr` 一次都没被检查——用户看到的是"没能识别三个 r"。
     *
     * `rrr` 是字母词，出现在句中（`/i rrr 要做什么`）几乎没有歧义；
     * 而 `111` 留在句中常常是内容本身（「第 111 行」），所以只有它不开这一条。
     */
    const body = extractTriggerWord(text, 'rrr', { allowMiddle: true })
    if (body === undefined) return false

    if (body === '') {
      await this.#send(conversationId, 'rrr 后面没写内容。用法：rrr 你的话')
      return true
    }

    const state = await this.#store.read()
    const target = state.lastFinished
    if (target === null || typeof target.sessionId !== 'string') {
      await this.#send(
        conversationId,
        '还没有任何会话跑完过任务，rrr 不知道该发给谁。\n' +
          '（这个功能需要先开启「任何会话结束都推送结果」，并等某个会话真的完成一次。）',
      )
      return true
    }

    /*
     * 会话可能已经被删掉或归档。先确认它还在宿主的清单里——
     * 直接 prompt 一条不存在的会话会抛，而用户看到的会是一句莫名其妙的错误。
     */
    let alive = true
    try {
      const all = await this.#gateway().listSessions()
      alive = all.some((row) => row.sessionId === target.sessionId)
    } catch {
      // 查不到就当它还活着：让下面那次提交给出真实答案，而不是这里猜。
      alive = true
    }
    if (!alive) {
      await this.#send(
        conversationId,
        `那个会话（${target.title === '' ? target.sessionId : target.title}）已经不在了，rrr 发不出去。`,
      )
      return true
    }

    /*
     * 那个会话正在跑任务时，先问用户怎么办。
     *
     * `rrr` 的典型场景恰恰是"它刚跑完、我想接着说"，所以不忙是常态；
     * 但用户也可能在它跑着的时候就想插一句——那时同样该由他决定是插入还是排队。
     */
    if (await this.#isSessionRunning(target.sessionId)) {
      await this.#askBusyChoice(conversationId, target.sessionId, body, 'rrr')
      return true
    }

    this.#startTyping(conversationId, peerId)
    try {
      // 采纳它，否则宿主不认识这条会话、prompt 会被拒（与快速对话同一条理由）。
      await this.#adoptSession(target.sessionId)
      const note = this.#settings.presenceNote.trim()
      const content = note === '' ? body : `${body}\n\n${note}`
      await this.#ctx.sessionController.prompt(
        {
          requestId: `qq-rrr-${randomUUID()}`,
          sessionId: target.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: content }],
        },
        new AbortController().signal,
      )
      bootLog(`rrr：回话给 ${target.sessionId}（${String(body.length)} 字，绑定未变）`)
      await this.#confirmDelivered(conversationId, target.sessionId)
    } catch (error) {
      this.#recordError(`rrr 提交失败: ${describeError(error)}`)
      await this.#send(conversationId, `rrr 发送失败：${describeError(error)}`)
    }
    return true
  }

  /**
   * 把一段文本直接交给**当前绑定的**会话，不经过路由。
   *
   * `//x` 转义专用：剥掉一层斜杠后的 `/i` 要原样送到 agent，
   * 而路由见到 `/` 就会走 `#command` 并把它当未知指令吞掉。
   *
   * 除了跳过路由，其余与普通消息完全一致：同样的 `presenceNote`、
   * 同样的 steer→queue 退让、同样的失败留痕与回吐。
   *
   * @param conversationId - 对话键（失败时回吐用）。
   * @param accountId - 账号 id（未使用，保留签名一致性）。
   * @param peerId - 对端 id（typing 指示用）。
   * @param text - 已剥掉转义斜杠的文本。
   * @param attachmentLines - 附件描述行。
   */
  async #deliverToBound(conversationId, accountId, peerId, text, attachmentLines) {
    const state = await this.#store.read()
    const binding = state.bindings[conversationId]
    if (binding === undefined) {
      await this.#send(
        conversationId,
        `这条对话还没有绑定会话，无法转发 ${text}。先随便说句话建一条，或发 /new。`,
      )
      return
    }

    /*
     * 目标会话正在跑任务时，先问用户怎么办（插入/排队/分叉/撤回）。
     *
     * 这里与普通消息共用同一套抉择：`//i` 这类命令插进一个正在跑的回合，
     * 效果同样是"打断它"，所以不该因为它是个命令就绕过这个问题。
     */
    if (await this.#isSessionRunning(binding.sessionId)) {
      await this.#askBusyChoice(conversationId, binding.sessionId, text, 'bound')
      return
    }

    await this.#adoptSession(binding.sessionId)
    this.#startTyping(conversationId, peerId)

    const note = this.#settings.presenceNote.trim()
    const outbound = composeDelivery({ promptText: text, attachmentLines, note })

    let accepted = false
    for (const part of outbound) {
      if (await this.#submit(binding.sessionId, part, 'steer')) accepted = true
      else if (await this.#submit(binding.sessionId, part, 'queue')) accepted = true
    }

    if (!accepted) {
      this.#stopTyping(conversationId)
      this.#recordError(
        `转义命令提交失败：插话与排队都未成功（conversation=${conversationId} session=${binding.sessionId}）`,
      )
      await this.#send(conversationId, `没能把 ${text} 交给会话，请重发一次。`)
      return
    }
    bootLog(`转义命令已交付：${text.slice(0, 40)} -> session=${binding.sessionId}`)
    await this.#confirmDelivered(conversationId, binding.sessionId)
  }

  /**
   * `//x` → `/x`：把 DSH 自己的斜杠命令送过插件的指令层。
   *
   * ## 为什么需要
   *
   * 路由是 `if (text.startsWith('/')) return await this.#command(...)`，
   * 而 `#command` 的 `default` 分支会**回一句「未知指令」并吞掉消息**。
   * 于是 `/i`（一个 DSH skill 手势）在 QQ 里永远到不了 agent——
   * 用户看到的是一张帮助清单，而不是 ADHD 模式开启。
   *
   * ## 规则
   *
   * | 输入 | 结果 |
   * |---|---|
   * | `//i` | `/i` 交给 agent |
   * | `//i-have-adhd` | `/i-have-adhd` |
   * | `///i` | `//i`（只剥一层，于是要发字面的 `//i` 仍有办法） |
   * | `/i` | `undefined`（不归本函数管，交给路由回「未知指令」） |
   *
   * @param text - 用户原文（已 trim）。
   * @returns 剥掉一层斜杠后的文本，或 `undefined` 表示"不归我管"。
   */
  #unescapeSlashCommand(text) {
    if (typeof text !== 'string' || !text.startsWith('//')) return undefined
    const stripped = text.slice(1)
    bootLog(`转义斜杠：${text.slice(0, 24)} -> ${stripped.slice(0, 24)}`)
    return stripped
  }

  /**
   * `111 <内容>`：把内容发到「快速对话」目录的最新会话，**不动当前绑定**。
   *
   * ## 为什么是"另发一条"而不是"切过去"
   *
   * 用户明确要求：`111` 只是**顺手问一句**，问完继续原来的对话。
   * 所以这里既不写 `bindings`，也不碰 `#lastInbound`——当前绑定的会话
   * 在用户下一条普通消息时照旧收到消息。
   *
   * ## 关闭与降级
   *
   * `quickWorkspacePath` 为空 = 不启用，返回 `false` 让调用方当普通文本处理
   * （用户明确要求："没设置就直接理解成 111"）。
   *
   * @param conversationId - 提问的对话（回复发这里）。
   * @param peerId - 对端 id（typing 指示用）。
   * @param text - 用户原文。
   * @returns `true` 表示已处理，`false` 表示"不归我管"。
   */
  async #handleQuickChannel(conversationId, peerId, text) {
    /*
     * 触发词的识别交给 `extractTriggerWord`：它同时认"开头紧贴"「111190.254…」、
     * "独立成词"「111 你好」与"结尾"「你好 111」，并挡掉纯数字（`1111`）。
     * 旧实现只认 `/^111(?:\s|$)/`，于是没空格的写法整条失效——用户实测报的那个问题。
     */
    const body = extractTriggerWord(text, '111')
    if (body === undefined) return false

    const candidate =
      typeof this.#settings.quickWorkspacePath === 'string'
        ? this.#settings.quickWorkspacePath.trim()
        : ''
    if (candidate === '') {
      // 未启用：原样当普通文本（用户要求）。记一行，免得"为什么 111 没反应"无处可查。
      recordOnce(
        this.#seen,
        '#quickDisabled',
        '收到 111 前缀，但「快速对话目录」未设置，已按普通文本处理',
      )
      return false
    }

    const resolved = resolveWorkspaceDir(this.#home, candidate)
    if (resolved.fellBack) {
      await this.#send(
        conversationId,
        `「快速对话目录」不可用，111 已按普通文本处理。\n原因：${String(resolved.reason ?? '未知')}`,
      )
      return false
    }

    if (body === '') {
      await this.#send(conversationId, '111 后面没写内容。用法：111 你的问题')
      return true
    }

    let sessionId
    try {
      sessionId = await this.#quickSession(resolved.path)
    } catch (error) {
      this.#recordError(`快速对话会话准备失败: ${describeError(error)}`)
      await this.#send(conversationId, `快速对话失败：${describeError(error)}`)
      return true
    }

    /*
     * 快速对话那个会话正在跑任务时，先问用户怎么办。
     *
     * 与其它入口共用同一套抉择：快速对话常被用来"顺手问一句"，
     * 而那个会话可能正在跑上一个问题——插进去会打断它。
     */
    if (await this.#isSessionRunning(sessionId)) {
      await this.#askBusyChoice(conversationId, sessionId, body, 'quick')
      return true
    }

    this.#startTyping(conversationId, peerId)
    try {
      const note = this.#settings.presenceNote
      const content = note === '' ? body : `${body}\n\n${note}`
      await this.#ctx.sessionController.prompt(
        {
          requestId: `qq-quick-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: content }],
        },
        new AbortController().signal,
      )
      bootLog(`快速对话：111 -> session=${sessionId}（${String(body.length)} 字，绑定未变）`)
      /*
       * 回一句「已发到」。
       *
       * 用户要求所有投递路径都给同样的确认（`rrr` 早就有了）。
       * 理由是一致的：`111` 发去的是**另一个**会话，而手机上看到的只有这条确认——
       * 没有它，用户无法分辨"发出去了"与"掉进了当前对话"。
       */
      await this.#confirmDelivered(conversationId, sessionId)
    } catch (error) {
      this.#recordError(`快速对话提交失败: ${describeError(error)}`)
      await this.#send(conversationId, `快速对话提交失败：${describeError(error)}`)
    }
    return true
  }

  /**
   * 回一句「已发到「会话名」。」——所有投递路径共用的确认。
   *
   * ## 为什么统一到一个方法
   *
   * 这个确认语的措辞被四个地方用到（`rrr`、`111`、`//x` 转义、普通消息），
   * 各写一份必然会漂移：一处叫「已发到」、一处叫「已发送」，用户读到的是不一致的系统。
   * 而且会话名的取法（标题 → 短 id）也要一致，否则同一条会话在两个入口下叫两个名字。
   *
   * ## 失败不吵
   *
   * 确认只是"顺带说一句"，发不出去不该盖掉真正的结果。
   * 但也不能静默——记一行，免得"为什么这次没有确认"无从查起。
   *
   * @param conversationId - QQ 对话。
   * @param sessionId - 消息实际投递到的会话。
   */
  async #confirmDelivered(conversationId, sessionId) {
    try {
      await this.#send(conversationId, await this.#deliveredLine(sessionId))
    } catch (error) {
      bootLog(`投递确认发送失败（不影响消息本身）: ${describeError(error)}`)
    }
  }

  /**
   * 「已发到「会话名」。」这一句本身。
   *
   * 拆出来是因为有些地方要把它**拼在别的回复后面**（忙时抉择的插入/排队确认），
   * 而那些地方不能为此多发一条消息——手机上两条紧挨着的气泡读起来像两次操作。
   *
   * @param sessionId - 消息实际投递到的会话。
   * @returns 一行确认语。
   */
  async #deliveredLine(sessionId) {
    return `已发到「${await this.#sessionLabel(sessionId)}」。`
  }

  /**
   * 取一条会话给人看的名字：标题优先，没有就用短 id。
   *
   * @param sessionId - 会话 id。
   * @returns 名字（不会是空串）。
   */
  async #sessionLabel(sessionId) {
    try {
      const all = await this.#gateway().listSessions()
      const row = all.find((item) => item.sessionId === sessionId)
      const title = typeof row?.title === 'string' ? row.title.trim() : ''
      if (title !== '') return title
    } catch {
      // 取不到标题不算错误：短 id 仍然能定位。
    }
    return shortId(sessionId)
  }

  /**
   * 取得「快速对话」目录下**最近使用**的会话；没有就建一条。
   *
   * 复用宿主的会话清单而不是自己记账：插件重启后仍然接得上同一条会话，
   * 而"最近使用"由宿主的排序决定，不需要插件再维护一份 lastUsedAt。
   *
   * @param dir - 快速对话目录（绝对路径，已确保存在）。
   * @returns 会话 id。
   */
  async #quickSession(dir) {
    const all = await this.#gateway().listSessions()
    const same = all.filter((row) => {
      const cwd = typeof row.cwd === 'string' ? row.cwd : ''
      return cwd !== '' && isSameWorkspace(cwd, dir)
    })

    if (same.length > 0) {
      // 宿主已按最近活动排序（与 `/list` 同一份清单），取第一条即可。
      const picked = same[0]
      await this.#adoptSession(picked.sessionId, dir)
      return picked.sessionId
    }

    const sessionId = mintSessionId()
    // 先采纳（把 cwd/工作区钉好），再给标题——与 `#bind` 同一条顺序。
    await this.#adoptSession(sessionId, dir)
    await this.#nameSession(sessionId, 'QQ 快速对话')
    bootLog(`快速对话：在 ${dir} 下新建会话 ${sessionId}`)
    return sessionId
  }

  /**
   * 如果刚才那条回复是"已切换"或"已新建"，把会话的最后一次提问补发一条。
   *
   * ## 为什么需要
   *
   * 切过去之后，用户在手机上看到的是一片空白（历史在电脑上）。他不知道这个会话
   * 在干什么、刚问过什么，于是第一条消息往往要花在"这是哪个"上。
   * 把最后一次提问贴出来，等于给这条对话一个可见的开头。
   *
   * ## 提问从哪来（三级读取）
   *
   * 1. 本插件自己记的（`#runningSince` 里的 `prompt`）——最准，是用户的原话；
   * 2. 磁盘索引的 `turnOutline.turns.at(-1).prompt`（通过 `readStoredSessionDetails`）——
   *    桌面端开的、之前运行完的会话，从这里能拿到真实提问；
   * 3. 全新会话（`/new` 或从无提问记录）——明确说明「（新会话，暂无提问）」。
   *
   * @param conversationId - QQ 对话。
   * @param replyText - 刚发出去的那条回复。
   */
  async #sendLastPromptIfSwitched(conversationId, replyText) {
    if (typeof replyText !== 'string') return
    if (!/^(已切换到|已新建对话)/.test(replyText)) return

    const state = await this.#store.read()
    const binding = state.bindings[conversationId]
    if (binding === undefined) return

    const sessionId = binding.sessionId
    let prompt = ''
    let timeStr = ''

    // 1. 如果正在由本插件实时追踪运行
    const tracked = this.#runningSince.get(sessionId)
    if (tracked !== undefined && typeof tracked.prompt === 'string' && tracked.prompt.trim() !== '') {
      prompt = tracked.prompt
      timeStr = `（已运行 ${formatDuration(Date.now() - tracked.startedAt)}）`
    }

    // 2. 如果没有实时追踪，或者没有提问文本，读磁盘索引详情
    if (prompt === '') {
      const details = await readStoredSessionDetails(this.#home, sessionId)
      if (details?.lastPrompt) {
        prompt = details.lastPrompt
      }
      if (details?.lastPromptAt) {
        const isRunning = await this.#isSessionRunning(sessionId)
        timeStr = isRunning
          ? `（已运行 ${formatDuration(Date.now() - details.lastPromptAt)}）`
          : `（提问于 ${relativeTime(details.lastPromptAt)}）`
      }
    }

    // 3. 处理 /new 或没有提问记录的新会话
    if (prompt === '') {
      if (/^已新建对话/.test(replyText)) {
        await this.#send(conversationId, '这个会话最后一次提问：\n（新会话，暂无提问）')
      }
      return
    }

    const maxChars = this.#settings.finishPromptChars > 0 ? this.#settings.finishPromptChars : 60
    const clipped = firstLine(prompt, maxChars) || prompt.slice(0, maxChars)
    await this.#send(
      conversationId,
      `这个会话最后一次提问${timeStr}：\n${clipped}`,
    )
  }

  /**
   * `/run`：列出**此刻正在跑、还没完成**的任务。
   *
   * ## 排序
   *
   * 跑得越久的排越前（开始时间早的在前）——用户打开这一屏是想知道"哪个卡最久了"，
   * 而不是"最近谁动过"。
   *
   * ## 每一条三行
   *
   * ```
   * 1. 项目名
   *    已运行 12 分 30 秒
   *    把这段代码重构成三个文件
   * ```
   *
   * ## 数据来源与它的诚实边界
   *
   * "是否在跑"来自宿主的 `sessionController.list()`（`running` 字段，实时状态）；
   * "跑了多久 / 在跑什么"来自 `#runningSince`（本插件在提交提示词时记的）。
   * 于是**插件启动之前就已经在跑的会话没有后两项**——那种情况显示"开始时间未知"，
   * 而不是拿 `updatedAt` 编一个看起来合理的数字。
   *
   * @returns 回话文本。
   */
  async #handleRunCommand(text, conversationId) {
    const raw = typeof text === 'string' ? text.trim() : ''
    const lower = raw.toLowerCase()
    // `/run` 与 `/run 3` 都归本指令；`/runs` 之类不归。
    const match = /^\/run(?:\s+(\S+))?$/.exec(lower)
    if (match === null) return undefined

    const controller = this.#ctx.sessionController
    if (typeof controller?.list !== 'function') {
      return '这个版本的宿主不提供会话状态，/run 用不了。'
    }

    const rows = await this.#listSessionsSafe(controller)
    if (rows === undefined) {
      return '/run 查不到会话状态（宿主返回的形状不认识），详情见设置页的诊断日志。'
    }

    const running = rows.filter((row) => row?.running === true)
    if (running.length === 0) return '现在没有正在跑的任务。'

    // 会话详情从磁盘清单里取：含标题、最近提问文本与时间戳。
    let detailsMap = new Map()
    try {
      const all = await this.#gateway().listSessions()
      detailsMap = new Map(all.map((row) => [row.sessionId, row]))
    } catch {
      // 取不到详情不影响列表：下面会退回用会话 id。
    }

    const items = running.map((row) => {
      const tracked = this.#runningSince.get(row.sessionId)
      const detail = detailsMap.get(row.sessionId)
      /*
       * 开始时间按可靠度排序：
       * 1. 本插件提交时记的（`#runningSince`）；
       * 2. 宿主行里的 `lastPromptAt`（`promptAtFromRow`）；
       * 3. 磁盘索引里的 `lastPromptAt`（`detail.lastPromptAt`）；
       * 4. 都没有才报"未知"——绝不拿 `updatedAt` 冒充。
       */
      const startedAt = tracked?.startedAt ?? this.#promptAtFromRow(row) ?? detail?.lastPromptAt
      const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : this.#workspace
      const prompt = tracked?.prompt || detail?.lastPrompt || detail?.title || ''
      return {
        sessionId: row.sessionId,
        workspace: workspaceName(cwd),
        elapsedMs: startedAt === undefined ? undefined : Date.now() - startedAt,
        prompt,
        title: detail?.title ?? '',
      }
    })

    /*
     * ★ 提问内容仍为空时，**逐条去磁盘补**。
     *
     * 真实故障：`/run 1` 切进去后显示「最后一次提问：（内容未知）」。
     * 原因是 `detailsMap` 由 `gateway().listSessions()` 建立，而它遍历的是
     * **会话目录**；某些会话（刚 fork 出来、或索引行被驱逐过）会出现在宿主的
     * `list()` 里却不在那份目录清单中，于是 `detail` 是 undefined。
     *
     * `readStoredSessionDetails` 直接按 sessionId 去投影缓存里取，不依赖目录遍历，
     * 所以能补上这一块。只在**真的缺**的时候读，不给清单路径增加成本。
     */
    for (const item of items) {
      if (item.prompt !== '') continue
      try {
        const details = await readStoredSessionDetails(this.#home, item.sessionId)
        if (details?.lastPrompt) item.prompt = details.lastPrompt
        if (item.title === '' && details?.title) item.title = details.title
      } catch {
        // 补不到就保持"内容未知"，不编造。
      }
    }

    /*
     * 排序：有开始时间的按时间**升序**（跑得久的在前）；
     * 没有开始时间的（插件启动前就在跑）排在最后。
     */
    items.sort((a, b) => {
      if (a.elapsedMs === undefined && b.elapsedMs === undefined) return 0
      if (a.elapsedMs === undefined) return 1
      if (b.elapsedMs === undefined) return -1
      return b.elapsedMs - a.elapsedMs
    })

    const arg = match[1]
    if (arg === undefined) return this.#renderRunList(items)

    /*
     * `/run <序号>`：切到那个会话。
     *
     * ## 越界一律落到最后一个
     *
     * 用户明确要求：`0`、以及任何超过数量的数字，都切到**末尾**那个（跑得最短的）。
     * 这条规则是为了"顺手打一个数"不会得到一句错误——手机上多打一位、少打一位是常态，
     * 而回一句"没有第 5 个"除了让人重打一次之外没有任何用处。
     */
    if (!/^\d+$/.test(arg)) {
      return `看不懂「${arg}」。用法：/run 看清单，/run 1 切到第 1 个。`
    }
    const requested = Number(arg)
    // 1 基编号：1 = 跑得最久的。0 与超界都落到最后一个。
    const index =
      requested >= 1 && requested <= items.length ? requested - 1 : items.length - 1
    const target = items[index]
    if (target === undefined) return this.#renderRunList(items)

    return await this.#switchToRunning(conversationId, target, index, items.length)
  }

  /**
   * 渲染 `/run` 的清单。
   *
   * @param items - 已排序的在跑任务。
   * @returns 回话文本。
   */
  #renderRunList(items) {
    const blocks = items.map((item, index) => {
      const elapsed =
        item.elapsedMs === undefined ? '开始时间未知' : `已运行 ${formatDuration(item.elapsedMs)}`
      const question = firstLine(item.prompt) || item.title || '（内容未知）'
      return [`${String(index + 1)}. ${item.workspace}`, elapsed, question].join('\n')
    })
    return (
      `正在跑的任务（${String(items.length)} 个）\n\n${blocks.join('\n\n')}\n\n` +
      '回 /run 序号 切过去。'
    )
  }

  /**
   * 把 QQ 对话切到某个正在跑的会话，并**把它的最后一次提问发出来**。
   *
   * ## 为什么要重发提问
   *
   * 切过去之后，用户在手机上看到的是一片空白（历史在电脑上）。他不知道这个会话
   * 在干什么、刚问过什么，于是第一条消息往往要花在"这是哪个"上。
   * 把最后一次提问贴出来，等于给这条对话一个可见的开头。
   *
   * ## 不改名
   *
   * 与 `/switch` 同一条：采纳一条已有会话不该动它的标题。
   *
   * @param conversationId - QQ 对话。
   * @param target - 目标会话（`items` 里的一项）。
   * @param index - 它在清单里的位置（0 基）。
   * @param total - 清单长度。
   * @returns 回话文本。
   */
  async #switchToRunning(conversationId, target, index, total) {
    try {
      await this.#adoptSession(target.sessionId)
    } catch (error) {
      this.#recordError(`/run 切换采纳失败: ${describeError(error)}`)
      return `/run 切换失败：${describeError(error)}`
    }

    const state = await this.#store.read()
    const previous = state.bindings[conversationId]
    try {
      await this.#store.update((next) => {
        next.bindings[conversationId] = {
          conversationId,
          accountId: previous?.accountId ?? this.#appId,
          peerId: previous?.peerId ?? '',
          sessionId: target.sessionId,
          // 三级回退，与 `router.js` 的 `#switchTo` 一致：目标标题 → 原标题 → 前缀。
          title: target.title || previous?.title || TITLE_PREFIX,
          createdAt: previous?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
        }
      })
    } catch (error) {
      this.#recordError(`/run 切换绑定失败: ${describeError(error)}`)
      return `/run 切换失败：${describeError(error)}`
    }

    /*
     * ★ 让路由丢掉绑定缓存。
     *
     * 不调这一步，`/list` 与 `/current` 会继续报**原来那个会话**——
     * 它们读的是路由的缓存，而这里直接写了盘。用户看到"切了但没切"。
     */
    this.#router?.invalidateBindings()

    bootLog(
      `/run: 切到第 ${String(index + 1)}/${String(total)} 个在跑会话 ${target.sessionId}`,
    )

    const elapsed =
      target.elapsedMs === undefined ? '开始时间未知' : `已运行 ${formatDuration(target.elapsedMs)}`
    const question = firstLine(target.prompt) || target.title || '（内容未知）'
    return [
      `已切到第 ${String(index + 1)}/${String(total)} 个：${target.workspace}`,
      elapsed,
      '',
      '最后一次提问：',
      question,
    ].join('\n')
  }

  /**
   * `/notify` 指令：查看或切换「任何会话结束都推送到 QQ」。
   *
   * 支持的写法（手机键盘掉空格是常态，所以分隔符可选）：
   *
   * | 输入 | 行为 |
   * |---|---|
   * | `/notify` | 报告当前状态 |
   * | `/notify on` / `/notify 开` / `/notify 1` | 打开 |
   * | `/notify off` / `/notify 关` / `/notify 0` | 关闭 |
   *
   * 返回 `undefined` 表示"这不是本指令"，调用方继续走路由。
   * 返回字符串表示"这是本指令，回这句话"。
   *
   * @param text - 用户原文。
   * @returns 回话文本，或 `undefined`。
   */
  async #handleNotifyCommand(text) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    const lower = trimmed.toLowerCase()
    if (!lower.startsWith('/notify')) return undefined
    const rest = trimmed.slice('/notify'.length)

    /*
     * 解析参数，两种情况：
     * - 带分隔符：`/notify on`、`/notify:on`、`/notify：开`（冒号接受中英文）
     * - 无分隔符：`/notifyon`、`/notify开`——手机键盘掉空格是常态，
     *   与 `/switch1` 同一种考虑。
     *
     * ⚠️ 无分隔符时必须**整体**是一个已知词，否则 `/notifications` 会被
     * 吃成 `on` 加 `ifications`，用户想打的别的指令就没了。所以粘连部分
     * 不在词表里时，这里交回路由（返回 undefined），而不是报错。
     */
    let arg
    if (rest === '') {
      arg = ''
    } else if (/^[\s:：]/.test(rest)) {
      arg = rest.replace(/^[\s:：]+/, '').trim().toLowerCase()
    } else {
      const glued = rest.trim().toLowerCase()
      if (!ON_WORDS.has(glued) && !OFF_WORDS.has(glued)) return undefined
      arg = glued
    }

    const stateLine = (on) =>
      on
        ? '「任何会话结束都推送」现在是**开**的：你在电脑上开的任何会话跑完，结果都会发到这个 QQ。'
        : '「任何会话结束都推送」现在是**关**的：只有切进去的会话（/switch）或任务自己调 notify_qq 才会发到这里。'

    if (arg === '') {
      const on = this.#settings.notifyAllSessions === true
      return `${stateLine(on)}\n\n切换：/notify on  或  /notify off`
    }

    const isOn = ON_WORDS.has(arg)
    const isOff = OFF_WORDS.has(arg)
    if (!isOn && !isOff) {
      return `看不懂「${arg}」。用 /notify on 或 /notify off。`
    }

    this.applySettings({ notifyAllSessions: isOn })
    bootLog(`/notify: notifyAllSessions -> ${String(isOn)}`)
    return `${stateLine(isOn)}\n\n已保存，重启后仍然有效。`
  }

  /**
   * 把**未绑定会话**的收尾结果转发到 QQ（`notifyAllSessions` 打开时）。
   *
   * ## 为什么要单独一个缓冲表
   *
   * `#replies` 的条目带 `conversationId`，而这里在收尾之前根本不知道要发给谁
   * （目标由 `#boundConversation()` 在收尾那一刻解析）。更重要的是：
   * 绑定会话与未绑定会话可能**同时**在跑，用同一张表会让两边的旁白区互相污染。
   * 所以另开 `#unboundReplies`，键仍然是 sessionId。
   *
   * ## 判据与绑定会话完全一致
   *
   * 出现过工具调用的 attempt 是过程旁白，压住不发并记进旁白区；
   * 只有"没有工具调用"的 attempt 才是真收尾，此时只发它自己的正文。
   * 否则打开这个开关就等于把用户淹在进度刷屏里——那正是它最该避免的结果。
   *
   * @param sessionId - 会话 id。
   * @param frame.text - 本帧正文。
   * @param frame.completed - 是否 end 帧。
   * @param frame.toolCall - 本帧的工具调用（有则证明还在干活）。
   */
  async #forwardUnbound(sessionId, { text, completed, toolCall }) {
    const existing = this.#unboundReplies.get(sessionId)
    const entry = existing ?? { text: '', sawTool: false, narrationLen: 0, pushed: false }
    if (text !== undefined) entry.text += text
    if (toolCall !== undefined) entry.sawTool = true

    if (completed !== true) {
      this.#unboundReplies.set(sessionId, entry)
      return
    }

    if (entry.sawTool === true) {
      // 还在干活：把已累积的正文划为旁白区，等真正的收尾。
      entry.narrationLen = entry.text.length
      entry.sawTool = false
      this.#unboundReplies.set(sessionId, entry)
      return
    }

    /*
     * 真收尾。先清缓冲——下面任何一条 return 都不该让这段正文留在表里，
     * 否则下一次该会话的收尾会把它重复带上。
     */
    this.#unboundReplies.delete(sessionId)

    const finalText = entry.text.slice(entry.narrationLen).trim()
    /*
     * 没有收尾正文就不推。
     *
     * 这是刻意的：模型有时以纯工具调用收尾（比如刚发完一个文件），
     * 此时正文是空的，硬推只会是一条空白消息。绑定会话那边退回"发全部正文"，
     * 是因为那里用户在等回答；而这里是**额外**转发，没有正文就该安静。
     */
    if (finalText === '') return

    const conversationId = await this.#boundConversation()
    if (conversationId === undefined) {
      recordOnce(
        this.#seen,
        `#unboundNoTarget:${sessionId}`,
        `未绑定会话 ${sessionId} 有结果要转发，但当前没有任何 QQ 对话绑定，无法投递`,
      )
      return
    }

    /*
     * 与 `notify_qq` 的跨会话开关一致：关掉 `allowCrossSessionNotify` 时，
     * 未绑定会话的自动转发也一并停掉——那是同一个安全姿态，不该留一个后门。
     */
    if (!this.#settings.allowCrossSessionNotify) {
      recordOnce(
        this.#seen,
        `#unboundCrossNotifyOff:${sessionId}`,
        `未绑定会话 ${sessionId} 有结果要转发，但「允许其他会话推送到 QQ」是关闭的，已跳过`,
      )
      return
    }

    try {
      /*
       * 推送内容 = 提问 + 分隔线 + 结果。
       *
       * 1. 提问支持桌面端会话兜底：若 #runningSince 没记录（桌面端会话），
       *    退回读磁盘投影详情（`readStoredSessionDetails`）。
       * 2. 结果支持 Markdown 处理（降级文件 / 转纯文本）：
       *    若 markdownMode 为 plain（默认），转为纯文本发消息，
       *    避免手机 QQ 出现大量 raw markdown（###、**、- 等）。
       *    超长（超过 maxReplyChars）或 markdownMode 为 file 时自动转为 .md 附件。
       */
      const question = await this.#finishedQuestion(sessionId)

      const plan = planReply(finalText, this.#settings.maxReplyChars)
      if (plan.kind === 'file') {
        const caption =
          question === '' ? plan.caption : `${question}\n${FINISH_SEPARATOR}\n${plan.caption}`
        await this.#deliverOrQueue(conversationId, { text: caption })
        await this.#sendMarkdownFile(conversationId, plan.text)
      } else {
        const rendered = this.#renderForQq(plan.text)
        if (rendered === undefined) {
          // markdownMode === 'file' 且含 markdown
          const caption =
            question === ''
              ? '回复含格式，已作为 .md 文件发送。'
              : `${question}\n${FINISH_SEPARATOR}\n回复含格式，已作为 .md 文件发送。`
          await this.#deliverOrQueue(conversationId, { text: caption })
          await this.#sendMarkdownFile(conversationId, plan.text)
        } else {
          const body =
            question === '' ? rendered : `${question}\n${FINISH_SEPARATOR}\n${rendered}`
          await this.#deliverOrQueue(conversationId, { text: body })
        }
      }

      /*
       * 记下"刚跑完的是谁"，供 `rrr` 回话。
       *
       * 位置在**投递成功之后**：推送没送到的话，用户根本看不到那条消息，
       * 也就不会想到去 `rrr`；此时把目标改掉只会让下一次 `rrr` 打偏。
       */
      await this.#rememberFinished(sessionId)
      bootLog(
        `notifyAllSessions: 未绑定会话 ${sessionId} 的结果已转发（${String(finalText.length)} 字）`,
      )
    } catch (error) {
      this.#recordError(`未绑定会话结果转发失败: ${describeError(error)}`)
    }
  }

  /**
   * 取出某个会话**这一轮**的提问，压成推送里那一行。
   *
   * 来源是 `#runningSince`（本插件在提交提示词时记的用户原话）。
   * 桌面端开的会话拿不到时，退回读磁盘索引（`readStoredSessionDetails`）。
   * 都拿不到就返回空串——调用方据此只发结果，不编占位符。
   *
   * @param sessionId - 刚收尾的会话。
   * @returns 一行提问，可能为空串。
   */
  async #finishedQuestion(sessionId) {
    const tracked = this.#runningSince.get(sessionId)
    let prompt = tracked?.prompt
    if (!prompt) {
      try {
        const details = await readStoredSessionDetails(this.#home, sessionId)
        prompt = details?.lastPrompt || details?.title
      } catch {}
    }
    if (!prompt) return ''
    return clipQuestion(prompt, this.#settings.finishPromptChars)
  }

  /**
   * 记住"刚跑完任务"的会话，供 `rrr` 回话。
   *
   * 标题尽力取：取不到就留空串——`rrr` 的确认语用得到它，但**不是**它决定发给谁。
   *
   * @param sessionId - 刚收尾的会话。
   */
  async #rememberFinished(sessionId) {
    /*
     * 这一轮结束了，`/run` 不该再把它算进"正在跑"。
     *
     * 清在这里而不是别处，是因为它同时覆盖两条收尾路径：绑定会话的 `#flushReply`
     * 与未绑定会话的 `#forwardUnbound`。两处都调用本方法。
     */
    this.#runningSince.delete(sessionId)

    let title = ''
    try {
      const all = await this.#gateway().listSessions()
      const row = all.find((item) => item.sessionId === sessionId)
      if (row !== undefined && typeof row.title === 'string') title = row.title
    } catch {
      // 取标题失败不影响 `rrr`：目标由 sessionId 决定。
    }
    try {
      await this.#store.update((next) => {
        next.lastFinished = { sessionId, title, at: Date.now() }
      })
    } catch (error) {
      this.#recordError(`记录最近完成的会话失败: ${describeError(error)}`)
    }
  }

  /**
   * 发出并清空某会话缓冲的回复。
   *
   * @param sessionId - 会话 id。
   * @param overrideText - 可选：只发这段文本（本地补丁用来跳过旁白区）。
   *   省略时发整个缓冲区。
   */
  async #flushReply(sessionId, overrideText) {
    const entry = this.#replies.get(sessionId)
    // 没有缓冲（别处已经发过 / 定时器与回合结束撞在一起）**不是丢东西**：
    // 下面那个 `text === ''` 同理——两处都无事可做，所以刻意不记日志。
    if (entry === undefined) return
    /*
     * ★ 本地补丁：静默窗口到期时，若这一轮用过工具，**不要发**。
     *
     * 定时器本来是给"非 end 帧"准备的：模型输出一段话后停顿一下就发出去。
     * 但在 agentic 循环里那段话往往是"现在读一下某个文件"这类过程旁白，
     * 而工具调用证明任务还没完。所以这里与 end 帧用同一条判据。
     *
     * 注意 `overrideText` 有值时不走这条——那是 end 帧显式要求发送的收尾正文。
     */
    if (entry.sawTool === true && overrideText === undefined) return
    this.#replies.delete(sessionId)
    const text = (overrideText ?? entry.text).trim()
    if (text === '') return
    await this.#sendReply(entry.conversationId, text)
  }

  /**
   * 发送一条**回复**，超长时降级为文件。
   *
   * 移植自微信的 `maxReplyChars`。不降级的话，一条上万字的回复会被
   * `TEXT_CHUNK_LIMIT` 切成好几条消息刷屏——手机上要连划好几屏，
   * 而且中间那几条读起来是断的。
   *
   * 微信的原话同样适用：先给一句 caption，**免得文件变成一个没有说明的附件**。
   * 文件写进媒体目录，所以用户在电脑上也能找到它。
   *
   * @param conversationId - 对话键。
   * @param text - 已 trim 的回复正文。
   */
  async #sendReply(conversationId, text) {
    const plan = planReply(text, this.#settings.maxReplyChars)
    if (plan.kind === 'send') {
      const rendered = this.#renderForQq(plan.text)
      if (rendered === undefined) {
        // `markdownMode === 'file'` 且这条含 Markdown：改成发附件。
        await this.#send(conversationId, '回复含格式，已作为 .md 文件发送。')
        await this.#sendMarkdownFile(conversationId, plan.text)
        return
      }
      await this.#send(conversationId, rendered)
      return
    }
    /*
     * 长回复走文件：**保留原始 Markdown**，不做纯文本转换。
     *
     * 这正是"转成 .md 文件"的意义——手机上点开能看到渲染后的排版，
     * 而纯文本转换会把表格和层级压平。用户选 `file` 模式时走的也是这条路。
     */
    await this.#send(conversationId, plan.caption)
    await this.#sendMarkdownFile(conversationId, plan.text)
  }

  /**
   * 按 `markdownMode` 决定一条**短回复**怎么发。
   *
   * | 模式 | 行为 |
   * |---|---|
   * | `plain` | 转纯文本（默认）。QQ 不渲染 Markdown，原样发出去是一堆井号 |
   * | `raw` | 原样返回（上游行为） |
   * | `file` | 有 Markdown 就返回 `undefined`，调用方改为发 `.md` 文件 |
   *
   * @param text - 回复正文。
   * @returns 要发送的文本；`undefined` 表示"这条应该走文件"。
   */
  #renderForQq(text) {
    const mode = this.#settings.markdownMode
    if (mode === 'raw') return text
    if (mode === 'file') {
      // 没有 Markdown 就别发附件：纯文本消息比一个附件好用得多。
      return hasMarkdown(text) ? undefined : text
    }
    // plain：只在真的含标记时转换，避免在无关内容上产生意外改动。
    return hasMarkdown(text) ? markdownToPlain(text) : text
  }

  /**
   * 把一段 Markdown 写成 `.md` 文件发给用户。
   *
   * 写不进去或发不出去时**退回纯文本消息**，而不是让这条回复消失。
   *
   * @param conversationId - 对话键。
   * @param markdown - 原始 Markdown。
   */
  async #sendMarkdownFile(conversationId, markdown) {
    const name = longReplyFileName()
    const path = join(this.#mediaDir(), name)
    try {
      writeFileSync(path, markdown, 'utf8')
    } catch (error) {
      this.#recordError(`Markdown 写文件失败，改为纯文本: ${describeError(error)}`)
      await this.#send(conversationId, markdownToPlain(markdown))
      return
    }
    try {
      await this.#sendFile(conversationId, path)
      bootLog(`Markdown ${String(markdown.length)} 字 -> ${name}`)
    } catch (error) {
      this.#recordError(`Markdown 发送文件失败，改为纯文本: ${describeError(error)}`)
      await this.#send(conversationId, markdownToPlain(markdown))
    }
  }

  /**
   * 把还缓冲着的回复全部发出（关闭时用）。
   *
   * 逐条 catch：这个方法在插件卸载时被调用，而卸载路径抛出的 rejection 同样是**致命**的。
   * 关闭阶段发不出去只该记一笔，不该带走整个应用。
   */
  async flushReplies() {
    for (const sessionId of [...this.#replies.keys()]) {
      const entry = this.#replies.get(sessionId)
      if (entry !== undefined) clearTimeout(entry.timer)
      try {
        await this.#flushReply(sessionId)
      } catch (error) {
        this.#recordError(`关闭时发送失败: ${describeError(error)}`)
      }
    }
  }

  /**
   * 发一段文本到 QQ。
   *
   * **被动优先，主动兜底**：能带 `msgId` 就带（走被动回复路径），
   * 窗口过期或超过 4 次时由 `ReplyLimiter` 判定降级为主动推送。
   * 超长文本按 `TEXT_CHUNK_LIMIT` 分块，每块一次 `sendText`。
   *
   * @param conversationId - 对话键。
   * @param text - 要发送的文本。
   * @returns **是否真的发出去了**。
   *
   * ⚠️ 这个返回值不是装饰：待发队列靠它判断该不该入队。
   * 以前它什么都不返回、失败只记一行错误，于是"发失败"与"发成功"对调用方**不可区分**——
   * 队列永远不会触发（这一条是审查时发现的）。
   *
   * 仍然**不抛**：绝大多数调用点是"发一条通知"，让它们各自去处理异常会把这个方法
   * 变成一个随时可能炸的东西。需要抛的场合（`send_to_qq`）自己看返回值。
   */
  async #send(conversationId, text) {
    const bot = this.#bot
    if (bot === undefined) {
      this.#recordError('未连接 QQ，消息丢弃')
      return false
    }
    const resolved = this.#targetFor(conversationId)
    if (resolved === undefined) {
      this.#recordError('找不到对话的 peerId')
      return false
    }
    const { target, peerId, passive } = resolved

    try {
      for (const chunk of chunkText(text, TEXT_CHUNK_LIMIT)) await bot.sendText(target, chunk)
      return true
    } catch (error) {
      // 被动失败时退到主动再试一次：被拒的可能是窗口而不是内容。
      if (passive) {
        try {
          for (const chunk of chunkText(text, TEXT_CHUNK_LIMIT)) {
            await bot.sendText({ scope: 'c2c', targetId: peerId }, chunk)
          }
          bootLog('被动发送失败，主动推送成功')
          return true
        } catch (secondError) {
          this.#recordError(`主动推送也失败: ${describeError(secondError)}`)
        }
      }
      this.#recordError(`发送失败: ${describeError(error)}`)
      return false
    }
  }

  /**
   * 算出某对话这次该用的发送目标。
   *
   * **被动优先，主动兜底**：能带 `msgId` 就带（走被动回复路径），
   * 窗口过期或超过 4 次时由 `ReplyLimiter` 判定降级为主动推送。
   * 实测两者都可用（第一步 9/9 通过）。
   *
   * @param conversationId - 对话键。
   * @returns `{ target, peerId, passive }`，找不到 peerId 时 `undefined`。
   */
  #targetFor(conversationId) {
    const inbound = this.#lastInbound.get(conversationId)
    const peerId = inbound?.peerId ?? conversationId.split(':')[1]
    if (peerId === undefined || peerId === '') return undefined

    let msgId
    if (inbound?.msgId !== undefined) {
      const limit = this.#limiter.checkLimit(inbound.msgId)
      if (limit.allowed) {
        msgId = inbound.msgId
        this.#limiter.record(inbound.msgId)
      } else {
        bootLog(`被动回复不可用（${limit.fallbackReason ?? 'unknown'}），转主动推送`)
      }
    }
    return {
      peerId,
      passive: msgId !== undefined,
      target: msgId === undefined ? { scope: 'c2c', targetId: peerId } : { scope: 'c2c', targetId: peerId, msgId },
    }
  }

  /**
   * 主动推送到某个对话，供 `notify_qq` 工具使用。
   *
   * @param conversationId - 对话键。
   * @param text - 文本。
   */
  async push(conversationId, text) {
    await this.#send(conversationId, text)
  }

  // ---------------------------------------------------------------- typing

  #startTyping(conversationId, peerId) {
    if (this.#typing.has(conversationId)) return
    /*
     * 记下开始时刻，好在超过 `TYPING_MAX_MS` 之后**停止刷新**（微信的 `TYPING_MAX_MS`）。
     *
     * 没有这个上限的话，一个卡住的回合（等审批、等一个永不返回的工具）会让
     * `setInterval` 一直跑下去，用户看到的是**永远在输入**——
     * 那既是一个资源泄漏，也是一句谎话：它让"还在想"和"已经死了"看起来一样。
     */
    const startedAt = Date.now()
    const tick = () => {
      if (Date.now() - startedAt > TYPING_MAX_MS) {
        bootLog(`typing: 已超过 ${String(Math.round(TYPING_MAX_MS / 60_000))} 分钟上限，停止刷新`)
        this.#stopTyping(conversationId)
        return
      }
      // 定时器回调里同步抛出 = 宿主眼中的**致命错误**（释放整个应用）。
      // 所以这里不能直接调用，必须经 #fire。
      this.#fire('typing', () => {
        const bot = this.#bot
        if (bot === undefined) return undefined
        return bot.sendTyping({ scope: 'c2c', targetId: peerId }, TYPING_DURATION_SEC)
      })
    }
    tick()
    const timer = setInterval(tick, TYPING_REFRESH_MS)
    timer.unref?.()
    this.#typing.set(conversationId, timer)
  }

  #stopTyping(conversationId) {
    const timer = this.#typing.get(conversationId)
    if (timer === undefined) return
    clearInterval(timer)
    this.#typing.delete(conversationId)
  }

  #stopTypingAll() {
    for (const conversationId of [...this.#typing.keys()]) this.#stopTyping(conversationId)
  }

  // ------------------------------------------------------- 审批与提问回流

  /**
   * 尝试把一条入站消息当作某个挂起交互的回答。
   *
   * **必须在投递链最前面调用**，否则用户回的「1」会被当成新请求发给 agent，
   * 而那条提示永远悬在那里。
   *
   * @param conversationId - 对话键。
   * @param text - 用户消息。
   * @returns 是否消费了这条消息。
   */
  async #settleInteraction(conversationId, text) {
    const pending = this.#interactions.get(conversationId)
    if (pending === undefined) return false
    const value = pending.accept(text)
    if (value === undefined) {
      // 这不是对当前提示的回答。**重发提示而不是吞掉文本**——
      // 一条聊别的事情的消息既不该丢失，也不该被误当成糟糕的回答。
      pending.reprompt()
      return false
    }
    this.#interactions.delete(conversationId)
    bootLog(`交互已解决：${pending.kind}`)
    pending.settle(value)
    return true
  }

  /**
   * 在 QQ 上问用户一个问题并等回答。
   *
   * `peerId` 由调用方传入而不是从绑定里查：会话控制工具跑在一个可能还没有绑定的会话里
   * （它可能被要求创建第一个绑定），在这里强行查找恰好会在这个功能最需要的时候失败。
   *
   * @param conversationId - 要提问的对话。
   * @param peerId - 提问的接收者。
   * @param body - 提示文本。
   * @param kind - 交互种类，用于日志。
   * @param parse - 读回答；不是回答时返回 `undefined`。
   * @param signal - 宿主撤回请求时中止。
   * @returns 解析出的回答；请求先被撤回时 `undefined`。
   */
  async #ask(conversationId, peerId, body, kind, parse, signal) {
    const settled = Promise.withResolvers()
    // 同一对话里后来的提示替换先前的。
    const previous = this.#interactions.get(conversationId)
    if (previous !== undefined) {
      this.#interactions.delete(conversationId)
      previous.settle(undefined)
    }
    this.#interactions.set(conversationId, {
      kind,
      accept: parse,
      settle: settled.resolve,
      reprompt: () => {
        this.#fire('重发交互提示', () => this.#send(conversationId, `请回复上一条提示。\n\n${body}`))
      },
    })
    const onAbort = () => {
      this.#interactions.delete(conversationId)
      settled.resolve(undefined)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      await this.#send(conversationId, body)
      bootLog(`交互已发出：${kind} -> ${peerId}`)
      return await settled.promise
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      // 只清理自己的那一条：更新的提示可能已经把它替换掉了。
      const current = this.#interactions.get(conversationId)
      if (current?.settle === settled.resolve) this.#interactions.delete(conversationId)
    }
  }

  /**
   * 一个会话可以为哪个对话代言。
   *
   * **只认"当前"绑定它的那个对话。**
   *
   * 微信插件的记录值得照抄：它曾经还接受"这个会话曾经服务过的任何对话"
   * （通过一张 `sessionOwners` 表），结果对话换走之后旧会话永久保有发言权，
   * 开发会话里的提问跑到了用户的手机上。**"曾经"不等于"现在"。**
   *
   * @param sessionId - 会话 id。
   * @returns 对话键，没有则 `undefined`。
   */
  async #conversationForSession(sessionId) {
    if (sessionId === undefined) return undefined
    const state = await this.#store.read()
    return Object.keys(state.bindings).find((key) => state.bindings[key]?.sessionId === sessionId)
  }

  /** 某对话的绑定与 peerId；未绑定时 `undefined`。 */
  async #askTarget(conversationId) {
    const state = await this.#store.read()
    const binding = state.bindings[conversationId]
    if (binding === undefined) return undefined
    return { peerId: binding.peerId }
  }

  /**
   * 为绑定到 QQ 的对话**认领**权限提示。
   *
   * 未绑定的对话一律委托出去，桌面面板照旧应答。
   *
   * @returns 给 `ctx.on('approval/request', ...)` 的监听器。
   */
  approvalListener() {
    return async (request, next) => {
      const record = request ?? {}
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForSession(sessionId)
      // 两种情况都记：一个从未被调用的应答者，和一个主动弃权的应答者，从手机上看是一样的
      // （提示都留在了桌面端），所以要写下来让下一次诊断找得到。
      bootLog(
        `审批事件：tool=${String(record.toolName)} session=${sessionId ?? '(none)'} ` +
          `${conversationId === undefined ? '非本频道会话 -> 委托' : '认领'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#askTarget(conversationId)
      if (target === undefined) return await next()
      const answer = await this.#ask(
        conversationId,
        target.peerId,
        presentApproval(record).body,
        'approval',
        parseApprovalReply,
        record.signal,
      )
      // 被撤回或无法回答：交还回去而不是猜。在权限提示上猜等于授予用户从未同意的东西。
      if (answer === undefined) return await next()
      return answer
    }
  }

  /**
   * 为绑定到 QQ 的对话**认领**结构化提问。
   *
   * @returns 给 `ctx.on('user-questions/request', ...)` 的监听器。
   */
  questionListener() {
    return async (request, next) => {
      const record = request ?? {}
      const questions = record.questions
      if (!Array.isArray(questions) || questions.length === 0) return await next()
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForSession(sessionId)
      bootLog(
        `提问事件：count=${String(questions.length)} session=${sessionId ?? '(none)'} ` +
          `${conversationId === undefined ? '非本频道会话 -> 委托' : '认领'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#askTarget(conversationId)
      if (target === undefined) return await next()
      const answer = await this.#ask(
        conversationId,
        target.peerId,
        presentQuestions(questions).body,
        'question',
        (reply) => parseQuestionReply(questions, reply),
        record.signal,
      )
      if (answer === undefined) return await next()
      return answer
    }
  }

  // ------------------------------------------------- 自然语言会话控制（工具）

  /**
   * 注册本插件的工具。
   *
   * 注册是 effect：返回的清理函数必须挂到 `ctx.effect`，否则插件卸载后会留下
   * 指向已拆除运行时的处理器。
   *
   * @returns 清理函数。
   */
  registerTools() {
    const tools = safeGet(this.#ctx, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      this.#recordError('此组合没有工具服务，agent 无法主动操作会话或发送文件')
      return () => {}
    }
    const disposers = []
    try {
      disposers.push(
        tools.register(
          sessionToolDefinition({
            requireConfirmation: this.#settings.requireConfirmation,
            control: (action, target, level, exec) =>
              this.controlSession(sessionIdOf(exec?.agent), action, target, level),
            log: (line) => bootLog(line),
          }),
        ),
      )
    } catch (error) {
      // 工具注册失败通常意味着 schema 不被接受——那正是启动审计会拒绝的一类事故，必须记下来。
      this.#recordError(`注册 ${TOOL_NAME} 失败: ${describeError(error)}`)
    }
    try {
      disposers.push(
        tools.register(
          sendToQqToolDefinition({
            deliver: (args, exec) => this.sendFromTool(args, exec),
            log: (line) => bootLog(line),
          }),
        ),
      )
    } catch (error) {
      this.#recordError(`注册 send_to_qq 失败: ${describeError(error)}`)
    }
    try {
      disposers.push(
        tools.register(
          notifyQqToolDefinition({
            deliver: (args, exec) => this.notifyFromTool(args, exec),
            log: (line) => bootLog(line),
          }),
        ),
      )
    } catch (error) {
      this.#recordError(`注册 notify_qq 失败: ${describeError(error)}`)
    }
    const disposer = () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          bootLog(`注销工具失败: ${describeError(error)}`)
        }
      }
    }
    // 自己留一份：设置变更后要重新注册，那时需要先注销旧的。
    this.#toolDisposer = disposer
    return disposer
  }

  /** 注销当前已注册的全部工具（若已注销则不做事）。 */
  disposeTools() {
    const dispose = this.#toolDisposer
    this.#toolDisposer = undefined
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (error) {
      bootLog(`注销工具失败: ${describeError(error)}`)
    }
  }

  /**
   * 执行一次会话操作。
   *
   * 核心手法：**把动作翻译回 `/` 指令，喂给同一个 `SessionRouter`**——
   * 一份实现，两个入口（打字的与说话的），所以两者不可能给出不同的结果。
   *
   * @param callerSessionId - 调用工具的 agent 所在的会话。
   * @param action - `list` / `switch` / `new` / `current` / `cancel` / `model`。
   * @param target - 目标（编号、标题、模型名、或 `all`）。
   * @param level - 推理等级（只对 `model` 有意义）。有目标时与模型一起切，
   *   没目标时只改当前模型的等级——两种写法都是 `/model` 自己的语法（见 `router.js` 的
   *   `parseModelCommand`），这里只负责拼出用户会打的那句话。
   * @returns `{ ok, detail, sessions, otherWorkspaces, otherNames }`
   */
  async controlSession(callerSessionId, action, target, level) {
    const empty = { sessions: [], otherWorkspaces: 0, otherNames: [] }
    const conversationId = await this.#conversationForSession(callerSessionId)
    if (conversationId === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何 QQ 对话，无法操作。', ...empty }
    }
    const binding = (await this.#store.read()).bindings[conversationId]
    if (binding === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何 QQ 对话，无法操作。', ...empty }
    }

    /*
     * 每个动作都翻译成**用户会打的那句指令**，`list all` 与 `等级` 也是。
     *
     * 这是"一份实现、两个入口"的落点：`等级` 是 `router.js` 解析的词，
     * 在这里另发明一种拼法就是对同一个请求给出第二个答案。
     */
    const withTarget = target !== undefined && target !== ''
    const withLevel = level !== undefined && level !== ''
    const named = withLevel ? ` 等级 ${String(level).trim()}` : ''
    const text =
      action === 'switch'
        ? `/switch ${target ?? ''}`
        : action === 'new' && withTarget
          ? `/new ${target}`
          : action === 'list' && target === 'all'
            ? '/list all'
            : action === 'model' && withTarget
              ? `/model ${String(target).trim()}${named}`
              : action === 'model' && withLevel
                ? `/model 等级 ${String(level).trim()}`
                : `/${action}`
    const result = await this.#router.route({
      conversationId,
      accountId: binding.accountId,
      peerId: binding.peerId,
      text,
      // 说话要来的清单与打字要来的清单用**不同的话**说"其余的在哪"：
      // 说话的人从没打过 `/list all`，叫他去打一句指令不是个说明。
      ...(action === 'list' ? { heldHint: '说「看全部对话」就能一起看，也可以直接切过去。' } : {}),
    })
    if (result.kind !== 'reply') {
      return { ok: false, detail: `不支持的操作：${action}`, ...empty }
    }

    const includeAll = target === 'all'
    /*
     * agent 拿到的是**用户刚收到的那一屏**（`result.numbered`），不是另算一份清单。
     *
     * 这正是微信把"编号"从 host 交回给工具的原因：一个自己重新编号的表会让 agent
     * 复述出与用户屏幕上不同的数字，而那个数字是用户要回给我们的东西。
     * 模型操作**完全不带会话表**：那张表是给"切对话"用的，
     * 把它附在模型结果后面，agent 会拿到一份与刚才那件事无关的清单。
     */
    const sessionsAndHeld =
      action === 'list'
        ? await this.#listReport(conversationId, result.numbered, includeAll)
        : { sessions: [], otherWorkspaces: 0, otherNames: [] }
    const { sessions, otherWorkspaces, otherNames } = sessionsAndHeld

    // 切到未知目标是"用引导回答"而不是抛错，所以必须**读文本**而不是假定成功——
    // 否则 agent 会报告一个从未发生的移动。
    // `没有成功` 是模型（与等级）切换失败时的措辞（见 router 的 `/model`），
    // `有多个` 是"id 太短，请用更长的那个"——那句同样**没有**切换成功，
    // 漏掉它就会对用户报一句"已切换"（微信插件在这里漏过一次）。
    const failed = /找不到|未知指令|没有成功|不支持|有多个/.test(result.text)

    if (action === 'switch' || action === 'new') {
      if (failed) {
        await this.#notify(conversationId, switchFailure(action, target, result.text))
      } else {
        const after = (await this.#store.read()).bindings[conversationId]
        await this.#notify(conversationId, switchConfirmation(action, after?.title ?? ''))
      }
      // 一次切换结束这次浏览：用户读过的那份清单已经用完了，
      // 之后一句「查看其余」不该接着它往下翻。
      await this.#router.delivered(conversationId, result)
    }

    if (action === 'model') {
      /*
       * 模型这件事**由频道自己说**，与切换对话同一条理由：
       * 清单如果交给 agent 转述，用户拿到的就是一份自创格式、编号对不上的清单
       * （`session-tool.js` 文件头记着这个失败）。成功与失败都发，失败尤其要发——
       * 那是唯一一种"聊天里什么都没变、用户无从分辨"的结果。
       */
      await this.#notify(conversationId, result.text)
      await this.#router.delivered(conversationId, result)
    }

    if (failed) {
      return {
        ok: false,
        // 写成"已完成"，因为它确实完成了：用户已被直接告知，复述只会与他们刚读到的相矛盾。
        detail: `操作失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`,
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    if (action === 'model') {
      return {
        ok: true,
        // 与 `list` 同一个理由：结果已经发给用户了，再给 agent 一份只会被复述一遍。
        // 三种结果分开说，因为说得更准的 agent 更不会多嘴。
        detail: withLevel
          ? withTarget
            ? '模型与推理等级已切换，已直接告诉用户。不要重复。'
            : '推理等级已切换，已直接告诉用户。不要重复。'
          : withTarget
            ? '模型切换结果已直接发给用户。不要重复说明切换结果。'
            : '模型清单已直接发给用户。不要重复这份清单。',
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    if (failed) {
      return {
        ok: false,
        // 写成"已完成"，因为它确实完成了：用户已被直接告知，复述只会与他们刚读到的相矛盾。
        detail: `切换失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`,
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    if (action === 'list' || action === 'current') {
      /*
       * 清单**由频道自己发**，而且发的就是路由刚才渲染的那份字节。
       *
       * 这里曾经拿会话表另渲染一份给用户，那正是微信记下的那个失败：
       * 消息与编号各说各的（"看第 3 个"指到第 3 个以外的东西）。
       * 现在两者只有一份来源：`result.text` 发给用户，`result.numbered` 给 agent 复述编号。
       */
      const sent = await this.#notify(conversationId, result.text)
      if (sent) await this.#router.delivered(conversationId, result)
      /*
       * 告诉 agent 发生了什么，而**不是**把列表给它：复述会让每个请求翻倍，
       * 而转述正是产生"用户无法据此操作的列表"的原因。`/current` 不同——
       * 它那句话本身就是有用的正文，所以原样交给 agent。
       */
      return {
        ok: true,
        detail:
          action === 'list' ? '列表已直接发给用户。不要重复这份列表。' : result.text,
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    return { ok: true, detail: result.text, sessions, otherWorkspaces, otherNames }
  }

  /**
   * 按本频道自己的名义发一条消息给某对话。
   *
   * 用在"无论 agent 选择说什么，用户都必须被告知"的场合。
   * 失败只记录不抛出：**漏掉一条确认不该让它正在确认的那个动作失败**。
   *
   * @returns **是否真的发出去了**；调用方据此决定要不要推进浏览位置
   *   （一个没送到的消息不该让下一次「查看其余」跳过一整屏）。
   */
  async #notify(conversationId, text) {
    try {
      return await this.#send(conversationId, text)
    } catch (error) {
      this.#recordError(`频道通知发送失败: ${describeError(error)}`)
      return false
    }
  }

  /**
   * 把路由刚印出的那一屏编号，翻译成 agent 要的那张表（以及"其余的在哪个会话夹"）。
   *
   * **编号取自路由，不是重新数一遍**：用户看到的是 11–20 那第二屏，
   * 而 agent 复述的"第 14 个"必须就是那一行。这也顺手修掉了原来那条分叉：
   * 工具与用户各拿一份自己编好的表，于是"看第 3 个"可能指到第 3 个以外的东西。
   *
   * 标题与时间取**活**的那一份（编号里只有 id 与标题），因为它们是给人认的；
   * 编号与顺序则完全按那一屏。整台机器的清单只读一次，两个用途共用它——
   * 这条路上的每一次读取都是一遍会话目录树。
   *
   * @param conversationId - 用作"当前"标记的对话。
   * @param numbered - 路由印出的那一屏编号；没有（会话夹那一层）时表是空的。
   * @param includeAll - 这次要的就是全部（会话夹那一层）：那就没有"别处的会话"可报。
   * @returns `{ sessions, otherWorkspaces, otherNames }`。
   */
  async #listReport(conversationId, numbered, includeAll) {
    const all = await this.#gateway().listSessions()
    const own = await this.#gateway().listOwnSessions()
    const currentId = (await this.#store.read()).bindings[conversationId]?.sessionId
    const byId = new Map(all.map((session) => [session.sessionId, session]))

    const sessions = (numbered?.sessions ?? []).map((row, offset) => {
      const live = byId.get(row.sessionId)
      return {
        // 印在行旁边的那个数字，不是它在这个数组里的位置：第二屏从 11 起。
        index: numbered.first + offset,
        sessionId: row.sessionId,
        title: (live?.title ?? row.title ?? '').trim() || '(无标题)',
        updatedAt: live?.updatedAt,
        current: row.sessionId === currentId,
      }
    })

    // 其余的口径与路由渲染那一句"另有 N 个对话在其它会话夹"完全相同（都按工作区分），
    // 这样 agent 口中的数目与用户读到的那个不会互相矛盾。
    const ownIds = new Set(own.map((session) => session.sessionId))
    const held = includeAll ? [] : all.filter((session) => !ownIds.has(session.sessionId))
    const names = new Set()
    for (const session of held) {
      // 用末段路径，因为那是用户从桌面端认得出的东西。点名而不是只报数量，
      // 于是"还有哪些列表"不需要再问一次。
      if (typeof session.workspace === 'string' && session.workspace !== '') {
        names.add(workspaceLabel(session.workspace))
      }
    }
    return { sessions, otherWorkspaces: held.length, otherNames: [...names].sort() }
  }

  // ------------------------------------------------- 出站文件与主动推送（工具）

  /**
   * `send_to_qq` 的实现：发给**调用者所属会话所绑定的**那个对话。
   *
   * 只对绑定的对话生效，所以真正干活的会话通常报不了自己的结果——那正是 `notify_qq` 存在的理由。
   *
   * @param args.path - 本机绝对路径。
   * @param args.caption - 可选的先行文本。
   * @param exec - 工具执行上下文（取 `exec.agent` 定位调用者）。
   * @returns 一句人话结果。
   */
  async sendFromTool(args, exec) {
    const path = String(args?.path ?? '').trim()
    if (path === '') throw new Error('path 不能为空。')
    const conversationId = await this.#conversationForSession(sessionIdOf(exec?.agent))
    if (conversationId === undefined) {
      throw new Error('这个会话没有绑定任何 QQ 对话，无法发送。请让用户在 QQ 里先发一条消息。')
    }
    return await this.#deliverTo(conversationId, {
      text: typeof args?.caption === 'string' ? args.caption : undefined,
      path,
    })
  }

  /**
   * `notify_qq` 的实现：发给**当前绑定的**那个对话，而不是调用者的。
   *
   * 目标从存储里解析，所以任何会话都能送到用户此刻手上的手机。
   * **不接受目标参数**，于是 agent 没有东西可以瞄错。
   *
   * @param args.text - 要发送的文本。
   * @param args.path - 可选的文件路径（在文本之后发送）。
   * @param exec - 工具执行上下文（本方法刻意不使用它来定位目标）。
   * @returns 一句人话结果。
   */
  async notifyFromTool(args, exec) {
    const text = typeof args?.text === 'string' ? args.text : ''
    const path = typeof args?.path === 'string' ? args.path.trim() : ''
    if (text.trim() === '' && path === '') {
      throw new Error('至少要给 text 或 path 其中一个。')
    }

    /*
     * 关掉「允许任意会话主动推送」时，本工具的行为**与 `send_to_qq` 完全一致**：
     * 调用者必须就是绑定到那个对话的会话。
     *
     * 微信的注释说明了为什么保留这条更严的规则而不是删掉它：
     * **关闭这个设置恢复的是原先的安全姿态，而不只是关掉一个便利功能。**
     *
     * 所以这里是 fail-closed：查不到调用者自己的对话就**拒绝**，
     * 而不是退回"推给当前绑定的那个"——那正是这个开关要禁止的事。
     */
    if (!this.#settings.allowCrossSessionNotify) {
      const own = await this.#conversationForSession(sessionIdOf(exec?.agent))
      if (own === undefined) {
        throw new Error(
          '这个会话没有绑定 QQ 对话，而「允许任意会话主动推送」是关闭的。请在设置里打开它，或先在 QQ 里发一条消息。',
        )
      }
      return await this.#deliverOrQueue(own, { text, path })
    }

    const conversationId = await this.#boundConversation()
    if (conversationId === undefined) {
      throw new Error('当前没有绑定任何 QQ 对话，无法推送。请让用户在 QQ 里先发一条消息。')
    }
    // 发不出去就排队——用户等的那条通知不该凭空消失。
    const deliverText =
      this.#settings.markdownMode === 'plain' && hasMarkdown(text)
        ? markdownToPlain(text)
        : text
    return await this.#deliverOrQueue(conversationId, { text: deliverText, path })
  }

  /**
   * 当前绑定的对话。
   *
   * 多个绑定时**拒绝而不是猜**：推给错的对话比推不出去更糟。
   *
   * @returns 对话键，没有绑定时 `undefined`。
   */
  async #boundConversation() {
    const state = await this.#store.read()
    const keys = Object.keys(state.bindings)
    if (keys.length === 0) return undefined
    if (keys.length === 1) return keys[0]
    // 多于一个：按 lastUsedAt 取最近使用的那个，并记一笔，免得这是静默的猜。
    const sorted = keys.sort(
      (a, b) => (state.bindings[b]?.lastUsedAt ?? 0) - (state.bindings[a]?.lastUsedAt ?? 0),
    )
    bootLog(`notify_qq: 有 ${String(keys.length)} 个绑定，用最近使用的 ${sorted[0]}`)
    return sorted[0]
  }

  /**
   * 先发文本再发文件。**任一段失败就抛出**——调用方据此决定是入队还是报错。
   *
   * 顺序是有意的：文件到达时它的说明已经在那里了。
   */
  async #deliverTo(conversationId, { text, path }) {
    const done = []
    if (typeof text === 'string' && text.trim() !== '') {
      if (!(await this.#send(conversationId, text))) throw new Error('文本发送失败')
      done.push('文本已发送')
    }
    if (typeof path === 'string' && path !== '') {
      done.push(await this.#sendFile(conversationId, path))
    }
    if (done.length === 0) throw new Error('至少要给 text 或 path 其中一个。')
    return done.join('；')
  }

  /**
   * 发不出去就**排队**，而不是丢掉。
   *
   * 与微信的 `#sendOrQueue` 同构：那边的平台硬规则是"不能主动发"，QQ 这边则是
   * **任何原因都可能发不出去**（网络、平台拒绝，或者平台规则改了——官方文档对主动推送
   * 的说法互相矛盾，这里不假设额度）。两条路的后果一样——用户等的通知凭空消失，
   * 而且他永远不会知道。
   *
   * ⚠️ **只把被拒的那一段入队**（微信的注释）：
   * *"每一段各自尝试，一次拒绝只排队被拒的那一段，于是窗口关闭前到达的消息，
   * 不会因为它后面的文件被押后而在补发时被发送两次。"*
   *
   * 整条入队是我第一版的写法，它会导致：文本发出去了、文件被拒，
   * 补发时**把文本重复发一遍**。
   *
   * @param conversationId - 对话键。
   * @param args.text - 文本。
   * @param args.path - 可选文件。
   * @returns 一句人话结果。
   */
  async #deliverOrQueue(conversationId, { text, path }) {
    const done = []
    const queued = []

    if (typeof text === 'string' && text.trim() !== '') {
      if (await this.#send(conversationId, text)) done.push('文本已发送')
      else {
        await this.#queuePending(conversationId, { text })
        queued.push('文本已排队')
      }
    }

    if (typeof path === 'string' && path !== '') {
      try {
        done.push(await this.#sendFile(conversationId, path))
      } catch (error) {
        await this.#queuePending(conversationId, { path })
        queued.push(`文件已排队（${describeError(error)}）`)
      }
    }

    if (done.length === 0 && queued.length === 0) {
      throw new Error('至少要给 text 或 path 其中一个。')
    }
    const parts = [...done, ...queued]
    if (queued.length > 0) parts.push('等你下次说话时补发')
    return parts.join('；')
  }

  /** 入队一条待发消息。入队失败**必须抛出**：那意味着这条消息彻底没救了。 */
  async #queuePending(conversationId, { text, path }) {
    let dropped = 0
    await this.#store.update((state) => {
      dropped = queuePendingNotification(state, {
        conversationId,
        text: typeof text === 'string' ? text : '',
        path: typeof path === 'string' ? path : undefined,
      })
    })
    if (dropped > 0) bootLog(`待发队列已满，丢弃 ${String(dropped)} 条最旧的`)
    bootLog(`待发已入队：conversation=${conversationId}`)
  }

  /** 从待发队列移除一条。 */
  async #dropPending(id) {
    await this.#store.update((state) => {
      dropPending(state, id)
    })
  }

  /**
   * 窗口重新打开了：把积压的消息补发出去。
   *
   * **必须在处理这条入站消息之前调用**（微信的注释）：用户自己的那条消息才是
   * "重新打开窗口"的东西，所以积压的通知属于这条回答**之前**——
   * 否则用户等着的通知会出现在一条毫不相干的回复下面。
   *
   * @param conversationId - 刚开窗的对话。
   */
  async #flushPending(conversationId) {
    try {
      // 先过期、再读。反过来的话，刚被判定为过期的东西会被读进这次循环里照样发出去。
      let expired = 0
      await this.#store.update((state) => {
        expired = expirePendingNotifications(state).length
      })
      if (expired > 0) bootLog(`待发：丢弃 ${String(expired)} 条过期消息`)

      const state = await this.#store.read()
      const mine = pendingFor(state, conversationId)
      if (mine.length === 0) return

      // 只在本对话仍是当前绑定时补发：**发错人比发不出去更糟**。
      const bound = await this.#boundConversation()
      if (bound !== conversationId) {
        bootLog(`待发：当前绑定是 ${bound ?? '(无)'}，与 ${conversationId} 不同，跳过补发`)
        return
      }

      let sent = 0
      for (const entry of mine) {
        try {
          if (entry.text.trim() !== '') await this.#send(conversationId, entry.text)
          if (entry.path !== undefined) {
            if (!existsSync(entry.path)) {
              /*
               * 丢弃而**不是**重试：上面的文字已经发出去了，留着这条只会在之后
               * 每条消息上把那段文字重复一遍，并且把后面所有条目堵死（微信的原话）。
               */
              await this.#dropPending(entry.id)
              bootLog(`待发：文件已不存在，丢弃 ${basename(entry.path)}`)
              continue
            }
            await this.#sendFile(conversationId, entry.path)
          }
          await this.#dropPending(entry.id)
          sent += 1
        } catch (error) {
          // 又被拒：留在队列里等下次。**跳出以保持顺序**——越过它发后面的会让对话错位。
          bootLog(`待发补发被拒，保留待下次: ${describeError(error)}`)
          break
        }
      }
      if (sent > 0) bootLog(`待发：补发 ${String(sent)} 条`)
    } catch (error) {
      this.#recordError(`补发待发消息失败: ${describeError(error)}`)
    }
  }

  /**
   * 把一个本机文件发到某对话。
   *
   * 按扩展名选通道：图片走图片消息（手机上显示为照片），视频走视频消息（可直接播放），
   * 其余走文件消息。**路径必须是绝对路径**——相对路径会被 agent 的 cwd 解释成
   * 跟用户以为的完全不同的文件。
   *
   * @param conversationId - 对话键。
   * @param path - 绝对路径。
   * @returns 一句人话结果。
   */
  async #sendFile(conversationId, path) {
    const bot = this.#bot
    if (bot === undefined) throw new Error('未连接 QQ，无法发送文件。')
    if (!isAbsolute(path)) throw new Error(`路径必须是绝对路径：${path}`)
    let info
    try {
      info = statSync(path)
    } catch {
      throw new Error(`找不到这个文件：${path}`)
    }
    if (!info.isFile()) throw new Error(`不是一个文件：${path}`)

    const resolved = this.#targetFor(conversationId)
    if (resolved === undefined) throw new Error('找不到对话的 peerId，无法发送。')
    const { target } = resolved
    const kind = mediaKindFor(path)
    const name = basename(path)

    if (kind === 'image') await bot.sendImage(target, { localPath: path })
    else if (kind === 'video') await bot.sendVideo(target, { localPath: path })
    else await bot.sendFile(target, { localPath: path }, { fileName: name })

    return kind === 'image' ? `已发送图片 ${name}` : kind === 'video' ? `已发送视频 ${name}` : `已发送文件 ${name}`
  }

  // ---------------------------------------------------------------- 诊断

  /**
   * 安全地发起一件脱离 await 链的异步工作。
   *
   * ## 为什么这个方法是必需的，而不是"防御性编程"
   *
   * `@deepseek-ai/dsh-app-boot` 的「启动与重载失败」表里有两条**与 optional/required 无关**的
   * 致命规则：
   *
   * - 脱离 `apply()` 的异步任务产生**未处理 rejection** → 致命错误：释放应用并以非零码退出
   * - 定时器 / 流回调在进程生命周期任一时刻**同步抛出未捕获异常** → 同上
   *
   * 也就是说：本插件里任何 `void someAsync()`、任何 `setTimeout`/`setInterval` 回调，
   * 只要漏一个 catch，就足以让用户的整个桌面端起不来。**所有这类调用都必须经此发起。**
   *
   * @param label - 出错时记录用的标签。
   * @param factory - 实际工作；返回 Promise 时会被接上 catch。
   */
  #fire(label, factory) {
    try {
      const result = factory()
      if (result !== undefined && result !== null && typeof result.then === 'function') {
        result.then(undefined, (error) => {
          this.#recordError(`${label}: ${describeError(error)}`)
        })
      }
    } catch (error) {
      // 同步抛出同样致命，必须先接住。
      this.#recordError(`${label} 同步抛出: ${describeError(error)}`)
    }
  }

  #recordError(message) {
    this.#errors.push(`${new Date().toISOString()} ${message}`)
    if (this.#errors.length > MAX_ERRORS) this.#errors.shift()
    bootLog(`ERROR ${message}`)
  }

  /**
   * 供设置页/诊断路由使用的状态快照。**不含任何密钥。**
   */
  async status() {
    const state = await this.#store.read()
    const account = state.accounts[this.#appId]
    return {
      connected: this.connected,
      appId: this.#appId === '' ? undefined : this.#appId,
      boundUserOpenid: account?.userOpenid,
      boundAt: account?.boundAt,
      workspace: this.#workspace,
      conversationCount: Object.keys(state.bindings).length,
      replyLimiter: this.#limiter.getConfig(),
      permissionPreset: this.#settings.permissionPreset,
      pendingInteractions: this.#interactions.size,
      errors: this.#errors.slice(-20),
    }
  }
}
