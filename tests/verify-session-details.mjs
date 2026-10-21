/**
 * 验证 session-index.js 的 readStoredSessionDetails 与投影缓存读取。
 */
import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { readStoredSessionDetails } = await import(`${pathToFileURL(PLUGIN).href}/lib/session-index.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

const home = process.env.DSH_HOME ?? 'C:/Users/yuanmingjie/.dsh'

// 真实存在的会话
const details = await readStoredSessionDetails(home, 'session-13d41b6d-ecdf-416e-84bb-2ed56aec01aa')
check('能读到历史提问', typeof details?.lastPrompt, 'string')
check('提问内容正确', details?.lastPrompt, '手动验证成功了，现在可以了')
check('能读到时间戳', typeof details?.lastPromptAt, 'number')
check('时间戳非 0', details?.lastPromptAt > 0, true)
check('能读到标题', typeof details?.title, 'string')

// 不存在的会话
const missing = await readStoredSessionDetails(home, 'session-nonexistent-12345')
check('不存在的会话返回空字段对象', missing, {
  title: '',
  cwd: '',
  updatedAt: 0,
  lastPrompt: '',
  lastPromptAt: undefined,
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
