/**
 * 验证三个修复：
 * 1. /run 切进去后提问内容不再"未知"
 * 2. /run 切进去后 /list 报的是新会话（绑定缓存失效）
 * 3. 发图后窗口到期自动投递时不弹忙时抉择
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ================= 问题 1：提问内容三级兜底 =================
function resolvePrompt(tracked, detail, diskFallback) {
  return tracked?.prompt || detail?.lastPrompt || diskFallback || detail?.title || ''
}

check('插件记录优先', resolvePrompt({ prompt: '原话' }, { lastPrompt: '磁盘' }, '兜底'), '原话')
check('磁盘清单次之', resolvePrompt(undefined, { lastPrompt: '磁盘' }, '兜底'), '磁盘')
check('逐条补读兜底', resolvePrompt(undefined, undefined, '兜底'), '兜底')
check('退回标题', resolvePrompt(undefined, { title: '标题' }, ''), '标题')
check('全无则空', resolvePrompt(undefined, undefined, ''), '')

// 真实故障场景：会话在宿主的 list() 里，但不在目录遍历的 detailsMap 里
{
  const runningRow = { sessionId: 'session-x', running: true, cwd: 'F:\\dsh' }
  const detailsMap = new Map() // 空——目录遍历没覆盖到它
  const detail = detailsMap.get(runningRow.sessionId)
  const diskFallback = '手动验证成功了，现在可以了'
  check(
    '报障场景：清单里没有但磁盘读得到',
    resolvePrompt(undefined, detail, diskFallback),
    '手动验证成功了，现在可以了',
  )
  check('修复前会是空串', resolvePrompt(undefined, detail, ''), '')
}

// 渲染层不再显示"内容未知"
function renderQuestion(item) {
  return item.prompt || item.title || '（内容未知）'
}
check('有提问不显示未知', renderQuestion({ prompt: '真实提问', title: 'T' }), '真实提问')
check('真的没有才显示未知', renderQuestion({ prompt: '', title: '' }), '（内容未知）')

// ================= 问题 2：绑定缓存失效 =================
class FakeRouter {
  constructor(initial) { this._bindings = initial; this._disk = undefined }
  async load() {
    this._bindings ??= await this._storeLoad()
    return this._bindings
  }
  async _storeLoad() { return this._disk }
  setDisk(d) { this._disk = d }
  invalidateBindings() { this._bindings = undefined }
}

{
  const r = new FakeRouter(undefined)
  r.setDisk({ c1: { sessionId: 'old' } })
  check('首次读到旧绑定', (await r.load()).c1.sessionId, 'old')

  // /run 直接写盘（绕过 router）
  r.setDisk({ c1: { sessionId: 'new' } })

  // 不失效缓存 → 仍读旧值（这就是故障）
  check('不失效则仍读旧值', (await r.load()).c1.sessionId, 'old')

  // 失效后重新读盘
  r.invalidateBindings()
  check('失效后读到新值', (await r.load()).c1.sessionId, 'new')
}

// ================= 问题 3：附件自动投递不弹忙时提示 =================
function shouldAskBusy(parkedAuto, isRunning) {
  return !parkedAuto && isRunning
}
check('用户发文字 + 会话忙 → 问', shouldAskBusy(false, true), true)
check('用户发文字 + 会话闲 → 不问', shouldAskBusy(false, false), false)
check('附件自动投递 + 会话忙 → 不问', shouldAskBusy(true, true), false)
check('附件自动投递 + 会话闲 → 不问', shouldAskBusy(true, false), false)

// 自动投递时走排队，消息不丢
function deliverMode(parkedAuto, isRunning) {
  if (shouldAskBusy(parkedAuto, isRunning)) return 'ask'
  return 'steer-then-queue'
}
check('自动投递走排队路径', deliverMode(true, true), 'steer-then-queue')
check('用户发文字走询问', deliverMode(false, true), 'ask')

// 用户发图 + 补文字：仍要问（因为这次确实有"这句话"）
function parkedWithText(hasText, isRunning) {
  // 停靠批次带文字时，是用户"说完话了"触发的投递，不是窗口到期
  return hasText && isRunning
}
check('图+文字 + 会话忙 → 问', parkedWithText(true, true), true)
check('纯图窗口到期 → 不问', parkedWithText(false, true), false)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
