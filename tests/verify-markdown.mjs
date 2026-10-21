/**
 * 验证 Markdown → 纯文本转换。
 *
 * 输入取自用户真实截图里那段回复（QQ 上显示成一堆井号和竖线）。
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
const { markdownToPlain, hasMarkdown } =
  await import(`${pathToFileURL(PLUGIN).href}/lib/plain-text.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}
function noMarkup(text) {
  return !/^#{1,6}\s|^\s*\||\*\*|`{3}|^\s*[-*+]\s/m.test(text)
}

// ---------- 真实截图里的那段 ----------
const real = `178/178 全部通过。

## 实现内容

目标会话正在运行任务时，不再自动插入，改为让你选择。

### 四个选项

| 回复 | 行为 |
|---|---|
| \`1\` | 插入：打断当前任务，立刻看到这句话 |
| \`2\` | 排队：等这一轮跑完再处理 |

### 触发点

四个入口都会检查：

- 普通消息（当前绑定会话）
- \`111 问题\`
- \`rrr 你的话\`

**1. 忙碌判定用宿主的实时状态**
\`sessionController.list()\` 的每一项带 \`running\` 字段。`

{
  const out = markdownToPlain(real)
  console.log('--- 转换结果 ---')
  console.log(out)
  console.log('--- 结束 ---\n')

  check('标题变成【】', out.includes('【实现内容】'), true)
  check('三级标题用 ▸', out.includes('▸ 四个选项'), true)
  check('无井号残留', out.includes('##'), false)
  check('无星号残留', out.includes('**'), false)
  check('无表格竖线残留', /^\|/m.test(out), false)
  check('表格变成中点行', out.includes('回复 · 行为'), true)
  check('无序列表用·', out.includes('· 普通消息（当前绑定会话）'), true)
  check('行内代码去反引号', out.includes('1'), true)
  check('整体无标记', noMarkup(out), true)
  check('内容未丢失', out.includes('178/178 全部通过。'), true)
}

// ---------- 边界 ----------
check('空串', markdownToPlain(''), '')
check('非字符串', markdownToPlain(null), '')
check('纯文本原样', markdownToPlain('你好世界'), '你好世界')
check('粗体', markdownToPlain('这是 **重点** 内容'), '这是 重点 内容')
check('斜体', markdownToPlain('这是 *斜体* 字'), '这是 斜体 字')
check('删除线', markdownToPlain('~~删掉~~'), '删掉')
check('行内代码', markdownToPlain('用 `npm test` 跑'), '用 npm test 跑')
check('链接', markdownToPlain('[文档](https://x.com)'), '文档 (https://x.com)')
check('图片', markdownToPlain('![截图](a.png)'), '［图片：截图］')
check('分隔线', markdownToPlain('---'), '────────')
check('引用', markdownToPlain('> 注意'), '｜注意')
check('有序列表', markdownToPlain('1. 第一步'), '1. 第一步')

// ---------- 代码块原样保留 ----------
{
  const code = '```js\nconst a = **not bold**\n```'
  const out = markdownToPlain(code)
  check('代码块保留内容', out.includes('const a = **not bold**'), true)
  check('代码块去掉围栏', out.includes('```'), false)
  check('代码块标语言', out.includes('【js】'), true)
}

// ---------- 行内代码里的星号不被当粗体 ----------
check('行内代码保护', markdownToPlain('`a**b**c`'), 'a**b**c')

// ---------- hasMarkdown ----------
check('hasMarkdown 标题', hasMarkdown('# 标题'), true)
check('hasMarkdown 粗体', hasMarkdown('**x**'), true)
check('hasMarkdown 表格', hasMarkdown('| a | b |'), true)
check('hasMarkdown 列表', hasMarkdown('- x'), true)
check('hasMarkdown 代码块', hasMarkdown('```js'), true)
check('hasMarkdown 纯文本', hasMarkdown('你好世界'), false)
check('hasMarkdown 空串', hasMarkdown(''), false)
check('hasMarkdown 带数字', hasMarkdown('178/178 通过'), false)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
