/**
 * 验证 notifyAllSessions 改造：
 * 1. schema 键集与运行时一致
 * 2. /notify 命令解析
 * 3. 未绑定会话转发的判据（含旁白过滤）
 */

// 可移植：优先用 build\（补丁应用后的产物），回退到本机已部署的插件。
const { existsSync } = await import('node:fs')
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const buildDir = join(here, '..', 'build')
const PLUGIN = existsSync(buildDir)
  ? buildDir.replace(/\\/g, '/')
  : join(process.env.USERPROFILE ?? '', '.dsh/profiles/web/node_modules/dsh-qq-plugin').replace(/\\/g, '/')
const { pathToFileURL } = await import('node:url')
const pluginUrl = pathToFileURL(PLUGIN).href

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---------- 1. 设置 schema ----------
const { SETTINGS_SCHEMA, SETTINGS_KEYS, SETTINGS_DEFAULTS, normalizeSettings } =
  await import(`${pluginUrl}/lib/settings.js`)

check('notifyAllSessions 在 schema 里', SETTINGS_KEYS.includes('notifyAllSessions'), true)
check('默认关闭', SETTINGS_DEFAULTS.notifyAllSessions, false)
check('接受 true', SETTINGS_SCHEMA.notifyAllSessions.normalize(true), true)
check('接受 false', SETTINGS_SCHEMA.notifyAllSessions.normalize(false), false)
check('拒绝字符串', SETTINGS_SCHEMA.notifyAllSessions.normalize('on'), undefined)
check('拒绝数字', SETTINGS_SCHEMA.notifyAllSessions.normalize(1), undefined)
check('设置项总数 13', SETTINGS_KEYS.length, 13)

const norm = normalizeSettings({ notifyAllSessions: true, bogus: 1 })
check('归一保留合法键', norm, { notifyAllSessions: true })

// ---------- 2. /notify 解析 ----------
// 复刻 #handleNotifyCommand 的解析部分
const ON_WORDS = new Set(['on', '1', '开', '开启', '打开', 'true', 'yes'])
const OFF_WORDS = new Set(['off', '0', '关', '关闭', 'false', 'no'])
function parseNotify(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith('/notify')) return { matched: false }
  const rest = trimmed.slice('/notify'.length)
  let arg
  if (rest === '') {
    arg = ''
  } else if (/^[\s:：]/.test(rest)) {
    arg = rest.replace(/^[\s:：]+/, '').trim().toLowerCase()
  } else {
    const glued = rest.trim().toLowerCase()
    if (!ON_WORDS.has(glued) && !OFF_WORDS.has(glued)) return { matched: false }
    arg = glued
  }
  if (arg === '') return { matched: true, arg: '', action: 'status' }
  if (ON_WORDS.has(arg)) return { matched: true, arg, action: 'on' }
  if (OFF_WORDS.has(arg)) return { matched: true, arg, action: 'off' }
  return { matched: true, arg, action: 'invalid' }
}

check('/notify 查状态', parseNotify('/notify'), { matched: true, arg: '', action: 'status' })
check('/notify on', parseNotify('/notify on').action, 'on')
check('/notify off', parseNotify('/notify off').action, 'off')
check('/notify:on 冒号', parseNotify('/notify:on').action, 'on')
check('/notifyon 无分隔符', parseNotify('/notifyon').action, 'on')
check('/notify 开 中文', parseNotify('/notify 开').action, 'on')
check('/notify 关 中文', parseNotify('/notify 关').action, 'off')
check('/notify 1', parseNotify('/notify 1').action, 'on')
check('/notify 0', parseNotify('/notify 0').action, 'off')
check('/notify 乱写', parseNotify('/notify abc').action, 'invalid')
check('/notifications 不吃', parseNotify('/notifications'), { matched: false })
check('/news 不吃', parseNotify('/news'), { matched: false })
check('普通消息不吃', parseNotify('你好'), { matched: false })

// ---------- 3. 未绑定转发判据 ----------
// 复刻 #forwardUnbound 的缓冲逻辑
function makeForwarder() {
  const pushed = []
  let entry
  function frame({ text, completed, toolCall }) {
    const e = entry ?? { text: '', sawTool: false, narrationLen: 0 }
    if (text !== undefined) e.text += text
    if (toolCall !== undefined) e.sawTool = true
    if (completed !== true) { entry = e; return }
    if (e.sawTool === true) {
      e.narrationLen = e.text.length
      e.sawTool = false
      entry = e
      return
    }
    entry = undefined
    const finalText = e.text.slice(e.narrationLen).trim()
    if (finalText === '') return
    pushed.push(finalText)
  }
  return { frame, pushed }
}

{
  const f = makeForwarder()
  f.frame({ text: '我先看一下文件。', completed: false })
  f.frame({ toolCall: { id: 't1', name: 'read' } })
  f.frame({ completed: true })
  f.frame({ text: '继续第二步。', completed: false })
  f.frame({ toolCall: { id: 't2', name: 'bash' } })
  f.frame({ completed: true })
  f.frame({ text: '全部完成了，结果如下。', completed: false })
  f.frame({ completed: true })
  check('多步任务只推一条', f.pushed.length, 1)
  check('只推最终结果', f.pushed[0], '全部完成了，结果如下。')
}

{
  const f = makeForwarder()
  f.frame({ text: '纯对话的回答。', completed: false })
  f.frame({ completed: true })
  check('纯对话正常推送', f.pushed, ['纯对话的回答。'])
}

{
  const f = makeForwarder()
  f.frame({ toolCall: { id: 't1', name: 'send_to_qq' } })
  f.frame({ completed: true })
  check('纯工具收尾无正文则不推', f.pushed.length, 0)
}

{
  const f = makeForwarder()
  f.frame({ toolCall: { id: 't1', name: 'x' } })
  f.frame({ completed: true })
  f.frame({ text: '第二轮结果。', completed: false })
  f.frame({ completed: true })
  check('sawTool 已复位', f.pushed, ['第二轮结果。'])
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
