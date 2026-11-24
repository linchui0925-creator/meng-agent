import type { AdapterKind } from './manifest.ts'

export type PluginKind = 'backend' | 'frontend' | 'fullstack'

export interface ScaffoldOptions {
  id: string
  output: string
  packageName?: string
  kind?: PluginKind
  adapter?: AdapterKind
  sourcePackage?: string
  description?: string
  source?: string
}

export interface ScaffoldResult {
  output: string
  id: string
  packageName: string
  kind: PluginKind
  adapter?: AdapterKind
  source?: string
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface BuildResult {
  output: string
  backend: boolean
  client: boolean
}

export interface PackResult {
  file: string
  name: string
  version: string
}

export interface VerifyResult {
  ok: boolean
  details: string[]
}
