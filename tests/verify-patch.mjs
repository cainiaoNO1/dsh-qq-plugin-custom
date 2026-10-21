/**
 * 验证本地补丁：带工具调用的 attempt 不发送，只有干净收尾才发。
 *
 * 直接模拟 runtime 的 #replies 缓冲逻辑（与 runtime.js 中同一套判据），
 * 因为完整 runtime 需要宿主组合才能实例化。
 */

// ---- 复刻补丁后的缓冲判定逻辑 ----
function makeHarness() {
  const sent = []
  let entry // 模拟 this.#replies.get(sessionId)

  function frame({ text, completed, toolCall }) {
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
      const finalText = e.text.slice(e.narrationLen)
      entry = e
      // flush(overrideText)
      const t = (finalText.trim() === '' ? e.text : finalText).trim()
      entry = undefined
      if (t !== '') sent.push(t)
      return
    }
    entry = e
  }
  return { frame, sent, reset: () => { entry = undefined } }
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---- 用例 1：多 attempt + 工具调用，只有一条最终结果 ----
{
  const h = makeHarness()
  // attempt 1: 旁白 + 工具调用
  h.frame({ text: '工作区只有 14 个文件有变更。', completed: false })
  h.frame({ toolCall: { id: 't1', name: 'bash' } })
  h.frame({ completed: true })
  // attempt 2: 旁白 + 工具调用
  h.frame({ text: '第 1 次提交完成。继续第 2 次提交。', completed: false })
  h.frame({ toolCall: { id: 't2', name: 'bash' } })
  h.frame({ completed: true })
  // attempt 3: 真正的收尾，无工具
  h.frame({ text: '全部 7 次提交已完成。', completed: false })
  h.frame({ completed: true })

  check('多 attempt 只发一条', h.sent.length, 1)
  check('只发最终收尾内容', h.sent[0], '全部 7 次提交已完成。')
}

// ---- 用例 2：单次纯对话（无工具）应正常发送 ----
{
  const h = makeHarness()
  h.frame({ text: '你好，有什么可以帮你？', completed: false })
  h.frame({ completed: true })
  check('纯对话正常发送', h.sent.length, 1)
  check('纯对话内容正确', h.sent[0], '你好，有什么可以帮你？')
}

// ---- 用例 3：工具调用后收尾 attempt 无正文 -> 退回发全部（不丢答案）----
{
  const h = makeHarness()
  h.frame({ text: '先查一下。', completed: false })
  h.frame({ toolCall: { id: 't1', name: 'bash' } })
  h.frame({ completed: true })
  h.frame({ completed: true }) // 收尾 attempt 无任何正文
  check('无正文收尾不丢内容', h.sent.length, 1)
  check('退回发累积正文', h.sent[0], '先查一下。')
}

// ---- 用例 4：sawTool 必须在每个 end 后复位 ----
{
  const h = makeHarness()
  h.frame({ toolCall: { id: 't1', name: 'bash' } })
  h.frame({ completed: true })
  // 第二轮干净收尾，不应因为上一轮的 sawTool 而漏发
  h.frame({ text: '结果如下。', completed: false })
  h.frame({ completed: true })
  check('sawTool 已复位', h.sent.length, 1)
  check('第二轮正常发送', h.sent[0], '结果如下。')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
