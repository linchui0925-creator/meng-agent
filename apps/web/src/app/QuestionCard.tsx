/**
 * 挂起中的问题卡片 —— 模型/策略在等用户回答时, 停在输入框正上方。
 *
 * C2 结构: 左侧是当前问题与选项, 右侧是同一会话的待回答队列。
 * 长正文不再在卡里重复 —— ask_user_question 的检查结果本来就在上方执行链,
 * 这里只保留问题本身, 避免同一段内容把对话框撑成阅读器。
 */

import { useRef, useState } from 'react'

import { Button, Input } from '@meng/ui'

import type { QuestionPromptApi } from './layout.ts'
import styles from './QuestionCard.module.css'

/**
 * 命中就算「其他」: 点它把焦点送到自由输入, 不直接提交 key。
 * 用户点这类选项, 真实答案通常在列表之外。
 */
const OTHER_RE = /(其他|自定义|自由输入|otherwise|other)/i

export function QuestionCard({ question, queue, selectQuestion, submitAnswers, busy, error }: QuestionPromptApi) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** 每道题各自保存“已选但未提交”的 key；切题再切回仍保留。 */
  const [selected, setSelected] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const questions = queue.length > 0 ? queue : [question]
  const activeIndex = Math.max(0, questions.findIndex((item) => item.questionId === question.questionId))
  const draft = drafts[question.questionId] ?? ''
  const choices = question.choices ?? []
  const hasChoices = choices.length > 0
  const selectedKey = selected[question.questionId]
  const hasMultiple = questions.length > 1
  const sourceAvailable = question.toolName !== undefined || question.callId !== undefined

  function setDraft(value: string): void {
    setDrafts((current) => ({ ...current, [question.questionId]: value }))
    // 自由输入一旦有内容，就让当前选择的选项让位；两者只能有一个答案。
    if (value.trim() !== '') {
      setSelected((current) => {
        if (current[question.questionId] === undefined) return current
        const next = { ...current }
        delete next[question.questionId]
        return next
      })
    }
  }

  function choose(key: string): void {
    const nextSelected = { ...selected, [question.questionId]: key }
    setSelected(nextSelected)
    // 点选项时清掉这道题的自由输入，避免界面上同时像有两个答案。
    setDrafts((current) => ({ ...current, [question.questionId]: '' }))
    // 只向后跳，不绕回开头：最后一道选完后停在原地，由用户决定何时提交。
    const target = questions.slice(activeIndex + 1).find((item) => {
      const picked = nextSelected[item.questionId]
      const text = (drafts[item.questionId] ?? '').trim()
      return picked === undefined && text === ''
    })
    if (target !== undefined) selectQuestion(target.questionId)
  }

  /** 一道题的草稿答案：优先已选项，其次自由输入。 */
  function answerOf(questionId: string): string {
    const picked = selected[questionId]
    if (picked !== undefined) return picked
    return (drafts[questionId] ?? '').trim()
  }

  const answeredCount = questions.filter((item) => answerOf(item.questionId) !== '').length
  const remaining = questions.length - answeredCount
  const ready = remaining === 0

  /** 只在整个队列都填好后发一次；后端仍是逐题 op，但用户只操作一次。 */
  function submitAll(): void {
    if (!ready) return
    submitAnswers(
      questions.map((item) => ({
        questionId: item.questionId,
        answer: answerOf(item.questionId),
      })),
    )
  }

  return (
    <section
      className={styles.card}
      data-question-kind={question.kind}
      aria-label="模型正在等待你的回答"
    >
      <header className={styles.head}>
        <span className={styles.waiting}>
          <span className={styles.pulse} aria-hidden="true" />
          {question.kind === 'approval' ? '需要你批准' : '需要你的回答'}
        </span>
        {hasMultiple && (
          <div className={styles.numbers} role="tablist" aria-label="问题编号">
            {questions.map((item, index) => (
              <button
                key={item.questionId}
                type="button"
                className={styles.number}
                data-active={item.questionId === question.questionId}
                data-answered={answerOf(item.questionId) !== ''}
                aria-label={`第 ${index + 1} 个问题`}
                aria-current={item.questionId === question.questionId ? 'step' : undefined}
                disabled={busy}
                onClick={() => selectQuestion(item.questionId)}
              >
                {index + 1}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className={styles.grid} data-multiple={hasMultiple}>
        <div className={styles.main}>
          <div className={styles.kindRow}>
            <span className={styles.kind} data-kind={question.kind}>
              {question.kind === 'approval' ? '工具审批' : '确认问题'}
            </span>
            {question.toolName !== undefined && <span className={styles.tool}>{question.toolName}</span>}
          </div>

          <h2 className={styles.title}>{question.title}</h2>

          {question.kind === 'approval' && question.body !== undefined ? (
            // 审批可能在工具开跑前发生，上方还没有对应执行链。这里只给两行摘要，不摊全文。
            <p className={styles.body}>{question.body}</p>
          ) : sourceAvailable ? (
            <p className={styles.sourceNote}>详细检查结果已显示在上方执行链</p>
          ) : question.body !== undefined ? (
            <p className={styles.body}>{question.body}</p>
          ) : null}

          {hasChoices && (
            <div className={styles.choices} role="group" aria-label="可选答案">
              {choices.map((choice, index) => {
                const isOther = OTHER_RE.test(choice.key) || OTHER_RE.test(choice.label)
                return (
                  <button
                    key={choice.key}
                    type="button"
                    className={styles.choice}
                    aria-label={choice.label}
                    aria-pressed={selectedKey === choice.key}
                    data-selected={selectedKey === choice.key}
                    disabled={busy}
                    onClick={() => {
                      if (isOther) {
                        inputRef.current?.focus()
                        return
                      }
                      choose(choice.key)
                    }}
                  >
                    <span className={styles.key}>{choice.key === 'approve' ? '✓' : String.fromCharCode(65 + index)}</span>
                    <span>
                      {choice.label}
                      {choice.description !== undefined && (
                        <span className={styles.choiceDesc}>{choice.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <div className={styles.answerRow}>
            <Input
              ref={inputRef}
              className={styles.input}
              value={draft}
              disabled={busy}
              placeholder={hasChoices ? '也可以写其他答案…' : '写下你的回答…'}
              aria-label="回答问题"
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>

          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>

      </div>

      <footer className={styles.commitBar}>
        <div className={styles.commitMeta}>
          <b>
            {answeredCount} / {questions.length}
          </b>
          <span>{ready ? '已填写完整，可以整组提交' : `还差 ${remaining} 个问题`}</span>
        </div>
        <Button variant="primary" size="md" disabled={busy || !ready} onClick={submitAll}>
          {busy ? '提交中…' : '提交'}
        </Button>
      </footer>
    </section>
  )
}
