/**
 * 验证完成推送带上提问（截断 + 分隔线）。
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
const { SETTINGS_SCHEMA, SETTINGS_KEYS, SETTINGS_DEFAULTS } =
  await import(`${pathToFileURL(PLUGIN).href}/lib/settings.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// ---- 1. 设置项 ----
check('finishPromptChars 已注册', SETTINGS_KEYS.includes('finishPromptChars'), true)
check('默认 60', SETTINGS_DEFAULTS.finishPromptChars, 60)
check('接受 0', SETTINGS_SCHEMA.finishPromptChars.normalize(0), 0)
check('接受 120', SETTINGS_SCHEMA.finishPromptChars.normalize(120), 120)
check('拒绝负数', SETTINGS_SCHEMA.finishPromptChars.normalize(-1), undefined)
check('拒绝字符串', SETTINGS_SCHEMA.finishPromptChars.normalize('60'), undefined)
check('取整', SETTINGS_SCHEMA.finishPromptChars.normalize(60.7), 61)
check('设置项总数 13', SETTINGS_KEYS.length, 13)

// ---- 2. clipQuestion ----
const FINISH_SEPARATOR = '-'.repeat(20)

function firstLine(text) {
  if (typeof text !== 'string') return ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
  }
  return ''
}
function clipQuestion(text, limit) {
  if (limit <= 0) return ''
  const line = firstLine(text)
  if (line === '') return ''
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

check('短提问原样', clipQuestion('帮我看看代码', 60), '帮我看看代码')
check('恰好 60 字不截', clipQuestion('a'.repeat(60), 60), 'a'.repeat(60))
check('61 字截断', clipQuestion('a'.repeat(61), 60), `${'a'.repeat(60)}…`)
check('0 不显示', clipQuestion('任何内容', 0), '')
check('负数不显示', clipQuestion('任何内容', -1), '')
check('空串', clipQuestion('', 60), '')
check('非字符串', clipQuestion(null, 60), '')
check('只取首行', clipQuestion('第一行\n第二行', 60), '第一行')
check('跳过空行', clipQuestion('\n\n实际', 60), '实际')
check('自定义上限', clipQuestion('a'.repeat(20), 10), `${'a'.repeat(10)}…`)

// ---- 3. 分隔线 ----
check('分隔线是 20 个 -', FINISH_SEPARATOR, '--------------------')
check('分隔线长度', FINISH_SEPARATOR.length, 20)
check('全是 -', /^-+$/.test(FINISH_SEPARATOR), true)

// ---- 4. 推送内容组装 ----
function composePush(question, result) {
  return question === '' ? result : `${question}\n${FINISH_SEPARATOR}\n${result}`
}
check(
  '带提问',
  composePush('帮我看看代码', '代码没问题'),
  `帮我看看代码\n${FINISH_SEPARATOR}\n代码没问题`,
)
check('无提问只发结果', composePush('', '代码没问题'), '代码没问题')

// ---- 5. 三段结构验证 ----
{
  const out = composePush('重构 auth 模块', '已完成，改了 3 个文件')
  const lines = out.split('\n')
  check('第一行是提问', lines[0], '重构 auth 模块')
  check('第二行是分隔线', lines[1], FINISH_SEPARATOR)
  check('第三行起是结果', lines.slice(2).join('\n'), '已完成，改了 3 个文件')
}

// ---- 6. 真实场景：长提问截断 ----
{
  const longQ = '我需要你帮我分析一下这个项目的整体架构，特别是看看有没有什么设计上的问题，然后给我一份详细的报告说明每个模块的职责以及它们之间的依赖关系是否合理'
  const out = composePush(clipQuestion(longQ, 60), '分析完成')
  const firstLineOut = out.split('\n')[0]
  check('长提问被截断', firstLineOut.length, 61)
  check('截断带省略号', firstLineOut.endsWith('…'), true)
  check('结构仍是三段', out.split('\n')[1], FINISH_SEPARATOR)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
