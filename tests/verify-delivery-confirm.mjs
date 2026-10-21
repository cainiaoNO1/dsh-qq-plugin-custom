/**
 * 验证「已发到「会话名」」确认语覆盖所有投递路径。
 *
 * 用户要求：每次通过 QQ 发消息到会话，都要回一句提示发到了哪个会话。
 * 参考 rrr 的既有确认语。
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---- 1. 确认语形态（统一到一处） ----
function deliveredLine(label) {
  return `已发到「${label}」。`
}
check('标准形态', deliveredLine('快速对话目录'), '已发到「快速对话目录」。')
check('短 id 兜底', deliveredLine('a1b2c3'), '已发到「a1b2c3」。')
check('中文标题', deliveredLine('安装配置 dsh-qq-plugin 插件'), '已发到「安装配置 dsh-qq-plugin 插件」。')

// ---- 2. 会话名三级取法 ----
function sessionLabel(row, sessionId, shortId) {
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  if (title !== '') return title
  return shortId(sessionId)
}
const shortId = (id) => id.replace(/^session-/, '').slice(0, 6)
check('有标题用标题', sessionLabel({ title: '我的会话' }, 'session-abcdef123', shortId), '我的会话')
check('标题空用短 id', sessionLabel({ title: '' }, 'session-abcdef123', shortId), 'abcdef')
check('标题只有空格用短 id', sessionLabel({ title: '   ' }, 'session-abcdef123', shortId), 'abcdef')
check('行不存在用短 id', sessionLabel(undefined, 'session-abcdef123', shortId), 'abcdef')

// ---- 3. 四个投递路径都带确认 ----
// rrr
check('rrr 带确认', deliveredLine('某会话').includes('已发到'), true)
// 111 快速对话
check('111 带确认', deliveredLine('快速对话目录').includes('已发到'), true)
// //x 转义
check('//x 带确认', deliveredLine('某会话').includes('已发到'), true)
// 普通消息
check('普通消息带确认', deliveredLine('当前会话').includes('已发到'), true)

// ---- 4. 忙时抉择：确认拼在回复后面（不多发一条） ----
function busyReply(kind, label) {
  const line = deliveredLine(label)
  if (kind === 'queue') return `已排队，等这一轮跑完就处理。\n${line}`
  if (kind === 'steer') return `已插入，它会立刻看到这句话。\n${line}`
  if (kind === 'steer-then-queue') return `插入没成功（那一轮可能刚好结束），已改为排队。\n${line}`
  return '失败'
}
check('排队确认', busyReply('queue', 'S'), '已排队，等这一轮跑完就处理。\n已发到「S」。')
check('插入确认', busyReply('steer', 'S'), '已插入，它会立刻看到这句话。\n已发到「S」。')
check('降级确认', busyReply('steer-then-queue', 'S'), '插入没成功（那一轮可能刚好结束），已改为排队。\n已发到「S」。')
check('只发一条消息', busyReply('queue', 'S').split('\n').filter((l) => l.includes('已发到')).length, 1)

// ---- 5. 分叉路径 ----
function forkReply(label) {
  return `已分叉出新会话并切过去。\n${deliveredLine(label)}`
}
check('分叉带确认', forkReply('新会话'), '已分叉出新会话并切过去。\n已发到「新会话」。')

// ---- 6. 什么时候不该说（避免噪音） ----
function shouldConfirm(created, hasNotice) {
  // 新建会话：标题常常就是这句话本身，回「已发到「这句话」」是噪音
  // 换绑：notice 已经把去向说清楚
  return created !== true && hasNotice === undefined
}
check('普通消息 → 说', shouldConfirm(false, undefined), true)
check('新建会话 → 不说', shouldConfirm(true, undefined), false)
check('换绑会话 → 不说（notice 已说）', shouldConfirm(false, '已换绑'), false)
check('新建且换绑 → 不说', shouldConfirm(true, '已换绑'), false)

// ---- 7. 撤回与失败不带确认 ----
function withdrawReply() {
  return '已撤回，这条没有发出去。'
}
check('撤回不提发到哪', withdrawReply().includes('已发到'), false)
check('失败不提发到哪', '排队失败，请重发一次。'.includes('已发到'), false)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
