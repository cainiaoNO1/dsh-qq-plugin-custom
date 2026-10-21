/**
 * 验证 rrr（回话给最近完成的会话）改造。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { normalizeState, emptyState } = await import(`${pathToFileURL(PLUGIN).href}/lib/state.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---------- 1. 状态字段 ----------
check('emptyState 有 lastFinished', emptyState().lastFinished, null)

{
  const s = normalizeState({ lastFinished: { sessionId: 'session-abc', title: '测试', at: 123 } })
  check('归一保留完整记录', s.lastFinished, { sessionId: 'session-abc', title: '测试', at: 123 })
}
{
  const s = normalizeState({ lastFinished: { title: '没 id' } })
  check('缺 sessionId 丢弃', s.lastFinished, null)
}
{
  const s = normalizeState({ lastFinished: { sessionId: 'x' } })
  check('缺 title/at 补默认', s.lastFinished, { sessionId: 'x', title: '', at: 0 })
}
{
  const s = normalizeState({ lastFinished: 'bad' })
  check('非对象丢弃', s.lastFinished, null)
}
{
  const s = normalizeState({})
  check('旧状态文件兼容', s.lastFinished, null)
}

// ---------- 2. rrr 触发判定 ----------
function matchesRrr(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  return /^rrr(?:\s|$)/.test(raw)
}
check('rrr 你真厉害 触发', matchesRrr('rrr 你真厉害'), true)
check('rrr 单独 触发', matchesRrr('rrr'), true)
check('rrrr 不触发', matchesRrr('rrrr'), false)
check('rrr你真厉害 无空格 不触发', matchesRrr('rrr你真厉害'), false)
check('包含 rrr 不触发', matchesRrr('我觉得 rrr 挺好'), false)
check('中文 rrr 不触发', matchesRrr('好的 rrr'), false)

// ---------- 3. 正文提取 ----------
function bodyOf(text) {
  return text.trim().slice(3).trim()
}
check('正文提取', bodyOf('rrr 你真厉害'), '你真厉害')
check('正文空', bodyOf('rrr'), '')
check('多空格', bodyOf('rrr   你好'), '你好')

// ---------- 4. /rrr 字面转义 ----------
function unescapeLiteralRrr(t) {
  if (typeof t !== 'string' || !/^\/rrr(?:\s|$)/.test(t)) return undefined
  return t.slice(1)
}
check('/rrr 你好 -> 字面', unescapeLiteralRrr('/rrr 你好'), 'rrr 你好')
check('/rrr -> 字面', unescapeLiteralRrr('/rrr'), 'rrr')
check('/rrrr 不捕获', unescapeLiteralRrr('/rrrr'), undefined)
check('//rrr 不归它管', unescapeLiteralRrr('//rrr'), undefined)

// ---------- 5. 分派顺序（含 rrr） ----------
function unescapeSlash(t) {
  if (typeof t !== 'string' || !t.startsWith('//')) return undefined
  return t.slice(1)
}
function unescapeLiteral111(t) {
  if (typeof t !== 'string' || !/^\/111(?:\s|$)/.test(t)) return undefined
  return t.slice(1)
}
function dispatch(text) {
  const esc = unescapeSlash(text)
  if (esc !== undefined) return { via: 'escaped-slash', payload: esc }
  const l111 = unescapeLiteral111(text)
  if (l111 !== undefined) return { via: 'literal-111', payload: l111 }
  const lrrr = unescapeLiteralRrr(text)
  if (lrrr !== undefined) return { via: 'literal-rrr', payload: lrrr }
  if (matchesRrr(text)) return { via: 'rrr', payload: bodyOf(text) }
  const raw = text.trim()
  if (/^111(?:\s|$)/.test(raw)) return { via: 'quick', payload: raw.slice(3).trim() }
  return { via: 'router', payload: text }
}

check('//i 优先', dispatch('//i').via, 'escaped-slash')
check('/111', dispatch('/111 你好'), { via: 'literal-111', payload: '111 你好' })
check('/rrr', dispatch('/rrr 你好'), { via: 'literal-rrr', payload: 'rrr 你好' })
check('rrr', dispatch('rrr 你真厉害'), { via: 'rrr', payload: '你真厉害' })
check('111', dispatch('111 问题'), { via: 'quick', payload: '问题' })
check('普通', dispatch('你好').via, 'router')
check('//rrr 走转义', dispatch('//rrr').via, 'escaped-slash')
check('//rrr payload', dispatch('//rrr 你好').payload, '/rrr 你好')

// ---------- 6. 与 111 互不干扰 ----------
check('rrr 不触发 111', dispatch('rrr 111').via, 'rrr')
check('111 不触发 rrr', dispatch('111 rrr').via, 'quick')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
