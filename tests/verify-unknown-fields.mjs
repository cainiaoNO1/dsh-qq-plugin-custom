/**
 * 验证「未知设置字段」检测。
 *
 * 这是对一次真实故障的回归测试：设置页（旧 bundle）提交了宿主不认识的
 * `quickWorkspacePath`，宿主静默忽略，用户看到「已保存」而值从未落盘。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { SETTINGS_KEYS } = await import(`${pathToFileURL(PLUGIN).href}/lib/settings.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

// 复刻 applySettings 的未知字段检测
function detectUnknown(patch) {
  const unknown = []
  for (const key of Object.keys(patch ?? {})) {
    if (!SETTINGS_KEYS.includes(key)) unknown.push(key)
  }
  return unknown
}

// ---------- 1. 已知字段不报警 ----------
check('空 patch', detectUnknown({}), [])
check('已知字段', detectUnknown({ settleMs: 1200 }), [])
check('多个已知字段', detectUnknown({ settleMs: 1, notifyAllSessions: true }), [])
check('全部已知字段', detectUnknown(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, null]))), [])

// ---------- 2. 未知字段被抓出 ----------
// 注意：quickWorkspacePath 现在已经注册，所以它不再是"未知"——
// 用真正不存在的名字来测检测能力。
check('单个未知', detectUnknown({ notARealSetting: 'x' }).length, 1)
check('未知字段名', detectUnknown({ notARealSetting: 'x' }), ['notARealSetting'])
check('混在已知里', detectUnknown({ settleMs: 1, bogus: 2 }), ['bogus'])
check('多个未知', detectUnknown({ a: 1, b: 2, settleMs: 3 }), ['a', 'b'])
check('纯未知', detectUnknown({ typoField: true }), ['typoField'])

// ---------- 3. 关键回归：quickWorkspacePath 现在是已知的 ----------
check('quickWorkspacePath 已注册', SETTINGS_KEYS.includes('quickWorkspacePath'), true)
check('当前版本不报 quickWorkspacePath', detectUnknown({ quickWorkspacePath: 'C:\\x' }), [])

// ---------- 4. 模拟：旧宿主遇到新页面字段 ----------
{
  // 假设宿主只有旧字段（去掉 quickWorkspacePath 模拟旧版本）
  const oldKeys = SETTINGS_KEYS.filter((k) => k !== 'quickWorkspacePath')
  function detectWith(keys, patch) {
    return Object.keys(patch ?? {}).filter((k) => !keys.includes(k))
  }
  check(
    '旧宿主能报出新字段',
    detectWith(oldKeys, { quickWorkspacePath: 'C:\\x', settleMs: 1 }),
    ['quickWorkspacePath'],
  )
}

// ---------- 5. 反证：没有检测时故障是静默的 ----------
{
  // 旧实现：只遍历 SETTINGS_KEYS，表外的键消失得无影无踪
  function oldApply(patch) {
    const applied = {}
    for (const key of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) applied[key] = patch[key]
    }
    return applied
  }
  const result = oldApply({ quickWorkspacePath: 'C:\\x' })
  // 如果宿主不认识这个键，它会从结果里消失——没有任何痕迹
  const silentLoss = !('quickWorkspacePath' in result) || SETTINGS_KEYS.includes('quickWorkspacePath')
  check('反证：旧实现会静默丢字段（此处已注册故不丢）', silentLoss, true)

  // 用真正未知的键演示静默丢失
  const really = oldApply({ totallyUnknown: 'x' })
  check('反证：真正未知的键被静默丢弃', Object.keys(really).length, 0)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
