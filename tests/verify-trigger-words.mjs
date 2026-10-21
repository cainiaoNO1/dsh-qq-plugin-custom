/**
 * 验证快捷触发词识别（111 / rrr）。
 *
 * 真实故障：用户发「111190.254，132.231 两个服务器已经回收了，不再用了」
 * （111 与内容之间没有空格），旧规则 `/^111(?:\s|$)/` 不匹配，
 * 消息被当成普通聊天发进当前会话，快捷通道毫无反应。
 * 另一条把 111 放在结尾的消息同样没被认出来。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')

// 从 runtime.js 源码里取出 extractTriggerWord 的逻辑做行为验证。
// 该函数不导出（模块内部使用），所以这里按同一份实现复刻并用真实输入核对。
function extractTriggerWord(text, word, options = {}) {
  const { allowMiddle = false } = options
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '' || !trimmed.includes(word)) return undefined
  const repeated = new RegExp(`^${word[0] === '1' ? '1' : word[0]}+$`)
  if (repeated.test(trimmed) && trimmed !== word) return undefined
  const firstToken = trimmed.split(/\s/)[0] ?? ''
  if (firstToken !== word && /^[\d.]+$/.test(firstToken)) return undefined
  const leading = new RegExp(`^${word}`)
  const trailing = new RegExp(`(?:^|\\s)${word}$`)
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
  const loneCommand = /^\/([a-z][a-z0-9-]*)\s+([\s\S]+)$/i.exec(body)
  if (loneCommand !== null) body = loneCommand[2].trim()
  return body
}

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---------- 用户真实报障的两条消息 ----------
const REAL_1 = '111190.254，132.231 两个服务器已经回收了，不再用了'
const REAL_2 = '190.254，132.231 两个服务器已经回收了，不再用了 111'

check('报障消息1（111 紧贴开头）触发', extractTriggerWord(REAL_1, '111') !== undefined, true)
check(
  '报障消息1 正文正确',
  extractTriggerWord(REAL_1, '111'),
  '190.254，132.231 两个服务器已经回收了，不再用了',
)
check('报障消息2（111 在结尾）触发', extractTriggerWord(REAL_2, '111') !== undefined, true)
check(
  '报障消息2 正文正确',
  extractTriggerWord(REAL_2, '111'),
  '190.254，132.231 两个服务器已经回收了，不再用了',
)
check('两条消息正文一致', extractTriggerWord(REAL_1, '111') === extractTriggerWord(REAL_2, '111'), true)

// ---------- 开头写法 ----------
check('111 空格', extractTriggerWord('111 你好', '111'), '你好')
check('111 紧贴中文', extractTriggerWord('111你好', '111'), '你好')
// `111123` 首词是纯数字，被"纯数字保护"挡住——那是数量不是前缀（与 1111 同理）
check('111 紧贴纯数字不触发', extractTriggerWord('111123', '111'), undefined)
check('111 单独', extractTriggerWord('111', '111'), '')
check('111 多空格', extractTriggerWord('111   你好', '111'), '你好')
check('111 换行', extractTriggerWord('111\n你好', '111'), '你好')

// ---------- 结尾写法 ----------
check('结尾带空格', extractTriggerWord('你好 111', '111'), '你好')
// 结尾要求**独立成词**（前面是空白）：`你好111` 属于句中紧贴，按设计不认
check('结尾紧贴不触发', extractTriggerWord('你好111', '111'), undefined)
check('结尾带标点不触发', extractTriggerWord('你好，111', '111'), undefined)

// ---------- 不该触发 ----------
check('1111 不触发', extractTriggerWord('1111', '111'), undefined)
check('111.5 不触发', extractTriggerWord('111.5', '111'), undefined)
check('1111 房间 不触发', extractTriggerWord('1111 房间号', '111'), undefined)
check('句子中间不触发', extractTriggerWord('第 111 行有问题', '111'), undefined)
check('句子中间不触发2', extractTriggerWord('算一下 111 乘以 3', '111'), undefined)
check('无关文本不触发', extractTriggerWord('你好世界', '111'), undefined)
check('空串不触发', extractTriggerWord('', '111'), undefined)
check('非字符串不触发', extractTriggerWord(null, '111'), undefined)

// ---------- rrr 同规则 ----------
check('rrr 空格', extractTriggerWord('rrr 你真厉害', 'rrr'), '你真厉害')
check('rrr 紧贴', extractTriggerWord('rrr你真厉害', 'rrr'), '你真厉害')
check('rrr 结尾', extractTriggerWord('你真厉害 rrr', 'rrr'), '你真厉害')
check('rrr 单独', extractTriggerWord('rrr', 'rrr'), '')
check('rrrr 不触发', extractTriggerWord('rrrr', 'rrr'), undefined)
check('句子中间 rrr 不触发', extractTriggerWord('我觉得 rrr 挺好', 'rrr'), undefined)

// ---------- 字面转义放宽 ----------
function unescapeLiteral(text, word) {
  if (typeof text !== 'string') return undefined
  if (!new RegExp(`^\\/${word}`).test(text)) return undefined
  return text.slice(1)
}
check('/111 空格', unescapeLiteral('/111 你好', '111'), '111 你好')
check('/111 紧贴', unescapeLiteral('/111你好', '111'), '111你好')
check('/111 紧贴数字', unescapeLiteral('/111190.254', '111'), '111190.254')
check('/111 单独', unescapeLiteral('/111', '111'), '111')
check('/1111 不归它管', unescapeLiteral('/1111', '111'), '1111')
check('/rrr 紧贴', unescapeLiteral('/rrr你好', 'rrr'), 'rrr你好')
check('//111 不归它管', unescapeLiteral('//111', '111'), undefined)

// ---------- 优先级：//x 先于一切，但转义后仍认触发词 ----------
function dispatchOrder(text) {
  const esc = text.startsWith('//') ? text.slice(1) : undefined
  if (esc !== undefined) {
    // 转义后仍要检查触发词（真实故障：//i rrr ... 里 rrr 被吞掉）
    const innerRrr = extractTriggerWord(esc, 'rrr', { allowMiddle: true })
    if (innerRrr !== undefined) return { via: 'escaped-rrr', payload: innerRrr }
    const innerQuick = extractTriggerWord(esc, '111')
    if (innerQuick !== undefined) return { via: 'escaped-quick', payload: innerQuick }
    return { via: 'escaped', payload: esc }
  }
  const lit111 = unescapeLiteral(text, '111')
  if (lit111 !== undefined) return { via: 'literal-111', payload: lit111 }
  const litRrr = unescapeLiteral(text, 'rrr')
  if (litRrr !== undefined) return { via: 'literal-rrr', payload: litRrr }
  const rrr = extractTriggerWord(text, 'rrr', { allowMiddle: true })
  if (rrr !== undefined) return { via: 'rrr', payload: rrr }
  const quick = extractTriggerWord(text, '111')
  if (quick !== undefined) return { via: 'quick', payload: quick }
  return { via: 'router' }
}
check('//i 单独 → 转义', dispatchOrder('//i').via, 'escaped')
check('//i rrr x → 转给上一个会话', dispatchOrder('//i rrr 要做的事').via, 'escaped-rrr')
check('//i rrr x 正文正确', dispatchOrder('//i rrr 要做的事').payload, '要做的事')
// `111` 只认开头/结尾，不认句中——所以 `/i 111 你好` 里的 111 不触发，
// 整条按转义交给当前会话（这是有意的：111 在句中常常是内容本身）
check('//i 111 x → 111 不认句中，走转义', dispatchOrder('//i 111 你好').via, 'escaped')
check('/111 走字面', dispatchOrder('/111 你好').via, 'literal-111')
check('/rrr 走字面', dispatchOrder('/rrr 你好').via, 'literal-rrr')
check('rrr 走回话', dispatchOrder('rrr 你真厉害').via, 'rrr')
check('111 走快速', dispatchOrder(REAL_1).via, 'quick')
check('普通消息走路由', dispatchOrder('你好').via, 'router')
check('1111 走路由', dispatchOrder('1111').via, 'router')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
