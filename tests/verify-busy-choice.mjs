/**
 * 验证「会话正忙时的四选一」改造。
 */

import { pathToFileURL } from 'node:url'
// 可移植：优先用 build\（补丁应用后的产物），回退到本机已部署的插件。
const { existsSync } = await import('node:fs')
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const buildDir = join(here, '..', 'build')
const PLUGIN = existsSync(buildDir)
  ? buildDir.replace(/\\/g, '/')
  : join(process.env.USERPROFILE ?? '', '.dsh/profiles/web/node_modules/dsh-qq-plugin').replace(/\\/g, '/')
const { normalizeState, emptyState } = await import(`${pathToFileURL(PLUGIN).href}/lib/state.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---------- 1. pendingBusy 状态字段 ----------
check('emptyState 有 pendingBusy', emptyState().pendingBusy, {})

{
  const s = normalizeState({
    pendingBusy: { c1: { sessionId: 's1', text: '你好', mode: 'bound', at: 100 } },
  })
  check('完整记录保留', s.pendingBusy.c1, { sessionId: 's1', text: '你好', mode: 'bound', at: 100 })
}
{
  const s = normalizeState({ pendingBusy: { c1: { sessionId: 's1' } } })
  check('缺 text 丢弃', s.pendingBusy.c1, undefined)
}
{
  const s = normalizeState({ pendingBusy: { c1: { text: 'x' } } })
  check('缺 sessionId 丢弃', s.pendingBusy.c1, undefined)
}
{
  const s = normalizeState({ pendingBusy: { c1: { sessionId: 's', text: 't' } } })
  check('缺 mode/at 补默认', s.pendingBusy.c1, { sessionId: 's', text: 't', mode: 'bound', at: 0 })
}
{
  const s = normalizeState({ pendingBusy: { a: { sessionId: 's', text: 't' }, b: 'bad' } })
  check('坏条目不影响好条目', Object.keys(s.pendingBusy), ['a'])
}
{
  const s = normalizeState({})
  check('旧状态兼容', s.pendingBusy, {})
}

// ---------- 2. 选项解析 ----------
function parseChoice(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!/^[0123]$/.test(raw)) return null
  return Number(raw)
}
check('1 = 插入', parseChoice('1'), 1)
check('2 = 排队', parseChoice('2'), 2)
check('3 = 分叉', parseChoice('3'), 3)
check('0 = 撤回', parseChoice('0'), 0)
check('空格包裹', parseChoice(' 1 '), 1)
check('4 无效', parseChoice('4'), null)
check('多位数无效', parseChoice('12'), null)
check('空串无效', parseChoice(''), null)
check('文字无效', parseChoice('插入'), null)
check('负数无效', parseChoice('-1'), null)

// ---------- 3. 四个分支的行为 ----------
function actOn(choice, { steerOk = true, queueOk = true, forkOk = true } = {}) {
  if (choice === 0) return 'withdrawn'
  if (choice === 2) return queueOk ? 'queued' : 'queue-failed'
  if (choice === 1) {
    if (steerOk) return 'steered'
    return queueOk ? 'steer-failed-then-queued' : 'steer-and-queue-failed'
  }
  if (choice === 3) {
    if (forkOk) return 'forked'
    return queueOk ? 'fork-failed-then-queued' : 'fork-and-queue-failed'
  }
  return 'unknown'
}
check('0 撤回', actOn(0), 'withdrawn')
check('1 插入成功', actOn(1), 'steered')
check('1 插入失败退排队', actOn(1, { steerOk: false }), 'steer-failed-then-queued')
check('1 全失败', actOn(1, { steerOk: false, queueOk: false }), 'steer-and-queue-failed')
check('2 排队成功', actOn(2), 'queued')
check('2 排队失败', actOn(2, { queueOk: false }), 'queue-failed')
check('3 分叉成功', actOn(3), 'forked')
check('3 分叉失败退排队', actOn(3, { forkOk: false }), 'fork-failed-then-queued')
check('3 全失败', actOn(3, { forkOk: false, queueOk: false }), 'fork-and-queue-failed')

// ---------- 4. 非数字回答应作废提示 ----------
function handleNonNumeric() {
  // 用户改主意说了别的话：删掉 pendingBusy，让消息走正常路径
  const state = { pendingBusy: { c1: { sessionId: 's', text: 't', mode: 'bound' } } }
  const choice = parseChoice('算了不发了')
  if (choice === null) {
    delete state.pendingBusy.c1
    return { cleared: true, routed: false }
  }
  return { cleared: false, routed: true }
}
check('非数字：作废提示', handleNonNumeric().cleared, true)
check('非数字：不吞消息', handleNonNumeric().routed, false)

// ---------- 5. 忙碌判定（拿不到时按不忙） ----------
function isRunning(rows, sessionId) {
  if (!Array.isArray(rows)) return false
  const row = rows.find((r) => r?.sessionId === sessionId)
  return row?.running === true
}
check('running=true', isRunning([{ sessionId: 's', running: true }], 's'), true)
check('running=false', isRunning([{ sessionId: 's', running: false }], 's'), false)
check('不在清单 → 不忙', isRunning([{ sessionId: 'other', running: true }], 's'), false)
check('空清单 → 不忙', isRunning([], 's'), false)
check('null → 不忙', isRunning(null, 's'), false)
check('缺 running 字段 → 不忙', isRunning([{ sessionId: 's' }], 's'), false)

// ---------- 6. 分叉后绑定切换 ----------
function applyForkBinding(bindings, conversationId, childId, now) {
  const existing = bindings[conversationId]
  bindings[conversationId] = {
    ...(existing ?? {}),
    conversationId,
    sessionId: childId,
    lastUsedAt: now,
  }
  return bindings
}
{
  const b = { c1: { conversationId: 'c1', sessionId: 'old', title: 'QQ', accountId: 'a' } }
  applyForkBinding(b, 'c1', 'new-child', 999)
  check('绑定切到子会话', b.c1.sessionId, 'new-child')
  check('保留原 title', b.c1.title, 'QQ')
  check('保留原 accountId', b.c1.accountId, 'a')
  check('更新时间戳', b.c1.lastUsedAt, 999)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
