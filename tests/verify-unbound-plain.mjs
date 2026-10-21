/**
 * 验证 notifyAllSessions 与 notify_qq 的 Markdown 转纯文本处理。
 *
 * 真实故障：截图显示「直接打开 F:\code\rea... ### 本轮完成与交付内容 1. **Server 闪退彻底根治**」，
 * 虽然设置了 markdownMode: 'plain'，但旧实现仅在当前绑定会话的 #sendReply 里做了转换；
 * 跨会话推送（notifyAllSessions #forwardUnbound）以及 notify_qq 之前直接发送了未转化的原始 Markdown。
 */

import { pathToFileURL } from 'node:url'
// 统一指向本仓库根目录的插件源码
const { join, dirname } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(here, '..').replace(/\\/g, '/')
const { markdownToPlain, hasMarkdown } = await import(`${pathToFileURL(PLUGIN).href}/lib/plain-text.js`)
const { planReply } = await import(`${pathToFileURL(PLUGIN).href}/lib/reply-limit.js`)

let pass = 0, fail = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    期望 ${e}\n    实际 ${a}`) }
}

const sample = `直接打开 \`F:\\code\\rea\\Radmin\\public\\Viewer\\Radmin.Viewer.exe\` 和 \`Server\\Radmin.Server.exe\` 即可开始手动调试。

---

### 本轮完成与交付内容

1. **Server 闪退彻底根治**:
  - 补齐了 \`DispatcherUnhandledException\` 和 \`TaskScheduler.UnobservedTaskException\` 全局异常兜底。`

// 1. 模拟 #forwardUnbound 的新逻辑
function forwardUnboundProcess(finalText, question, settings) {
  const plan = planReply(finalText, settings.maxReplyChars)
  if (plan.kind === 'file') {
    return {
      type: 'file',
      caption: question === '' ? plan.caption : `${question}\n--------------------\n${plan.caption}`,
      text: plan.text,
    }
  }
  // renderForQq
  const mode = settings.markdownMode
  let rendered = plan.text
  if (mode === 'plain') {
    rendered = hasMarkdown(plan.text) ? markdownToPlain(plan.text) : plan.text
  } else if (mode === 'file') {
    rendered = hasMarkdown(plan.text) ? undefined : plan.text
  }

  if (rendered === undefined) {
    return {
      type: 'file',
      caption: question === '' ? '回复含格式，已作为 .md 文件发送。' : `${question}\n--------------------\n回复含格式，已作为 .md 文件发送。`,
      text: plan.text,
    }
  }

  return {
    type: 'text',
    body: question === '' ? rendered : `${question}\n--------------------\n${rendered}`,
  }
}

// Case 1: 默认 plain 模式，短文本转换为纯文本
{
  const res = forwardUnboundProcess(sample, '编译 Radmin', { maxReplyChars: 4000, markdownMode: 'plain' })
  check('类型为 text', res.type, 'text')
  check('去除了 ###', res.body.includes('###'), false)
  check('去除了 **', res.body.includes('**'), false)
  check('去除了反引号', res.body.includes('`'), false)
  check('包含转换后的标题符号', res.body.includes('▸ 本轮完成与交付内容'), true)
  check('带上提问与分隔线', res.body.startsWith('编译 Radmin\n--------------------\n'), true)
}

// Case 2: raw 模式，保持原始 Markdown
{
  const res = forwardUnboundProcess(sample, '', { maxReplyChars: 4000, markdownMode: 'raw' })
  check('raw 模式保留 ###', res.body.includes('### 本轮完成与交付内容'), true)
}

// Case 3: 超长文本自动转为 file
{
  const longText = 'a'.repeat(5000)
  const res = forwardUnboundProcess(longText, '长任务', { maxReplyChars: 4000, markdownMode: 'plain' })
  check('超长自动降级为 file', res.type, 'file')
  check('caption 包含提问', res.caption.startsWith('长任务\n--------------------\n'), true)
}

// Case 4: notify_qq tool 发送时的转换
function notifyToolProcess(text, settings) {
  return settings.markdownMode === 'plain' && hasMarkdown(text)
    ? markdownToPlain(text)
    : text
}

{
  const textWithMd = '最新版（第十版）**全量发布**！\n- 修复了闪退\n- 增加了新特性'
  const out = notifyToolProcess(textWithMd, { markdownMode: 'plain' })
  check('notify_qq 去除 **', out.includes('**'), false)
  check('notify_qq 列表变成点', out.includes('· 修复了闪退'), true)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
