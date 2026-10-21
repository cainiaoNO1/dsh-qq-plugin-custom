/**
 * 完整路由顺序验证：//x、/111、111、普通消息 四种输入的分派。
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// 复刻 runtime.js #deliverPrompt 的分派顺序
function unescapeSlash(t) {
  if (typeof t !== 'string' || !t.startsWith('//')) return undefined
  return t.slice(1)
}
function unescapeLiteral111(t) {
  if (typeof t !== 'string' || !/^\/111(?:\s|$)/.test(t)) return undefined
  return t.slice(1)
}
function matches111(t) {
  const raw = typeof t === 'string' ? t.trim() : ''
  return /^111(?:\s|$)/.test(raw)
}

function dispatch(text) {
  const esc = unescapeSlash(text)
  if (esc !== undefined) return { via: 'escaped-slash', payload: esc }

  const lit = unescapeLiteral111(text)
  if (lit !== undefined) return { via: 'literal-111', payload: lit }

  if (matches111(text)) return { via: 'quick', payload: text.trim().slice(3).trim() }

  return { via: 'router', payload: text }
}

// ---- 转义斜杠：交给 DSH ----
check('//i', dispatch('//i'), { via: 'escaped-slash', payload: '/i' })
check('//i-have-adhd', dispatch('//i-have-adhd'), { via: 'escaped-slash', payload: '/i-have-adhd' })
check('//compact', dispatch('//compact'), { via: 'escaped-slash', payload: '/compact' })
check('///i 只剥一层', dispatch('///i'), { via: 'escaped-slash', payload: '//i' })

// ---- /111：字面 111 给当前会话 ----
check('/111 你好', dispatch('/111 你好'), { via: 'literal-111', payload: '111 你好' })
check('/111', dispatch('/111'), { via: 'literal-111', payload: '111' })
check('/1111 不算', dispatch('/1111 你好').via, 'router')

// ---- 111：快速通道 ----
check('111 你好', dispatch('111 你好'), { via: 'quick', payload: '你好' })
check('111 单独', dispatch('111'), { via: 'quick', payload: '' })
check('1111 不触发', dispatch('1111').via, 'router')

// ---- 普通消息 ----
check('普通', dispatch('你好'), { via: 'router', payload: '你好' })
check('/list 交给路由', dispatch('/list'), { via: 'router', payload: '/list' })

// ---- 优先级：// 最高 ----
check('//111 走转义而非字面', dispatch('//111').via, 'escaped-slash')
check('//111 payload', dispatch('//111 你好').payload, '/111 你好')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
