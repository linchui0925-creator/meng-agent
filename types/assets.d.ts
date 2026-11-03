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
