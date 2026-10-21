/**
 * 设置项的**唯一一份**定义：每项一个校验器 + 一个默认值，外加由它派生的归一函数。
 *
 * ## 为什么要有这个文件（这是一个真实发生过的 bug，不是假想）
 *
 * 本插件原来把设置名抄了**三遍**：`state.js` 的加载白名单（9 项）、
 * `runtime.js` `#persistSettings()` 的落盘清单（另外 9 项）、以及设置页快照。
 * 三份手抄名单的问题是它们**不会一起改**：加一项设置时漏掉 `state.js` 那份，
 * 加载时该字段被丢弃，而**每次写盘都会重新加载并重新规范化**，于是下一次写盘
 * 把这份丢失持久化了——表现就是"重启后设置忘了"。
 *
 * 微信插件的同一条故障（提交 `5cbe7d2 Keep every setting across a reload`）用的修法是
 * **映射类型下每项一个校验器**，在 TypeScript 里"加了设置却没加校验器"是编译错误。
 * QQ 是纯 JS，**没有编译器**，所以这里把那份编译期保证换成两样东西：
 *
 * 1. 本表是唯一来源——`normalizeState`（加载）与运行时（落盘、快照、读回）都由它驱动，
 *    不再各抄一份；
 * 2. `scripts/verify.mjs` 里有 schema 驱动的往返测试 + 键集一致性断言，
 *    后者就是那个"编译错误"的等价物（见该测试的注释）。
 *
 * ## 逐项语义（**行为契约，不许顺手改**）
 *
 * - 校验器返回 `undefined` = **丢弃该字段**（保持原值 / 默认值），而不是回落到默认值。
 *   越界、类型不对都走这条路。
 * - 数值项在这里**取整**并施加"防打错"上限（`CEILING_*`），与迁移前 `boundedMs` /
 *   `boundedChars` 完全一致，`state.js` 与运行时因此共用同一条边界。
 * - **空串是合法值**，不是"没改"：`presenceNote` 空串 = 不要这段渠道说明；
 *   `workspacePath` 空串 = 用默认位置。
 * - `0` 是合法值：`settleMs` / `mergeWindowMs` 的 0 = 不等待，`maxReplyChars` 的 0 = 不限制。
 *
 * @module dsh-qq/settings
 */

/**
 * 数值设置的**合理上限**。移植自微信的 `readSettingsPatch`。
 *
 * 微信的原话：*"上限是防打错，不是格式规则——十小时的窗口是打错了，
 * 而一百万的回复上限会让每条回复都变成文件。"*
 *
 * 没有它的话，设置页里一个手滑（`36000000`）就能让**每条回复都等十小时**，
 * 而且看起来"设置生效了"，没人会想到去怀疑那个数字。
 */
const CEILING_MS = 3_600_000
const CEILING_CHARS = 200_000

/**
 * 校验一个不可能为负的数值：有限、非负、不超上限。通过则**取整**。
 *
 * 取整是有意的：小数毫秒对 `setTimeout` 没有意义，却会原样存进状态文件、
 * 在设置页里显示成一串小数。迁移前 `applySettings` 与 `hydrateSettings` 都这么做，
 * 这里原样保留（唯一的差异是 `Number.isInteger` 的检查被 `Math.round` 取代，
 * 而 `Math.round` 的结果必然是整数，所以可观测行为不变）。
 *
 * @param value - 候选值。
 * @param ceiling - 该项的上限。
 * @returns 合法值，或 `undefined`（含义是"这个字段保持原值/默认值"）。
 */
function boundedNumber(value, ceiling) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= ceiling
    ? Math.round(value)
    : undefined
}

/** 是否是布尔值。 */
function isBoolean(value) {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 是否是字符串。
 *
 * **不判长度、不 trim**：空串是合法值（见文件头），而 trim 是运行时的职责
 * （`workspacePath` 要保留用户填的原文让他在设置页里能改）。
 */
function isString(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * Markdown 处理模式的合法取值。
 *
 * 表外的值一律丢弃（保持原值）——与其它校验器同一条语义。
 * 硬编码这三个是因为它们是**本插件自己的行为分支**，不像权限预设那样由部署方配置。
 */
const MARKDOWN_MODES = new Set(['plain', 'raw', 'file'])

/**
 * 校验 Markdown 处理模式。
 *
 * @param value - 候选值。
 * @returns 合法模式，或 `undefined`（保持原值）。
 */
function isMarkdownMode(value) {
  return typeof value === 'string' && MARKDOWN_MODES.has(value) ? value : undefined
}

/**
 * 渠道上下文说明的默认值，移植自微信插件，措辞按 QQ 改写。
 *
 * **为什么需要它**：agent 默认以为对方能看到这台电脑。没有这段说明，
 * 它会对着手机说「打开 `C:\…` 看一下」——用户做不到，而且看不到自己错在哪。
 *
 * 微信写这份说明时列了四件事，我一条不改地保留：
 * 对方在手机上、看不到屏幕与文件系统、要看东西就直接发（图片视频会变成照片/视频，
 * 其他是附件）、回复要短。**这四句每一句都对应一种真实发生过的答非所问。**
 */
const DEFAULT_PRESENCE_NOTE =
  '[渠道：QQ] 你在和 QQ 上的用户对话，对方在手机上，看不到这台电脑的屏幕和文件系统。' +
  '不要让他去"打开某个路径"或"看某个文件"。需要给他看东西时，直接发送：' +
  '图片或视频会显示成照片/视频，其他文件会作为附件发过去。' +
  '回复尽量简短，适合手机阅读。'

/**
 * 每项设置一个校验器，键就是状态文件里存的名字。
 *
 * 这是插件的**唯一一份**设置清单：`state.js` 的加载归一、运行时的落盘清单、
 * 设置页快照与读回全部由它派生。加一项设置只需在这里加一行——
 * 其余各处（包括往返测试的断言数）会自动跟上。
 *
 * 每项的 `normalize` 语义见文件头：返回 `undefined` = 丢弃该字段。
 */
export const SETTINGS_SCHEMA = {
  /**
   * 本频道会话的权限预设。
   *
   * ⚠️ **只判类型，不判取值**——与迁移前的 `state.js` 逐字一致。
   * 真实预设名由部署方配置（`@deepseek-ai/dsh-permission-presets` 的 `names`），
   * 插件**不能**硬编码一份合法名单（`auto` 还取决于 Auto integration 是否存活）。
   * 所以这里放行任意字符串；运行时的 `setPermissionPreset` 照旧接受任意字符串并记日志。
   */
  permissionPreset: { normalize: isString, default: 'danger-full-access' },
  /** 是否要求 agent 先确认再执行会话操作。更安全的一侧。 */
  requireConfirmation: { normalize: isBoolean, default: true },
  /** 是否允许任意会话主动推送到当前绑定的对话。 */
  allowCrossSessionNotify: { normalize: isBoolean, default: true },
  /**
   * 本地扩展：任何会话的回合结束时，是否把结果也推到 QQ。
   *
   * ## 为什么需要它
   *
   * 默认行为是「只有绑定的那个会话才送」。于是用户在桌面端开的会话跑完一个长任务，
   * 结果只留在那台电脑上，手机上什么也收不到——除非事先切进去，或者让 agent
   * 自己调 `notify_qq`。而"我出门前让它跑个任务，回来看手机"恰恰是这类遥控器最该支持的场景。
   *
   * ## 为什么默认关闭
   *
   * 打开后**所有**会话的结果都会往手机推，包括随口试的一句、跑到一半放弃的、
   * 以及桌面上正在看的那个。那不是"更多信息"，而是噪音——而且会让人误以为
   * 手机上的东西都是自己要的。所以默认保持上游的保守姿态，由用户显式打开。
   *
   * 打开后仍**跳过**两种情况（见 `runtime.onAssistantFrame`）：
   * 1. 该会话本身就绑定着某个 QQ 对话（那本来就会送，不能送两遍）；
   * 2. 本轮已经有 `notify_qq` 推过（否则同一条结果会到两次）。
   */
  notifyAllSessions: { normalize: isBoolean, default: false },
  /** 回复聚合的静默窗口（毫秒）：连续流片段之间等这么久没有新片段就发出去。 */
  settleMs: { normalize: (value) => boundedNumber(value, CEILING_MS), default: 1_200 },
  /**
   * 渠道上下文说明（空串 = 不要这段说明）。
   *
   * 这一段会被逐句钉在设置页默认值测试里（见 `verify.mjs`）。
   */
  presenceNote: { normalize: isString, default: DEFAULT_PRESENCE_NOTE },
  /**
   * 附件合并窗口（毫秒）。
   *
   * 用户发图的动作和打字问"这是什么"之间有天然间隔，这个窗口就是用来跨过它的。
   */
  mergeWindowMs: { normalize: (value) => boundedNumber(value, CEILING_MS), default: 10_000 },
  /**
   * 窗口内没等到指令时，是否直接把手头的附件交给 agent。
   *
   * 关掉它**不是"忽略附件"**，而是"等我说了话再回答"——批次仍然记着，
   * 之后任何一条文字消息都会把它带上。
   */
  autoReplyAttachments: { normalize: isBoolean, default: true },
  /** 单条回复的字数上限；`0` 表示不限制。 */
  maxReplyChars: { normalize: (value) => boundedNumber(value, CEILING_CHARS), default: 4_000 },
  /**
   * 用户填的会话文件夹路径（空串 = 用默认位置）。
   *
   * **这里不做路径规范化**——那是运行时的职责（`resolveWorkspaceDir` 判绝对路径并验可写）。
   * 设置项存的是**用户填的原文**：他填了个不可用的路径时，设置页要能显示原文让他改，
   * 而生效的那个路径从 `status.workspace` 看。
   */
  workspacePath: { normalize: isString, default: '' },
  /**
   * 本地扩展：「快速对话」目录（`111` 前缀的消息发到这里的最新会话）。
   *
   * ## 与 `workspacePath` 的区别
   *
   * `workspacePath` 是**本频道**的工作目录——当前绑定的那个 QQ 对话的消息都落在那。
   * 本项是**旁路**：`111 你好` 把「你好」发到这个目录下的最新会话，
   * 而**当前绑定保持不变**——用户接下来正常说话，还是回到原来那个会话。
   *
   * 所以它解决的是"顺手问一句、不想污染当前对话"，不是"换一个工作区"。
   *
   * ## 空串 = 关闭
   *
   * 未设置时 `111 你好` 被当成**普通文本**原样交给 agent（用户明确要求的行为）。
   * 这与 `workspacePath` 的"空串 = 用默认"不同：这里空串就是**不启用**。
   *
   * ## 目录由插件创建，DSH 工作区由用户建
   *
   * 目录走 `resolveWorkspaceDir`（会 mkdir + 写探针，见 `paths.js`）；
   * 但 DSH 工作区是宿主的账本，插件不代劳——用户自己在设置里建并选中。
   */
  quickWorkspacePath: { normalize: isString, default: '' },
  /**
   * 本地扩展：QQ 消息里 Markdown 怎么处理。
   *
   * ## 为什么需要
   *
   * **QQ 消息不渲染 Markdown。** agent 输出的是 Markdown，于是手机上看到的
   * 是一堆井号、竖线、星号——用户直接截图报了这个问题。
   *
   * ## 三个取值
   *
   * | 值 | 行为 |
   * |---|---|
   * | `plain`（默认） | 转成纯文本再发。表格变缩进列表，其余保留结构 |
   * | `raw` | 原样发送（上游行为）。想要原始标记时用 |
   * | `file` | 只要有 Markdown 就写成 `.md` 附件发送，手机上点开能看到渲染效果 |
   *
   * ## 长回复不受影响
   *
   * 超过 `maxReplyChars` 的回复**始终**走 `.md` 文件（见 `planReply`），
   * 与这一项无关——那条路径本来就保留完整 Markdown。
   */
  markdownMode: { normalize: isMarkdownMode, default: 'plain' },
  /**
   * 本地扩展：会话完成推送里，提问最多显示多少字。
   *
   * ## 为什么需要
   *
   * `notifyAllSessions` 打开后，推送只有结果。用户看到一条"完成了"，却想不起
   * 当初问的是什么——尤其在同时跑好几个任务的时候。
   *
   * ## 为什么默认 60
   *
   * 手机上一行大约 20 个汉字，60 字是三行：够认出是哪件事，又不至于把推送
   * 撑成一篇。超过就截断加省略号——**不做折行保留**，因为提问是"索引"不是正文。
   *
   * `0` 表示不显示提问（只要结果）。
   */
  finishPromptChars: {
    normalize: (value) => boundedNumber(value, CEILING_CHARS),
    default: 60,
  },
}

/**
 * 全部设置名。
 *
 * 由 `SETTINGS_SCHEMA` 派生，所以它**不可能**与 schema 漂移——
 * 这也正是测试里"键集一致"断言能成立的前提。
 */
export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA)

/**
 * 全部默认值。
 *
 * 运行时用 `Object.assign({}, SETTINGS_DEFAULTS)` 建它的设置对象，
 * 所以"运行时持有的设置字段集"与 schema 的键集**在构造上就相同**：
 * 一处漏改，键集一致性断言与 schema 驱动的往返测试会一起变红。
 */
export const SETTINGS_DEFAULTS = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, SETTINGS_SCHEMA[key].default]))

/**
 * 把一份来路不明的 `settings` 归一成"只含合法项"的对象。
 *
 * 旧版本写下的文件、手工编辑过的文件都会经过这里。**只接受已知键**：
 * 表外的键一律丢弃，所以状态文件里多出来的东西不会悄悄变成运行时的行为。
 *
 * ⚠️ 返回的对象**只含通过校验的项**（缺项不补默认值）——这与迁移前逐字段
 * `if (typeof …)` 的行为一致：缺项由运行时回落 `SETTINGS_DEFAULTS`，
 * 而不是在这里被写成默认值（写成默认值会让"用户没设过"与"用户设成了默认值"
 * 在文件里长得一样）。
 *
 * @param value - 原始 `record.settings`。
 * @returns 净化的设置对象，非对象输入返回 `{}`。
 */
export function normalizeSettings(value) {
  if (typeof value !== 'object' || value === null) return {}
  const settings = {}
  for (const key of SETTINGS_KEYS) {
    const normalized = SETTINGS_SCHEMA[key].normalize(value[key])
    if (normalized !== undefined) settings[key] = normalized
  }
  return settings
}
