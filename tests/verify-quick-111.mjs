/**
 * 验证快速对话（111）与斜杠转义（//x）改造。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { SETTINGS_SCHEMA, SETTINGS_KEYS, SETTINGS_DEFAULTS, normalizeSettings } =
  await import(`${pathToFileURL(PLUGIN).href}/lib/settings.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---------- 1. 设置项 ----------
check('quickWorkspacePath 在 schema', SETTINGS_KEYS.includes('quickWorkspacePath'), true)
check('默认空串（不启用）', SETTINGS_DEFAULTS.quickWorkspacePath, '')
check('接受路径', SETTINGS_SCHEMA.quickWorkspacePath.normalize('C:\\x'), 'C:\\x')
check('拒绝数字', SETTINGS_SCHEMA.quickWorkspacePath.normalize(1), undefined)
check('设置项总数 13', SETTINGS_KEYS.length, 13)

// ---------- 2. 111 触发判定 ----------
function matches111(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  return /^111(?:\s|$)/.test(raw)
}
check('111 你好 触发', matches111('111 你好'), true)
check('111 单独 触发', matches111('111'), true)
check('111换行 触发', matches111('111\n你好'), true)
check('1111 不触发', matches111('1111'), false)
check('1111 乘以 不触发', matches111('1111 乘以 3'), false)
check('第111行 不触发', matches111('第111行有问题'), false)
check('算111 不触发', matches111('算一下 111 乘以 3'), false)
check('111你好 无空格 不触发', matches111('111你好'), false)

// ---------- 3. 111 正文提取 ----------
function bodyOf(text) {
  const raw = text.trim()
  return raw.slice(3).trim()
}
check('正文提取', bodyOf('111 你是什么模型'), '你是什么模型')
check('正文空', bodyOf('111'), '')
check('正文多空格', bodyOf('111   你好'), '你好')

// ---------- 4. //x 转义 ----------
function unescapeSlash(text) {
  if (typeof text !== 'string' || !text.startsWith('//')) return undefined
  return text.slice(1)
}
check('//i -> /i', unescapeSlash('//i'), '/i')
check('//i-have-adhd', unescapeSlash('//i-have-adhd'), '/i-have-adhd')
check('//compact', unescapeSlash('//compact'), '/compact')
check('///i -> //i（只剥一层）', unescapeSlash('///i'), '//i')
check('/i 不归它管', unescapeSlash('/i'), undefined)
check('普通文本不归它管', unescapeSlash('你好'), undefined)

// ---------- 5. 优先级：// 先于 111 ----------
{
  // 实际代码里 //x 先判，命中就 return，不会再走 111
  function routeOrder(text) {
    const esc = unescapeSlash(text)
    if (esc !== undefined) return { kind: 'escaped', text: esc }
    if (matches111(text)) return { kind: 'quick', body: bodyOf(text) }
    return { kind: 'normal' }
  }
  check('//111 走转义', routeOrder('//111 你好'), { kind: 'escaped', text: '/111 你好' })
  check('111 走快速', routeOrder('111 你好'), { kind: 'quick', body: '你好' })
  check('普通消息', routeOrder('你好'), { kind: 'normal' })
}

// ---------- 6. /111 是转义还是等同 ----------
{
  // 用户选择方案 A：/111 是转义，字面发送 "111 ..."
  // 但注意 /111 以单斜杠开头 → 会走 router 的 #command → default 分支回「未知指令」
  // 这是需要说明的：/111 不走 unescapeSlash（那要两个斜杠）
  check('/111 不被 unescape 捕获', unescapeSlash('/111'), undefined)
  check('/111 也不被 111 捕获', matches111('/111'), false)
  // → /111 会落到 router 的未知指令分支。用户要求的是"字面 111"，需要额外处理。
}

// ---------- 7. DSH skill 名合法性 ----------
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
function skillGesture(text) {
  const out = []
  for (const m of text.matchAll(SKILL_GESTURE)) out.push(m[2])
  return out
}
check('/i 被识别', skillGesture('/i'), ['i'])
check('/i-have-adhd 被识别', skillGesture('/i-have-adhd'), ['i-have-adhd'])
check('//i 不被识别（双斜杠破坏边界）', skillGesture('//i'), [])
check('转义后的 /i 被识别', skillGesture(unescapeSlash('//i')), ['i'])

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
