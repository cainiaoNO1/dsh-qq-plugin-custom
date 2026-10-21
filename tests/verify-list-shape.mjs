/**
 * 验证 #listSessionsSafe：兼容宿主的参数顺序与返回形状。
 *
 * 真实故障：`list` 签名是 `list(_request, signal)`，原来只传了 signal，
 * 宿主返回了别的形状，`/run` 回一句「格式不对」——功能整个不可用。
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---- 复刻 #listSessionsSafe ----
async function listSessionsSafe(controller) {
  let result
  try {
    result = await controller.list({}, new AbortController().signal)
  } catch {
    try {
      result = await controller.list(new AbortController().signal)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.sessions)) return result.sessions
  if (Array.isArray(result?.items)) return result.items
  return undefined
}

const ROWS = [{ sessionId: 'a', running: true }, { sessionId: 'b', running: false }]

// ---- 1. 标准形状：直接返回数组 ----
{
  const c = { list: async () => ROWS }
  check('直接数组', await listSessionsSafe(c), ROWS)
}

// ---- 2. 包装形状：{ sessions: [...] } ----
{
  const c = { list: async () => ({ sessions: ROWS }) }
  check('sessions 包装', await listSessionsSafe(c), ROWS)
}

// ---- 3. 包装形状：{ items: [...] } ----
{
  const c = { list: async () => ({ items: ROWS }) }
  check('items 包装', await listSessionsSafe(c), ROWS)
}

// ---- 4. 老签名：只接受 signal ----
{
  // 第一个参数不是 signal 时抛错，模拟老宿主
  const c = {
    list: async (arg) => {
      if (arg instanceof AbortSignal || arg === undefined) return ROWS
      throw new Error('bad request shape')
    },
  }
  check('回退到单参数', await listSessionsSafe(c), ROWS)
}

// ---- 5. 完全失败 ----
{
  const c = { list: async () => { throw new Error('boom') } }
  check('两次都失败 → undefined', await listSessionsSafe(c), undefined)
}

// ---- 6. 不认识的形状 ----
{
  const c = { list: async () => ({ weird: true }) }
  check('未知形状 → undefined', await listSessionsSafe(c), undefined)
}
{
  const c = { list: async () => null }
  check('null → undefined', await listSessionsSafe(c), undefined)
}
{
  const c = { list: async () => 'string' }
  check('字符串 → undefined', await listSessionsSafe(c), undefined)
}

// ---- 7. 空数组是合法结果 ----
{
  const c = { list: async () => [] }
  check('空数组合法', await listSessionsSafe(c), [])
}

// ---- 8. 参数顺序验证：新签名能收到两个参数 ----
{
  let received
  const c = {
    list: async (...args) => {
      received = args
      return ROWS
    },
  }
  await listSessionsSafe(c)
  check('传了两个参数', received.length, 2)
  check('第一个是对象', typeof received[0], 'object')
  check('第二个是 signal', received[1] instanceof AbortSignal, true)
}

// ---- 9. 反证：只传 signal 时新宿主会返回错形状 ----
{
  // 模拟真实宿主：第一个参数被当成 request，signal 变成 undefined
  const hostLike = {
    list: async (request, signal) => {
      // 真实实现会读 request 里的字段；收到 AbortSignal 时返回一个非数组
      if (signal === undefined) return { kind: 'bad-request' }
      return ROWS
    },
  }
  // 旧写法：只传 signal
  const oldWay = await hostLike.list(new AbortController().signal)
  check('反证：旧写法拿到非数组', Array.isArray(oldWay), false)
  // 新写法：经 listSessionsSafe
  check('新写法拿到数组', await listSessionsSafe(hostLike), ROWS)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
