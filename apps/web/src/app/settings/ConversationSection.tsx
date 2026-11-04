/**
 * 「对话」分区 —— 全是本机腿: 存 localStorage, 即改即生效, 不碰内核。
 *
 * 这里出现的每一项都**真的改了行为**。放一个改不动的开关比不放更糟:
 * 用户会以为自己关掉了, 然后继续被它烦。所以「密度」「动效」这类
 * 影响整屏的东西归「外观」, 只影响对话流的东西归这里。
 *
 * 三个取舍, 都写在控件旁边了, 这里只记为什么这么分组:
 *   · 气泡和工具卡是**两种不同的打扰** (一个是旁白, 一个是内容), 分开两组
 *   · 「出现时机」属于气泡, 所以气泡关掉时它整行失效 —— 而不是留着能点
 *     却毫无效果。因果明确的禁用, 比"点了没反应"好解释
 */

import type { SectionApi } from './api.ts'
import type { WhisperWhen } from '../../prefs.ts'
import { Group, Note, Row, Segmented, Switch } from './controls.tsx'

const WHEN_OPTIONS: ReadonlyArray<{ value: WhisperWhen; label: string }> = [
  { value: 'soon', label: '5 秒' },
  { value: 'normal', label: '8 秒' },
  { value: 'late', label: '12 秒' },
]

export function ConversationSection({ prefs, setPrefs }: SectionApi) {
  return (
    <div>
      <Group title="等待气泡">
        <Row
          title="等太久时说一句"
          desc="放在最实在的地方：不影响工具卡上的真实进度，也不会挡住任何按钮。"
        >
          <Switch
            checked={prefs.whisper}
            onChange={(whisper) => setPrefs({ whisper })}
            label="等待气泡"
          />
        </Row>

        <Row
          title="等多久才开口"
          desc="时间太短会变成打扰，太长就没什么用了。"
          disabled={!prefs.whisper}
        >
          <Segmented
            value={prefs.whisperWhen}
            options={WHEN_OPTIONS}
            onChange={(whisperWhen) => setPrefs({ whisperWhen })}
            label="气泡出现时机"
            disabled={!prefs.whisper}
          />
        </Row>
      </Group>

      <Group title="工具卡">
        <Row
          title="跑完自动折叠"
          desc="折叠后只留一行摘要。输出长的时候，这是让对话不被顶走的关键；想看细节随时点开。"
        >
          <Switch
            checked={prefs.foldTools}
            onChange={(foldTools) => setPrefs({ foldTools })}
            label="工具卡跑完自动折叠"
          />
        </Row>
      </Group>

      <Note>
        这些只存在这台机器上，改完立刻生效，不经过内核、也不需要重启。
      </Note>
    </div>
  )
}
