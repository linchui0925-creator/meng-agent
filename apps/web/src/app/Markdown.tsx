/**
 * 把 `markdown.ts` 产出的块画成 React 元素。
 *
 * **这里没有 `dangerouslySetInnerHTML`，也不需要它** —— 解析器给的是数据，
 * 文本一律走 JSX 的 `{}`（React 自己转义）。想加 XSS 得先改这个文件, 而改它
 * 会被 review 看见；反过来"拼字符串 + innerHTML"的写法, 漏一个转义没人看得见。
 *
 * 两个渲染上的取舍:
 *   · **标题不用 `<h1>`-`<h6>`**, 用带 `role="heading"` 的 `<p>`。消息里的 `#`
 *     是"这段话的层级", 不是"文档的层级" —— 真放 h1 会打乱整页的大纲,
 *     读屏用户按标题跳转时会跳到一条聊天消息上。
 *   · **代码块不引高亮库**（零依赖）。给一个语言标签 + 等宽 + 可横向滚动,
 *     需要颜色时再加 —— 而那时应该先问"值不值得为它引一个 200KB 的依赖"。
 */

import { useMemo } from 'react'

import { linkifyText, parseMarkdown, type Block, type Inline } from './markdown.ts'
import styles from './Markdown.module.css'

export function Markdown({ text, caret = false }: { text: string; caret?: boolean }) {
  // 流式输出时 text 每来一块就变一次。useMemo 挡掉"同一段文字重渲染两次"
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className={styles.md} data-markdown="">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} caret={caret && i === blocks.length - 1} />
      ))}
      {/*
        一个字的空消息（刚开流、还没来第一个 delta）没有任何块, 光标就没地方挂。
        这里补一个空段落专门装它 —— 否则"正在生成"的第一秒界面上什么都没有。
      */}
      {caret && blocks.length === 0 ? (
        <p className={styles.para}>
          <Caret />
        </p>
      ) : null}
    </div>
  )
}

/** 用户纯文本：只把裸链接变成可点链接，不解释 Markdown。 */
export function AutolinkText({ text }: { text: string }) {
  const nodes = useMemo(() => linkifyText(text), [text])
  return <InlineView nodes={nodes} />
}

/**
 * 流式光标。
 *
 * **必须挂在最后一个块内部**，不能作为 `.md` 的兄弟节点 —— `.md` 是块级容器,
 * 兄弟节点会掉到下一行, 表现是"光标孤零零站在新一行", 而不是"跟在最后一个字后面"。
 */
function Caret() {
  return <span className={styles.caret} aria-hidden="true" />
}

function BlockView({ block, caret = false }: { block: Block; caret?: boolean }) {
  switch (block.kind) {
    case 'code':
      return (
        <div className={styles.codeBox} data-lang={block.lang ?? ''}>
          {block.lang !== undefined && (
            <div className={styles.codeHeader}>
              <span className={styles.codeLang}>{block.lang}</span>
            </div>
          )}
          <pre className={styles.code}>
            <code>{block.text}</code>
          </pre>
          {caret ? <Caret /> : null}
        </div>
      )
    case 'heading':
      return (
        <p className={styles.heading} data-level={block.level} role="heading" aria-level={block.level}>
          <InlineView nodes={block.inline} />
          {caret ? <Caret /> : null}
        </p>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className={styles.list} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
          {block.items.map((item, i) => (
            <li key={i} className={styles.item}>
              <InlineView nodes={item} />
              {caret && i === block.items.length - 1 ? <Caret /> : null}
            </li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className={styles.tableWrap} data-table="">
          <table className={styles.table}>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} data-align={block.align[i]}>
                    <InlineView nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} data-align={block.align[cellIndex]}>
                      <InlineView nodes={cell} />
                      {caret && rowIndex === block.rows.length - 1 && cellIndex === row.length - 1 ? <Caret /> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return (
        <blockquote className={styles.quote}>
          <InlineView nodes={block.inline} />
          {caret ? <Caret /> : null}
        </blockquote>
      )
    case 'hr':
      return <hr className={styles.hr} />
    case 'para':
      return (
        <p className={styles.para}>
          <InlineView nodes={block.inline} />
          {caret ? <Caret /> : null}
        </p>
      )
  }
}

function InlineView({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'text':
            return <span key={i}>{n.text}</span>
          case 'br':
            return <br key={i} />
          case 'code':
            return (
              <code key={i} className={styles.inlineCode}>
                {n.text}
              </code>
            )
          case 'strong':
            return (
              <strong key={i}>
                <InlineView nodes={n.inline} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <InlineView nodes={n.inline} />
              </em>
            )
          case 'link':
            return (
              <a key={i} className={styles.link} href={n.href} target="_blank" rel="noreferrer noopener">
                <InlineView nodes={n.inline} />
              </a>
            )
        }
      })}
    </>
  )
}
