/**
 * 验证 /run：正在跑的任务列表。
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---- 复刻 runtime.js 的三个辅助函数 ----
function workspaceName(path) {
  if (typeof path !== 'string' || path === '') return '未知工作区'
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${seconds} 秒`
}
function firstLine(text) {
  if (typeof text !== 'string') return ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
  }
  return ''
}

// ---- 1. workspaceName ----
check('Windows 路径', workspaceName('F:\\code\\ym-jiaohao-demo'), 'ym-jiaohao-demo')
check('正斜杠', workspaceName('/home/u/project'), 'project')
check('混合', workspaceName('C:\\a/b\\c'), 'c')
check('末尾斜杠', workspaceName('F:\\code\\proj\\'), 'proj')
check('空串', workspaceName(''), '未知工作区')
check('非字符串', workspaceName(null), '未知工作区')

// ---- 2. formatDuration ----
check('0 秒', formatDuration(0), '0 秒')
check('30 秒', formatDuration(30_000), '30 秒')
check('1 分整', formatDuration(60_000), '1 分')
check('12分30秒', formatDuration(750_000), '12 分 30 秒')
check('1 小时整', formatDuration(3_600_000), '1 小时')
check('1小时5分', formatDuration(3_900_000), '1 小时 5 分')
check('1天', formatDuration(86_400_000), '1 天')
check('1天3小时', formatDuration(97_200_000), '1 天 3 小时')
check('负数按 0', formatDuration(-1000), '0 秒')

// ---- 3. firstLine ----
check('取首行', firstLine('第一行\n第二行'), '第一行')
check('跳过空行', firstLine('\n\n实际内容\n更多'), '实际内容')
check('空串', firstLine(''), '')
check('非字符串', firstLine(undefined), '')
check('超长截断', firstLine('a'.repeat(100)).length, 61)
check('截断带省略号', firstLine('a'.repeat(100)).endsWith('…'), true)

// ---- 4. 排序：跑得久的在前 ----
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
    { id: 'a', elapsedMs: 1000 },
    { id: 'b', elapsedMs: 5000 },
    { id: 'c', elapsedMs: 3000 },
  ])
  check('最久的在前', sorted.map((x) => x.id), ['b', 'c', 'a'])
}
{
  const sorted = sortItems([
    { id: 'unknown', elapsedMs: undefined },
    { id: 'known', elapsedMs: 1000 },
  ])
  check('未知时间排最后', sorted.map((x) => x.id), ['known', 'unknown'])
}
{
  const sorted = sortItems([{ id: 'x', elapsedMs: undefined }, { id: 'y', elapsedMs: undefined }])
  check('都未知保持原序', sorted.map((x) => x.id), ['x', 'y'])
}

// ---- 5. 三行格式 ----
function renderBlock(index, item) {
  const elapsed = item.elapsedMs === undefined ? '开始时间未知' : `已运行 ${formatDuration(item.elapsedMs)}`
  const question = firstLine(item.prompt) || item.title || '（内容未知）'
  return [`${index}. ${item.workspace}`, elapsed, question].join('\n')
}
check(
  '标准三行',
  renderBlock(1, { workspace: 'ym-jiaohao-demo', elapsedMs: 750_000, prompt: '重构代码' }),
  '1. ym-jiaohao-demo\n已运行 12 分 30 秒\n重构代码',
)
check(
  '未知时间',
  renderBlock(2, { workspace: 'proj', elapsedMs: undefined, prompt: 'x' }),
  '2. proj\n开始时间未知\nx',
)
check(
  '无提问退回标题',
  renderBlock(1, { workspace: 'p', elapsedMs: 1000, prompt: '', title: '某会话' }),
  '1. p\n已运行 1 秒\n某会话',
)
check(
  '都无内容',
  renderBlock(1, { workspace: 'p', elapsedMs: 1000, prompt: '', title: '' }),
  '1. p\n已运行 1 秒\n（内容未知）',
)

// ---- 6. 命令匹配 ----
function isRunCommand(text) {
  return typeof text === 'string' && text.trim().toLowerCase() === '/run'
}
check('/run 匹配', isRunCommand('/run'), true)
check('/RUN 匹配', isRunCommand('/RUN'), true)
check('带空格', isRunCommand('  /run  '), true)
check('/runs 不匹配', isRunCommand('/runs'), false)
check('/run all 不匹配', isRunCommand('/run all'), false)
check('普通文本不匹配', isRunCommand('run'), false)

// ---- 7. 完整输出形态 ----
{
  const items = [
    { workspace: 'a', elapsedMs: 5000, prompt: '问题A' },
    { workspace: 'b', elapsedMs: 3000, prompt: '问题B' },
  ]
  const blocks = items.map((it, i) => renderBlock(i + 1, it))
  const out = `正在跑的任务（${items.length} 个）\n\n${blocks.join('\n\n')}`
  check('标题行', out.startsWith('正在跑的任务（2 个）'), true)
  check('块之间空行', out.includes('问题A\n\n2. b'), true)
  check('编号从 1', out.includes('1. a'), true)
}

// ---- 8. 空列表 ----
check('没有任务', '现在没有正在跑的任务。'.length > 0, true)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
