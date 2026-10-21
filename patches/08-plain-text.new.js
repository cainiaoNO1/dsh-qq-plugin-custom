/**
 * Markdown → 手机上可读的纯文本。
 *
 * ## 为什么需要
 *
 * QQ 消息**不渲染 Markdown**。agent 的输出却是 Markdown（`## 标题`、`|---|` 表格、
 * `**粗体**`），于是手机上看到的是一堆井号、竖线和星号——真实故障，用户直接截了图。
 *
 * ## 取舍：为什么是"转纯文本"而不是"渲染成图片"
 *
 * 转成纯文本之后消息仍是消息：可复制、可搜索、可长按引用。
 * 渲染成图片则三样全丢，而且要引入一个图片库（这台机器上没有任何一个）。
 * 代价是**表格必然变形**——QQ 消息里没有任何方式显示表格，这不是本模块能绕开的，
 * 所以表格被转成缩进列表，读起来仍然是一条一项。
 *
 * ## 只做"去掉标记"，不做"重排版"
 *
 * 这个模块**不改写内容**：不合并段落、不重排列表、不截断。
 * 它只把 Markdown 的语法标记换成等价的纯文本记号。任何"顺手优化一下措辞"的念头
 * 都会让用户看到的与他让 agent 说的不一致，那是更糟的一种失真。
 *
 * @module dsh-qq/plain-text
 */

/**
 * 把 Markdown 转成纯文本。
 *
 * 覆盖 agent 实际会输出的那些构造：标题、粗体/斜体、行内代码、代码块、
 * 无序/有序列表、表格、引用、分隔线、链接。
 *
 * @param markdown - 原始 Markdown。
 * @returns 纯文本；输入不是字符串时返回空串。
 */
export function markdownToPlain(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out = []
  /** 代码块内部原样保留，不做任何替换。 */
  let inFence = false
  let fenceMarker = ''

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    // ---- 代码块围栏 ----
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line)
    if (fence !== null) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
        const lang = fence[2].trim()
        // 语言名留着：它在手机上是一行有用的线索（"这是 json"）。
        if (lang !== '') out.push(`【${lang}】`)
        continue
      }
      if (fence[1][0] === fenceMarker) {
        inFence = false
        fenceMarker = ''
        continue
      }
    }
    if (inFence) {
      out.push(line)
      continue
    }

    // ---- 表格：表头 + 分隔行 + 数据行 ----
    const isSeparator = /^\s*\|?[\s:-]*-[\s|:-]*$/.test(line) && line.includes('-')
    if (line.includes('|') && isSeparator && out.length > 0) {
      // 上一行是表头，已经按普通行处理过了——把它的竖线去掉重放一次。
      const header = out.pop()
      out.push(renderTableRow(header))
      continue
    }
    if (line.includes('|') && /^\s*\|/.test(line)) {
      out.push(renderTableRow(line))
      continue
    }

    // ---- 标题 ----
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const text = inline(heading[2])
      // 一级/二级用【】，其余用 ▸：手机上靠缩进和符号区分层级，比井号清楚。
      out.push(heading[1].length <= 2 ? `【${text}】` : `▸ ${text}`)
      continue
    }

    // ---- 分隔线 ----
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push('────────')
      continue
    }

    // ---- 引用 ----
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      out.push(`｜${inline(quote[1])}`)
      continue
    }

    // ---- 无序列表 ----
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      const depth = Math.floor(bullet[1].length / 2)
      out.push(`${'  '.repeat(depth)}· ${inline(bullet[2])}`)
      continue
    }

    // ---- 有序列表 ----
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      const depth = Math.floor(ordered[1].length / 2)
      out.push(`${'  '.repeat(depth)}${ordered[2]}. ${inline(ordered[3])}`)
      continue
    }

    out.push(inline(line))
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把一行表格渲染成"单元格 · 单元格"。
 *
 * QQ 里放不下对齐的列，硬对齐在窄屏上会折行折得更乱，所以用中点分隔。
 *
 * @param line - 含竖线的表格行。
 */
function renderTableRow(line) {
  const cells = line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => inline(cell.trim()))
    .filter((cell) => cell !== '')
  // 只有一个单元格时（例如被误判为表格的普通行）不加前缀，免得出现 `· · x`。
  return cells.length === 0 ? '' : cells.join(' · ')
}

/**
 * 处理行内标记：粗体、斜体、删除线、行内代码、链接、图片。
 *
 * 顺序有讲究：行内代码先处理并**占位保护**，否则 `` `a**b**c` `` 里的星号会被当成粗体。
 *
 * @param text - 一行文本。
 * @returns 去掉行内标记的文本。
 */
function inline(text) {
  if (typeof text !== 'string') return ''
  const codes = []

  let result = text
    // 行内代码：内容原样保留，只去掉反引号。
    .replace(/`([^`]+)`/g, (_match, code) => {
      codes.push(code)
      return `\u0000${codes.length - 1}\u0000`
    })
    // 图片：![alt](url) → alt（或"图片"）
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt.trim() === '' ? '［图片］' : `［图片：${alt.trim()}］`))
    // 链接：[text](url) → text (url)；text 与 url 相同就只留一份。
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
      label.trim() === url.trim() ? label.trim() : `${label.trim()} (${url.trim()})`,
    )
    // 粗体/斜体/删除线：**x** __x__ *x* _x_ ~~x~~
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')

  // 还原行内代码。
  result = result.replace(/\u0000(\d+)\u0000/g, (_m, index) => codes[Number(index)] ?? '')
  return result
}

/**
 * 这段文本里是否**真的**有 Markdown 构造。
 *
 * 用途是"没有 Markdown 就别动它"：纯文本回复原样发送，
 * 免得转换器在无关内容上产生意外改动。
 *
 * @param text - 待检查的文本。
 * @returns 是否含 Markdown 标记。
 */
export function hasMarkdown(text) {
  if (typeof text !== 'string' || text === '') return false
  return (
    /^\s{0,3}#{1,6}\s+\S/m.test(text) ||
    /^\s*```/m.test(text) ||
    /^\s*\|.*\|/m.test(text) ||
    /^\s*>\s?\S/m.test(text) ||
    /^\s*[-*+]\s+\S/m.test(text) ||
    /^\s*\d+[.)]\s+\S/m.test(text) ||
    /(\*\*|__)(.+?)\1/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\[[^\]]+\]\([^)]+\)/.test(text) ||
    /^\s*([-*_])\s*\1\s*\1/m.test(text)
  )
}
