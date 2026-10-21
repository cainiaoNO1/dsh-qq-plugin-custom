/**
 * 端到端：用真实的 readStreamFrame + 补丁后的缓冲逻辑，
 * 模拟一个"多次工具调用 + 过程旁白"的任务，确认只发一条最终结果。
 *
 * 这是对上一轮失效的复查：之前 toolCall 恒为 undefined，导致 sawTool 永不置位，
 * 旁白全部漏出。这里用真实解析器验证修复后确实拦住了。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { readStreamFrame } = await import(`${pathToFileURL(PLUGIN).href}/lib/stream-frame.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

const SID = 'session-test'
const sent = []
let entry

/** 复刻 runtime.js 补丁后的 #replies 判定。 */
function onFrame(rawPayload) {
  const { text, completed, toolCall } = readStreamFrame(rawPayload)
  // 与 runtime.js 同一条放行规则：带 toolCall 的帧也必须进来。
  const hasToolCall = toolCall !== undefined
  if ((text === undefined || text === '') && completed !== true && !hasToolCall) return
  const e = entry ?? { text: '', sawTool: false, narrationLen: 0 }
  if (text !== undefined) e.text += text
  if (toolCall !== undefined) e.sawTool = true

  if (completed === true) {
    if (e.sawTool === true) {
      e.narrationLen = e.text.length
      e.sawTool = false
      entry = e
      return
    }
    entry = undefined
    const finalText = e.text.slice(e.narrationLen).trim()
    if (finalText !== '') sent.push(finalText)
    return
  }
  entry = e
}

const chunk = (c) => ({ agent: { session: { id: SID } }, frame: { type: 'chunk', chunk: c } })
const end = () => ({ agent: { session: { id: SID } }, frame: { type: 'end' } })
const start = () => ({ agent: { session: { id: SID } }, frame: { type: 'start' } })

// ---- attempt 1: 旁白 + 工具调用 ----
onFrame(start())
onFrame(chunk({ type: 'text-delta', index: 0, text: '改动点已经明确。我先查看 notify_qq 的跨会话推送路径。' }))
onFrame(chunk({ type: 'block-start', index: 1, blockType: 'tool-call' }))
onFrame(chunk({ type: 'tool-call-delta', index: 1, id: 'call_1', argumentsDelta: '{"path":"x"}' }))
onFrame(chunk({ type: 'block-end', index: 1 }))
onFrame(end())

// ---- attempt 2: 旁白 + 工具调用 ----
onFrame(start())
onFrame(chunk({ type: 'text-delta', index: 0, text: '现在结构已经清楚。我要做四件事：新增设置项、修改流处理逻辑。' }))
onFrame(chunk({ type: 'block-start', index: 1, blockType: 'tool-call' }))
onFrame(chunk({ type: 'tool-call-delta', index: 1, id: 'call_2', argumentsDelta: '{}' }))
onFrame(end())

// ---- attempt 3: 旁白 + 工具调用 ----
onFrame(start())
onFrame(chunk({ type: 'text-delta', index: 0, text: '结构完全清楚了。现在开始改造，第一步是添加设置项。' }))
onFrame(chunk({ type: 'block-start', index: 1, blockType: 'tool-call' }))
onFrame(chunk({ type: 'tool-call-delta', index: 1, id: 'call_3', argumentsDelta: '{}' }))
onFrame(end())

// ---- attempt 4: 真收尾，无工具 ----
onFrame(start())
onFrame(chunk({ type: 'text-delta', index: 0, text: '改造完成：新增 notifyAllSessions 开关，可在 QQ 里用 /notify on 切换。' }))
onFrame(end())

check('只发一条', sent.length, 1)
check('只发最终结果', sent[0], '改造完成：新增 notifyAllSessions 开关，可在 QQ 里用 /notify on 切换。')
check('旁白全部被拦', sent.some((t) => t.includes('改动点已经明确')), false)
check('无旁白残留', sent.some((t) => t.includes('结构完全清楚')), false)

// ---- 反证：旧解析器会漏出旁白（说明测试确实在测这个 bug）----
{
  // 模拟旧行为：tool-call-delta 必须带 name 才认
  let oldEntry
  const oldSent = []
  function oldOnFrame(p) {
    const { text, completed, toolCall } = readStreamFrame(p)
    // 旧解析器等价物：只有带 name 才算
    const oldTool = toolCall !== undefined && toolCall.name !== undefined
    if ((text === undefined || text === '') && completed !== true) return
    const e = oldEntry ?? { text: '', sawTool: false, narrationLen: 0 }
    if (text !== undefined) e.text += text
    if (oldTool) e.sawTool = true
    if (completed === true) {
      if (e.sawTool === true) { e.narrationLen = e.text.length; e.sawTool = false; oldEntry = e; return }
      oldEntry = undefined
      const t = e.text.slice(e.narrationLen).trim()
      if (t !== '') oldSent.push(t)
      return
    }
    oldEntry = e
  }
  oldOnFrame(chunk({ type: 'text-delta', index: 0, text: '我先看一下。' }))
  oldOnFrame(chunk({ type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{}' }))
  oldOnFrame(end())
  check('反证：旧判据会漏出旁白', oldSent.length, 1)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
