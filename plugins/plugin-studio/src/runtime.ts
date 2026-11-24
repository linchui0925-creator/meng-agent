export { createContext, runInvariants, StatusGraph, type Ctx } from '@meng/core'

export interface ToolServiceLike {
  register(def: { name: string }): () => void
  list(): Array<{ name: string }>
}
