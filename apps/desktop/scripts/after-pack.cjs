const { cpSync, existsSync, mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

/**
 * pnpm 把 esbuild 的平台二进制放在 esbuild 自己的 node_modules 下；
 * electron-builder 在 pnpm 工作区里偶尔只复制 esbuild 的 JS，漏掉这个
 * optional dependency。漏掉后 tsx 会在启动时直接失败，应用只剩空窗口。
 *
 * 这里按目标平台/架构找到当前 esbuild 对应的二进制包，明确补进已打包的
 * app/node_modules，保证运行时能从 esbuild 正常解析到它。
 */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName === 'darwin'
    ? 'darwin'
    : context.electronPlatformName === 'win32' ? 'win32' : 'linux'
  const arch = context.arch === 0
    ? 'ia32'
    : context.arch === 1 ? 'x64' : context.arch === 2 ? 'arm' : context.arch === 3 ? 'arm64' : 'universal'
  if (arch === 'universal') return

  const packageName = `@esbuild/${platform}-${arch}`
  const esbuildPackage = require.resolve('esbuild/package.json', { paths: [process.cwd(), __dirname] })
  const esbuildDir = dirname(esbuildPackage)
  const optionalPackage = require.resolve(`${packageName}/package.json`, { paths: [esbuildDir] })
  const source = dirname(optionalPackage)
  const resources = context.packager.getResourcesDir(context.appOutDir)
  const destination = join(resources, 'app', 'node_modules', ...packageName.split('/'))

  if (!existsSync(destination)) mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true, force: true })
  console.log(`  • bundled ${packageName} for tsx`)
}
