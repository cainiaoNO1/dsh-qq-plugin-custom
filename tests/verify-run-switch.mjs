/**
 * 验证 /run <序号> 切换，以及切换后补发最后一次提问。
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---- 1. 命令解析 ----
function parseRun(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  const match = /^\/run(?:\s+(\S+))?$/.exec(raw.toLowerCase())
  return match === null ? null : { arg: match[1] }
}
check('/run 无参数', parseRun('/run'), { arg: undefined })
check('/run 1', parseRun('/run 1'), { arg: '1' })
check('/run 12', parseRun('/run 12'), { arg: '12' })
check('/run  3 多空格', parseRun('/run  3'), { arg: '3' })
check('/RUN 2 大写', parseRun('/RUN 2'), { arg: '2' })
check('/runs 不匹配', parseRun('/runs'), null)
// `/run all` 会被解析成 arg='all'，随后落到"看不懂"分支（不是静默当列表）。
check('/run all 解析成参数', parseRun('/run all'), { arg: 'all' })
check('/run all 非数字', /^\d+$/.test('all'), false)
check('/run 1 2 不匹配', parseRun('/run 1 2'), null)
check('普通文本', parseRun('run'), null)

// ---- 2. 越界索引规则 ----
// 1 基编号；0 与超界都落到最后一个
function resolveIndex(requested, total) {
  return requested >= 1 && requested <= total ? requested - 1 : total - 1
}
check('总数 2，请求 1 → 索引 0', resolveIndex(1, 2), 0)
check('总数 2，请求 2 → 索引 1', resolveIndex(2, 2), 1)
check('总数 2，请求 0 → 索引 1', resolveIndex(0, 2), 1)
check('总数 2，请求 3 → 索引 1', resolveIndex(3, 2), 1)
check('总数 2，请求 6 → 索引 1', resolveIndex(6, 2), 1)
check('总数 1，请求 1 → 索引 0', resolveIndex(1, 1), 0)
check('总数 1，请求 0 → 索引 0', resolveIndex(0, 1), 0)
check('总数 1，请求 99 → 索引 0', resolveIndex(99, 1), 0)
check('总数 5，请求 3 → 索引 2', resolveIndex(3, 5), 2)
check('总数 5，请求 5 → 索引 4', resolveIndex(5, 5), 4)
check('总数 5，请求 6 → 索引 4', resolveIndex(6, 5), 4)

// ---- 3. 非法参数 ----
function checkArg(arg) {
  if (arg === undefined) return 'list'
  if (!/^\d+$/.test(arg)) return 'invalid'
  return 'switch'
}
check('无参数 → 列表', checkArg(undefined), 'list')
check('数字 → 切换', checkArg('3'), 'switch')
check('字母 → 报错', checkArg('abc'), 'invalid')
check('负数 → 报错', checkArg('-1'), 'invalid')
check('小数 → 报错', checkArg('1.5'), 'invalid')

// ---- 4. 切换后补发提问的判断 ----
function shouldSendPrompt(replyText) {
  if (typeof replyText !== 'string') return false
  return /^(已切换到|已新建对话)/.test(replyText)
}
check('已切换到 → 补发', shouldSendPrompt('已切换到「某会话」。\nabc123'), true)
check('已新建对话 → 补发', shouldSendPrompt('已新建对话「新会话」。\nabc123'), true)
check('其它回复 → 不补发', shouldSendPrompt('当前对话「QQ」\nabc123'), false)
check('列表回复 → 不补发', shouldSendPrompt('【ym-demo】会话（1/1）'), false)
check('空串 → 不补发', shouldSendPrompt(''), false)
check('非字符串 → 不补发', shouldSendPrompt(null), false)

// ---- 5. 补发文案形态 ----
function renderPrompt(prompt, elapsedMs, isRunning = true, relativeTimeStr = '') {
  let timeStr = ''
  if (isRunning && elapsedMs !== undefined) {
    timeStr = `（已运行 ${formatDur(elapsedMs)}）`
  } else if (!isRunning && relativeTimeStr !== '') {
    timeStr = `（提问于 ${relativeTimeStr}）`
  }
  return `这个会话最后一次提问${timeStr}：\n${prompt}`
}
function formatDur(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${seconds} 秒`
}
check(
  '运行中带时长',
  renderPrompt('重构代码', 750000, true),
  '这个会话最后一次提问（已运行 12 分 30 秒）：\n重构代码',
)
check(
  '非运行带相对时间',
  renderPrompt('遍历代码', undefined, false, '2 小时前'),
  '这个会话最后一次提问（提问于 2 小时前）：\n遍历代码',
)
check('无时间', renderPrompt('重构代码', undefined), '这个会话最后一次提问：\n重构代码')
check('新会话暂无提问', renderPrompt('（新会话，暂无提问）', undefined), '这个会话最后一次提问：\n（新会话，暂无提问）')

// ---- 6. /run 切换的确认文案 ----
function renderSwitch(index, total, item) {
  const elapsed = item.elapsedMs === undefined ? '开始时间未知' : `已运行 ${formatDur(item.elapsedMs)}`
  return [
    `已切到第 ${index + 1}/${total} 个：${item.workspace}`,
    elapsed,
    '',
    '最后一次提问：',
    item.prompt || item.title || '（内容未知）',
  ].join('\n')
}
check(
  '标准切换文案',
  renderSwitch(0, 2, { workspace: 'proj', elapsedMs: 5000, prompt: '问题A' }),
  '已切到第 1/2 个：proj\n已运行 5 秒\n\n最后一次提问：\n问题A',
)
check(
  '越界切到末尾',
  renderSwitch(1, 2, { workspace: 'b', elapsedMs: undefined, prompt: 'x' }),
  '已切到第 2/2 个：b\n开始时间未知\n\n最后一次提问：\nx',
)

// ---- 7. 排序不变 ----
function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.elapsedMs === undefined && b.elapsedMs === undefined) return 0
    if (a.elapsedMs === undefined) return 1
    if (b.elapsedMs === undefined) return -1
    return b.elapsedMs - a.elapsedMs
  })
}
{
  const sorted = sortItems([
    { id: 'short', elapsedMs: 1000 },
    { id: 'long', elapsedMs: 9000 },
  ])
  check('/run 1 是最久的', sorted[0].id, 'long')
  check('/run 2 是次久的', sorted[1].id, 'short')
  check('越界切到末尾=最短', sorted[sorted.length - 1].id, 'short')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
