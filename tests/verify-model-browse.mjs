/**
 * 验证 /model 浏览状态与直接回复编号/名字切换模型。
 *
 * 真实故障：/model 打印了「回复名字或编号即可切换，例如「2」」，
 * 但以前没有设置 browse: { level: 'models' }，
 * 导致用户回「30」被直接当成普通聊天文本发给 AI。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { SessionRouter, resolveModel } = await import(`${pathToFileURL(PLUGIN).href}/lib/router.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

const MODELS = [
  { provider: 'cpa', model: 'gpt-5.6', name: 'GPT 5.6', defaultLevel: undefined },
  { provider: 'cpa', model: 'claude-sonnet', name: 'Claude Sonnet', defaultLevel: undefined },
  { provider: 'cpa2', model: 'gemini-flash', name: 'Gemini Flash', defaultLevel: 'high', levels: [{ id: 'high', name: 'High' }] },
]

let selectedArgs = null
const fakeGateway = {
  listSessions: async () => [],
  listOwnSessions: async () => [],
  ensureSession: async () => {},
  listModels: async () => MODELS,
  currentModel: async () => MODELS[0],
  selectModel: async (sessionId, provider, model, level) => {
    selectedArgs = { sessionId, provider, model, level }
    return { provider, model, reasoningEffort: level }
  },
}

const fakeStore = {
  load: async () => ({
    c1: { conversationId: 'c1', sessionId: 's1', title: 'QQ' },
  }),
  save: async () => {},
  loadRouteState: async () => ({ browsing: {}, sessionLists: {} }),
  saveRouteState: async () => {},
}

const router = new SessionRouter({
  gateway: fakeGateway,
  store: fakeStore,
})

// 1. 发送 /model 必须带上 browse: { level: 'models' }
const res1 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '/model' })
check('res1 是 reply', res1.kind, 'reply')
check('带上 browse.level = models', res1.browse?.level, 'models')
check('文本含清单', res1.text.includes('GPT 5.6'), true)

// 2. 模拟 delivered 记下位置
await router.delivered('c1', res1)

// 3. 用户直接回复编号「2」切到第 2 个模型（Claude Sonnet）
const res2 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '2' })
check('res2 是 reply', res2.kind, 'reply')
check('已切换模型文案', res2.text.includes('已切换模型：cpa/claude-sonnet'), true)
check('调用了 selectModel', selectedArgs?.model, 'claude-sonnet')
check('res2 无 browse（已清空浏览态）', res2.browse, undefined)

// 4. delivered 之后位置被清空
await router.delivered('c1', res2)

// 5. 再次回复数字「2」因不在浏览态，走普通消息
const res3 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '2' })
check('不在浏览态时是 prompt', res3.kind, 'prompt')
check('prompt 内容是 2', res3.decision?.prompt, '2')

// 6. 再次 /model 之后，回复名字切换
const res4 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '/model' })
await router.delivered('c1', res4)

const res5 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: 'gemini-flash' })
check('名字切模型', res5.kind, 'reply')
check('切换到 gemini-flash', res5.text.includes('cpa2/gemini-flash'), true)
check('带推理等级', res5.text.includes('推理等级：High'), true)

// 7. /model 之后回复普通无关文本，不被拦截，落到 agent
const res6 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '/model' })
await router.delivered('c1', res6)

const res7 = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '你好呀' })
check('无关文本落到 agent', res7.kind, 'prompt')
check('prompt 正文正确', res7.decision?.prompt, '你好呀')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
