/**
 * 资源类型声明。
 *
 * 为什么自己写而不引 `vite/client`: 根目录没有 vite (pnpm 的嵌套安装把 vite 放在
 * apps/web/node_modules), `"types": ["vite/client"]` 在根 tsconfig 里解析不到。
 * 自己声明三行更可靠, 也不把浏览器应用的构建工具类型泄漏到别的包里。
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

declare module '*.svg' {
  const src: string
  export default src
}

/**
 * `import.meta.env` 的最小声明。
 *
 * 同上: 不引 `vite/client`（根目录解析不到）。只声明前端真正读过的那几个 ——
 * 一个字段都没多写, 因为多写的每一个都会被当成"这里有这个能力"。
 * 真要用别的（`BASE_URL` / `SSR`）时再加, 加的时候顺便想一下它在这个仓库里
 * 是不是真的存在。
 */
interface ImportMetaEnv {
  /** 构建期常量: dev server 下是 true */
  readonly DEV: boolean
  /** 构建期常量: 打包产物里是 true */
  readonly PROD: boolean
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
