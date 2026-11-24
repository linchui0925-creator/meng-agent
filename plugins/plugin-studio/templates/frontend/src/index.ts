import { readFileSync } from 'node:fs'
import { defineInvariant } from '@meng/core'

export const name = '{{id}}'
export const inject: string[] = []

export function apply(): void {}

export const invariant = defineInvariant('{{packageName}}', [{
  id: 'manifest-ready',
  run() {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (pkg.meng?.plugin?.id !== '{{id}}') throw new Error('插件清单不匹配')
  },
}])
