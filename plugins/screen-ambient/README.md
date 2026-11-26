# @meng/plugin-screen-ambient

抓取屏幕实时主色，驱动梦的界面环境光随之呼吸。

## 它做什么

1. 你在设置页点「开始共享」，系统弹窗授权屏幕捕获
2. 逐帧把画面降采样到 32×32，统计**主色调**（色相聚类投票，不是平均色）
3. 主色写进宿主的环境光 token `--meng-alias-ambient-a/b/c`
4. 宿主那三块径向渐变跟着变，并由 CSS 动画做缓慢明暗呼吸

## 三个关键设计

**不注入自己的背景层。** 宿主本来就有环境光机制（`.shell::before` 的三块径向渐变），
专门留了那三个 token 就是给人换的。自己再插一层就是两层光叠着，反而脏。

**追主色，不追平均色。** 屏幕上一半白底文档、一半深色代码框，算出来的平均值是**灰**的，
灰的环境光等于没有环境光。所以按色相分桶投票，取人最多的那一桶。

**呼吸交给 CSS，JS 只写颜色。** 呼吸是 9 秒周期的慢起伏，用 JS 做就得每秒唤醒主线程
几十次。`@property` 注册 `--sa-breath` 为 `<number>`（注册过的自定义属性才可插值），
动画跑在合成器上，采样停止时界面也不卡顿。

## 权限与隐私

- 画面**只在本机内存里**逐帧采样，不进后端、不上网络、不落盘
- 卸载插件会立即停掉捕获并关掉屏幕共享指示灯
- macOS 桌面端需要「屏幕录制」权限。没给时 Electron **不报错而是给黑屏**，
  插件检测到连续全黑会明确提示缺哪个权限

## 平台支持

| 端 | 支持 | 说明 |
|---|---|---|
| web | ✅ | 浏览器弹窗授权 |
| desktop | ✅ | macOS 15+ 走系统原生选择器；其他平台由主进程 `desktopCapturer` 兜底 |
| mobile | ❌ | 无 `getDisplayMedia` |

桌面端需要主进程设置 `setDisplayMediaRequestHandler`，见 `apps/desktop/src/main.ts`。

## 构建

```bash
pnpm install
pnpm build     # dist/ + client/client.js
pnpm pack
```

测试（纯逻辑，node 直接跑）：

```bash
node --experimental-strip-types test/color.ts
node --experimental-strip-types test/ambient.ts
node --experimental-strip-types test/capture.ts
```

## 设置

- **强度** —— 环境光浓度，太高会盖过正文
- **跟随速度** —— 屏幕变色后背景追上去的速度。慢一点更柔和，快一点更跟手
- **呼吸幅度** —— 明暗起伏幅度。0 是「不呼吸」，不是「光消失」
