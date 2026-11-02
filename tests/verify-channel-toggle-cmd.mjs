/**
 * 验证：
 * 1. QQ 端 /start 与 /stop 指令识别与通道开关控制
 * 2. 通道关闭状态下拦截其他消息（避免无意打扰），发送 /start 随时重新开启
 * 3. 通道状态持久化逻辑（state.autoStart === false 时重启不自启）
 */

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

function parseChannelCommand(text) {
  if (typeof text !== 'string') return undefined
  const clean = text.trim()
  if (/^(?:\/|\/\/)?start$/i.test(clean) || ['开启通道', '打开通道', '开启远程', '打开远程'].includes(clean)) {
    return 'start'
  }
  if (/^(?:\/|\/\/)?stop$/i.test(clean) || ['关闭通道', '关掉通道', '关闭远程', '关掉远程'].includes(clean)) {
    return 'stop'
  }
  return undefined
}

// ---- 1. 命令解析 ----
check('/start 指令', parseChannelCommand('/start'), 'start')
check('//start 指令', parseChannelCommand('//start'), 'start')
check('/START 大写', parseChannelCommand('/START'), 'start')
check('开启通道 中文', parseChannelCommand('开启通道'), 'start')
check('打开远程 中文', parseChannelCommand('打开远程'), 'start')

check('/stop 指令', parseChannelCommand('/stop'), 'stop')
check('//stop 指令', parseChannelCommand('//stop'), 'stop')
check('/STOP 大写', parseChannelCommand('/STOP'), 'stop')
check('关闭通道 中文', parseChannelCommand('关闭通道'), 'stop')
check('关掉远程 中文', parseChannelCommand('关掉远程'), 'stop')

check('普通消息不匹配', parseChannelCommand('你好世界'), undefined)
check('带有 start 的普通话不匹配', parseChannelCommand('start game'), undefined)
check('带有 stop 的普通话不匹配', parseChannelCommand('please stop'), undefined)
check('空消息', parseChannelCommand(''), undefined)

// ---- 2. 状态机行为模拟 ----
class FakeChannel {
  constructor(initialEnabled = true) {
    this.enabled = initialEnabled
    this.replies = []
    this.agentDelivered = []
  }

  async handleMessage(text, attachments = []) {
    const cleanText = (text ?? '').trim()
    const isStartCmd = /^(?:\/|\/\/)?start$/i.test(cleanText) || ['开启通道', '打开通道', '开启远程', '打开远程'].includes(cleanText)
    const isStopCmd = /^(?:\/|\/\/)?stop$/i.test(cleanText) || ['关闭通道', '关掉通道', '关闭远程', '关掉远程'].includes(cleanText)

    if (isStartCmd) {
      this.enabled = true
      this.replies.push('QQ 通道已开启。现在可以正常对话了。')
      return
    }

    if (isStopCmd) {
      this.enabled = false
      this.replies.push('QQ 通道已关闭。在此状态下不会执行任务，随时发送 /start 可重新开启。')
      return
    }

    if (!this.enabled) {
      this.replies.push('QQ 通道当前处于关闭状态，不处理任务。发送 /start 可重新开启。')
      return
    }

    // 开启状态：放行
    this.agentDelivered.push({ text, attachments })
  }
}

// 场景 A：开启状态收到 /stop
{
  const ch = new FakeChannel(true)
  await ch.handleMessage('/stop')
  check('开启 -> /stop -> 通道关闭', ch.enabled, false)
  check('收到关闭提示', ch.replies[0].includes('QQ 通道已关闭'), true)
  check('未交给 agent', ch.agentDelivered.length, 0)

  // 关闭状态发送普通消息
  await ch.handleMessage('帮我写一段代码')
  check('普通消息被拦截', ch.agentDelivered.length, 0)
  check('收到拦截提示', ch.replies[1].includes('当前处于关闭状态'), true)

  // 关闭状态发送图片
  await ch.handleMessage('', [{ url: 'http://img' }])
  check('图片消息被拦截', ch.agentDelivered.length, 0)
  check('收到拦截提示 2', ch.replies[2].includes('当前处于关闭状态'), true)

  // 关闭状态发送 /start 重新开启
  await ch.handleMessage('/start')
  check('关闭 -> /start -> 通道开启', ch.enabled, true)
  check('收到开启提示', ch.replies[3].includes('QQ 通道已开启'), true)

  // 开启后发送正常消息
  await ch.handleMessage('你好')
  check('正常消息成功交付给 agent', ch.agentDelivered.length, 1)
}

// ---- 3. 重启状态持久化判定优先级 ----
function resolveEnabledOnBoot(stateAutoStart, configAutoStart) {
  if (typeof stateAutoStart === 'boolean') return stateAutoStart
  return configAutoStart === true
}

check('用户设了 false，即使 config 为 true 重启也不开启', resolveEnabledOnBoot(false, true), false)
check('用户设了 true，重启依然开启', resolveEnabledOnBoot(true, true), true)
check('用户从未设置过，默认跟随 config 为 true', resolveEnabledOnBoot(undefined, true), true)
check('用户从未设置过，config 为 false 则为 false', resolveEnabledOnBoot(undefined, false), false)

// ---- 4. 通道关闭期间待发消息丢弃与排队拦截验证 ----
class DeliveryChannel {
  constructor(initialEnabled = true) {
    this.enabled = initialEnabled
    this.pendingQueue = []
    this.sentToQq = []
  }

  setEnabled(enabled) {
    this.enabled = enabled
    if (!enabled) {
      this.pendingQueue = []
    }
  }

  deliverOrQueue(text) {
    if (!this.enabled) {
      // 关闭期间直接丢弃，不发送也不排队
      return 'QQ 通道当前处于关闭状态，消息已丢弃'
    }
    // 假设正常状态下因窗口未打开而排队
    this.pendingQueue.push(text)
    return '文本已排队'
  }

  handleInbound(text) {
    const isStartCmd = /^(?:\/|\/\/)?start$/i.test(text)
    const isStopCmd = /^(?:\/|\/\/)?stop$/i.test(text)

    if (isStartCmd) {
      this.setEnabled(true)
      this.sentToQq.push('QQ 通道已开启。')
      return
    }
    if (isStopCmd) {
      this.setEnabled(false)
      this.sentToQq.push('QQ 通道已关闭。')
      return
    }
    if (!this.enabled) {
      this.sentToQq.push('QQ 通道当前处于关闭状态')
      return
    }

    // 通道开启且非控制命令：补发待发
    while (this.pendingQueue.length > 0) {
      this.sentToQq.push(`[补发] ${this.pendingQueue.shift()}`)
    }
    this.sentToQq.push(`[回复] 回答: ${text}`)
  }
}

{
  const dc = new DeliveryChannel(true)
  // 正常开启时有一条排队消息
  dc.deliverOrQueue('任务A完成')
  check('开启时消息入队', dc.pendingQueue.length, 1)

  // 用户关闭通道
  dc.handleInbound('/stop')
  check('关闭通道后历史待发队列被清空', dc.pendingQueue.length, 0)

  // 通道关闭期间，电脑上有多个任务完成尝试推送
  const res1 = dc.deliverOrQueue('任务B完成')
  const res2 = dc.deliverOrQueue('任务C完成')
  check('关闭期间投递被拒绝1', res1, 'QQ 通道当前处于关闭状态，消息已丢弃')
  check('关闭期间投递被拒绝2', res2, 'QQ 通道当前处于关闭状态，消息已丢弃')
  check('关闭期间待发队列依然为空', dc.pendingQueue.length, 0)

  // 关闭期间用户在 QQ 发消息，被拦截且不补发
  dc.handleInbound('随便问一句')
  check('关闭期间消息被拦截', dc.sentToQq[dc.sentToQq.length - 1], 'QQ 通道当前处于关闭状态')
  check('未发生任何补发', dc.sentToQq.some(m => m.includes('任务B') || m.includes('任务C')), false)

  // 用户发送 /start 重新开启
  dc.handleInbound('/start')
  check('通道重新开启', dc.enabled, true)

  // 重新开启后，用户在 QQ 发送第一次普通消息
  dc.handleInbound('现在能用了吗')
  check('正常收到回复', dc.sentToQq[dc.sentToQq.length - 1], '[回复] 回答: 现在能用了吗')
  check('开启后的第一次消息绝不包含关闭期间的消息', dc.sentToQq.some(m => m.includes('任务B') || m.includes('任务C') || m.includes('任务A')), false)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
