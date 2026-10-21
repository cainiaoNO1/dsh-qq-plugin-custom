/**
 * 验证 stream-frame 修复：tool-call 信号是否真的被识别。
 *
 * 这是之前失效的根源——原代码要求 tool-call-delta 带 name，而宿主不给 name，
 * 于是 toolCall 从未被设置，所有依赖它的判据全部空转。
 */

import { pathToFileURL } from 'node:url'
// 可移植：优先用 build\（补丁应用后的产物），回退到本机已部署的插件。
const { existsSync } = await import('node:fs')
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const buildDir = join(here, '..', 'build')
const PLUGIN = existsSync(buildDir)
  ? buildDir.replace(/\\/g, '/')
  : join(process.env.USERPROFILE ?? '', '.dsh/profiles/web/node_modules/dsh-qq-plugin').replace(/\\/g, '/')
const { readStreamFrame } = await import(`${pathToFileURL(PLUGIN).href}/lib/stream-frame.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

const SID = 'session-abc'
const payload = (chunk) => ({ agent: { session: { id: SID } }, frame: { type: 'chunk', chunk } })

// ---------- 核心回归：tool-call-delta 不带 name 也必须识别 ----------
{
  const f = readStreamFrame(payload({ type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"a":1}' }))
  check('tool-call-delta 无 name 也识别', f.toolCall !== undefined, true)
  check('保留 id', f.toolCall?.id, 'call_1')
  check('name 缺失时留空', f.toolCall?.name, undefined)
}

// ---------- 带 name 时保留 ----------
{
  const f = readStreamFrame(payload({ type: 'tool-call-delta', index: 0, id: 'c2', name: 'bash', argumentsDelta: '{}' }))
  check('带 name 时保留', f.toolCall?.name, 'bash')
}

// ---------- 空 id 不算工具调用 ----------
{
  const f = readStreamFrame(payload({ type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '' }))
  check('空 id 不算', f.toolCall, undefined)
}

// ---------- block-start + blockType:'tool-call' 是更早的信号 ----------
{
  const f = readStreamFrame(payload({ type: 'block-start', index: 0, blockType: 'tool-call' }))
  check('block-start tool-call 识别', f.toolCall !== undefined, true)
}

// ---------- block-start 的 text/reasoning 不是工具调用 ----------
{
  check('block-start text 不算', readStreamFrame(payload({ type: 'block-start', index: 0, blockType: 'text' })).toolCall, undefined)
  check('block-start reasoning 不算', readStreamFrame(payload({ type: 'block-start', index: 1, blockType: 'reasoning' })).toolCall, undefined)
}

// ---------- 文本帧不带 toolCall ----------
{
  const f = readStreamFrame(payload({ type: 'text-delta', index: 0, text: '你好' }))
  check('text-delta 有正文', f.text, '你好')
  check('text-delta 无 toolCall', f.toolCall, undefined)
}

// ---------- end 帧 ----------
{
  const f = readStreamFrame({ agent: { session: { id: SID } }, frame: { type: 'end' } })
  check('end 帧 completed', f.completed, true)
}

// ---------- start 帧不产生噪音 ----------
{
  const f = readStreamFrame({ agent: { session: { id: SID } }, frame: { type: 'start' } })
  check('start 帧无 frameShape 告警', f.frameShape, undefined)
  check('start 帧无正文', f.text, undefined)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
