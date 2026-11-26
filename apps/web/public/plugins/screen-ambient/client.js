(function(react, react_jsx_runtime) {
	// src/panel.css?inline
	var panel_default = "/*\n * 设置分区的样式。\n *\n * 以 `?inline` 导入成字符串, 由 factory 在**物化时**注入, 并打上\n * `data-plugin=\"screen-ambient\"` (docs/08 §6: 显式标记, 运行期只回收带自己标记的)。\n *\n * 用变量时守住 §4.2 那条: 颜色一律取 `--meng-alias-*`(宿主换肤时这一块跟着变),\n * 尺寸取 `--meng-specific-*`(结构层, 可以读, 不许改)。插件自己发明色值是绕过对比度审计。\n */\n\n.sa-root {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-4);\n  max-width: 640px;\n}\n\n.sa-lead {\n  margin: 0;\n  color: var(--meng-alias-fg-secondary);\n  font-size: var(--meng-specific-text-sm);\n  line-height: 1.6;\n}\n\n/* ── 分组 ── */\n\n.sa-group {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-2);\n}\n\n.sa-group-title {\n  margin: 0;\n  font-size: var(--meng-specific-text-sm);\n  font-weight: var(--meng-specific-weight-strong);\n  color: var(--meng-alias-fg-primary);\n}\n\n.sa-group-body {\n  display: flex;\n  flex-direction: column;\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n  overflow: hidden;\n}\n\n/* ── 一行一个设置项 ── */\n\n.sa-row {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--meng-specific-space-4);\n  padding: var(--meng-specific-space-3);\n  border-top: 1px solid var(--meng-alias-border-l1);\n}\n\n/* 第一行不要上边框 —— 边框在外层 groupBody 上已经有了 */\n.sa-group-body > .sa-row:first-child {\n  border-top: none;\n}\n\n.sa-row-text {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-1);\n  min-width: 0;\n}\n\n.sa-row-title {\n  font-size: var(--meng-specific-text-sm);\n  font-weight: var(--meng-specific-weight-medium);\n  color: var(--meng-alias-fg-primary);\n}\n\n.sa-row-desc {\n  margin: 0;\n  font-size: var(--meng-specific-text-xs);\n  line-height: 1.5;\n  color: var(--meng-alias-fg-muted);\n}\n\n.sa-row-control {\n  display: flex;\n  align-items: center;\n  flex-shrink: 0;\n}\n\n/* ── 按钮 ── */\n\n.sa-button,\n.sa-button-primary {\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-3);\n  border-radius: var(--meng-specific-radius-sm);\n  font: inherit;\n  font-size: var(--meng-specific-text-sm);\n  cursor: pointer;\n  transition: background var(--meng-specific-dur-fast) ease;\n}\n\n.sa-button {\n  border: 1px solid var(--meng-alias-border-l2);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-primary);\n}\n\n.sa-button:hover:not(:disabled) {\n  background: var(--meng-alias-bg-hover);\n}\n\n.sa-button-primary {\n  border: 1px solid transparent;\n  background: var(--meng-alias-accent);\n  color: var(--meng-alias-fg-on-accent);\n}\n\n.sa-button-primary:hover:not(:disabled) {\n  background: var(--meng-alias-accent-hover);\n}\n\n.sa-button:disabled,\n.sa-button-primary:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n/* ── 开关 ── */\n\n.sa-switch {\n  position: relative;\n  width: 40px;\n  height: 22px;\n  padding: 0;\n  border: 1px solid var(--meng-alias-border-l2);\n  border-radius: var(--meng-specific-radius-full);\n  background: var(--meng-alias-bg-inset);\n  cursor: pointer;\n  transition: background var(--meng-specific-dur-fast) ease;\n}\n\n.sa-switch[data-on] {\n  background: var(--meng-alias-accent);\n  border-color: transparent;\n}\n\n.sa-switch-knob {\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 16px;\n  height: 16px;\n  border-radius: var(--meng-specific-radius-full);\n  background: var(--meng-alias-bg-surface);\n  transition: transform var(--meng-specific-dur-fast) ease;\n}\n\n.sa-switch[data-on] .sa-switch-knob {\n  transform: translateX(18px);\n}\n\n/* ── 滑杆 ── */\n\n.sa-slider {\n  width: 140px;\n  accent-color: var(--meng-alias-accent);\n  cursor: pointer;\n}\n\n.sa-slider:disabled {\n  opacity: 0.4;\n  cursor: default;\n}\n\n/* ── 状态徽章 ── */\n\n.sa-badge {\n  display: inline-flex;\n  align-items: center;\n  padding: 2px var(--meng-specific-space-2);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  border: 1px solid var(--meng-alias-border-l1);\n  font-size: var(--meng-specific-text-xs);\n  color: var(--meng-alias-fg-secondary);\n  white-space: nowrap;\n}\n\n.sa-badge[data-state='running'] {\n  background: var(--meng-alias-positive-subtle);\n  color: var(--meng-alias-positive);\n  border-color: transparent;\n}\n\n.sa-badge[data-state='denied'],\n.sa-badge[data-state='unsupported'],\n.sa-badge[data-state='no-permission'] {\n  background: var(--meng-alias-danger-subtle);\n  color: var(--meng-alias-danger);\n  border-color: transparent;\n}\n\n.sa-badge[data-state='requesting'] {\n  background: var(--meng-alias-live-subtle);\n  color: var(--meng-alias-live);\n  border-color: transparent;\n}\n\n/* ── 注脚 ── */\n\n.sa-note {\n  margin: 0;\n  font-size: var(--meng-specific-text-xs);\n  line-height: 1.6;\n  color: var(--meng-alias-fg-muted);\n}\n";
	// src/breath.ts
	/**
	* 呼吸的实现方式 —— **CSS 动画, 不是 JS 定时器**。
	*
	* 理由很直接: 呼吸是个 9 秒周期的慢起伏, 如果用 JS 做, 每秒就得唤醒
	* 主线程几十次去改三个 CSS 变量。页面看着不动, 电量在掉。
	* 交给 CSS 之后, 动画跑在合成器上, JS 完全不参与。
	*
	* 怎么让 CSS 动一个**数值**?
	* 靠 `@property` 把 `--sa-breath` 注册成 `<number>` —— 注册过的自定义属性
	* 才是**可插值的**, 于是 keyframes 能平滑地改它, 而不是整数式地跳。
	*
	* 两条独立的轴:
	*   · **颜色** (色相/饱和/亮度) 由 JS 写 —— 随屏幕实时变
	*   · **起伏** (明暗呼吸) 由 CSS 动画乘上去 —— 随时间变
	* token 的 alpha 写成 `calc(N% * (1 + (var(--sa-breath, 1) - 1) * 幅度))`:
	* 前者随屏幕走, 后者随时间走, 互不干扰。
	*
	* **`var()` 的 fallback 不是可省的**:
	* 自定义属性里写 `var(--sa-breath)` 而没有 fallback, 一旦这个属性不存在
	* (比如 @property 不被支持、或注入的 style 被摘了), 整条声明在计算值阶段
	* becomes invalid → 用它的 `radial-gradient` 整条作废 → 宿主的环境光层直接消失。
	* 写成 `var(--sa-breath, 1)` 就只是「不呼吸」, 而不是「把宿主样式弄坏」。
	*/
	/** 宿主是否支持 @property / CSS.registerProperty */
	var CAN_BREATHE = typeof CSS !== "undefined" && typeof CSS.registerProperty === "function";
	/**
	* 呼吸动画的 CSS 片段。
	*
	* 只在 CAN_BREATHE 时注入 —— 否则自定义属性不可插值, 动画会变成生硬的
	* 50% 处跳变, 那还不如不呼吸。
	*
	* **动画挂在 `html` 上**, 因为 token 写在 `<html>` 的 inline style 上,
	* 自定义属性会继承下去。
	*/
	var BREATH_CSS = `
@property --sa-breath {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}

@keyframes screen-ambient-breathe {
  0%, 100% { --sa-breath: 0.72; }
  50% { --sa-breath: 1; }
}

html {
  animation: screen-ambient-breathe 9s ease-in-out infinite;
}

/*
 * 尊重系统的「减少动态效果」。
 *
 * 宿主 tokens.css 里有一条 animation-duration: 0.01ms !important 的全局规则,
 * 那会把动画变成「一瞬间跳到终点」—— 效果上是**常亮**, 不是不呼吸。
 * 所以这里用 animation: none 明确关掉: 呼吸值停在 initial-value (1),
 * 于是光是**静态**的, 而不是某个中间态。
 */
@media (prefers-reduced-motion: reduce) {
  html { animation: none; }
}
`;
	// src/Panel.tsx
	/**
	* 设置分区 —— 插件的控制面板。
	*
	* **为什么自己写控件而不复用宿主的 `apps/web/src/app/settings/controls.tsx`**:
	* 那个模块在宿主应用内部, 插件拿不到 (也不该去 import 宿主应用源码)。
	* `packages/ui` 里的组件是**聊天界面**的控件, 尺寸和语义都偏"操作",
	* 而设置页要的是「一行一个设置项, 控件永远靠右对齐」这种表单节奏。
	* 所以这里写一份**精简的**分区控件 —— 只写这个分区真的用到的那几个。
	*
	* 可访问性照抄宿主的做法: 开关用 `role="switch"`, 滑杆用原生 `<input type=range>`。
	* 自己写 div 装样子的话读屏和键盘 Tab 得重新补一遍, 还容易补错。
	*/
	function Panel(props) {
		const { bridge } = props;
		const { settings, snapshot } = bridge;
		const set = (0, react.useCallback)((patch) => {
			bridge.onSettings({
				...settings,
				...patch
			});
		}, [bridge, settings]);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "sa-root",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "sa-lead",
					children: "抓取屏幕画面，算出此刻的主色调，驱动界面的环境光随之呼吸。 抓屏需要你手动授权一次；授权后画面只在本机内存里逐帧采样，不会离开这台电脑。"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "sa-group",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: "sa-group-title",
						children: "屏幕捕获"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sa-group-body",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sa-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sa-row-text",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sa-row-title",
									children: "共享屏幕"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sa-row-desc",
									children: describeState(snapshot.state, snapshot.message)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sa-row-control",
								children: snapshot.state === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "sa-button",
									onClick: bridge.onStop,
									"data-testid": "sa-stop",
									children: "停止共享"
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "sa-button-primary",
									onClick: bridge.onStart,
									disabled: snapshot.state === "requesting",
									"data-testid": "sa-start",
									children: snapshot.state === "requesting" ? "等待授权…" : "开始共享"
								})
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sa-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sa-row-text",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sa-row-title",
									children: "状态"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sa-row-desc",
									children: stateDetail(snapshot)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sa-row-control",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sa-badge",
									"data-state": snapshot.state,
									children: stateLabel(snapshot.state)
								})
							})]
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "sa-group",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: "sa-group-title",
						children: "效果"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sa-group-body",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sa-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sa-row-text",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sa-row-title",
										children: "启用"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sa-row-desc",
										children: "关掉后环境光恢复宿主的默认冷暖配色"
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "sa-row-control",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										role: "switch",
										"aria-checked": settings.enabled,
										className: "sa-switch",
										"data-on": settings.enabled ? "" : void 0,
										onClick: () => set({ enabled: !settings.enabled }),
										"data-testid": "sa-enabled",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "sa-switch-knob" })
									})
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
								title: "强度",
								desc: "环境光的浓度。太高会盖过正文。",
								value: settings.strength,
								disabled: !settings.enabled,
								onChange: (v) => set({ strength: v }),
								testId: "sa-strength"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
								title: "跟随速度",
								desc: "屏幕变色后背景追上去的速度。慢一点更柔和, 快一点更跟手。",
								value: settings.responsiveness,
								disabled: !settings.enabled,
								onChange: (v) => set({ responsiveness: v }),
								testId: "sa-responsiveness"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Slider, {
								title: "呼吸幅度",
								desc: "环境光缓慢明暗起伏的幅度。",
								value: settings.breathe,
								disabled: !settings.enabled,
								onChange: (v) => set({ breathe: v }),
								testId: "sa-breathe"
							})
						]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "sa-note",
					children: CAN_BREATHE ? "呼吸由浏览器合成器上的 CSS 动画驱动，采样停止时界面也不会卡顿。" : "这个浏览器不支持 CSS @property，呼吸动画已降级为静态光效。"
				})
			]
		});
	}
	function Slider(props) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "sa-row",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sa-row-text",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "sa-row-title",
					children: props.title
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "sa-row-desc",
					children: props.desc
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "sa-row-control",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "range",
					min: 0,
					max: 1,
					step: .05,
					value: props.value,
					disabled: props.disabled,
					className: "sa-slider",
					onChange: (e) => props.onChange(Number(e.target.value)),
					"data-testid": props.testId
				})
			})]
		});
	}
	function stateLabel(state) {
		switch (state) {
			case "running": return "运行中";
			case "requesting": return "等待授权";
			case "denied": return "被拒绝";
			case "no-permission": return "缺权限";
			case "ended": return "已停止";
			case "unsupported": return "不支持";
			default: return "未启动";
		}
	}
	function describeState(state, message) {
		if (state === "running") return "正在逐帧采样屏幕画面。停止共享后环境光会恢复默认。";
		if (message) return message;
		if (state === "unsupported") return "当前环境没有屏幕捕获能力。";
		return "点击「开始共享」，在弹窗里选择要共享的屏幕。";
	}
	function stateDetail(snapshot) {
		if (snapshot.state === "no-permission") return "画面是全黑的 —— 系统没放行屏幕录制。给权限后重启应用即可。";
		if (snapshot.state !== "running") return "没有采样时环境光保持宿主的默认配色。";
		const size = snapshot.size;
		if (!size) return "正在采样…";
		return `采样来源 ${size.width}×${size.height}，降采样到 32×32 统计主色。`;
	}
	// src/color.ts
	/** 色相桶宽度。36 = 10° 一个桶, 共 36 桶 */
	var HUE_BUCKETS = 36;
	/** 桶宽度（度） */
	var BUCKET_DEG = 360 / HUE_BUCKETS;
	/**
	* 灰色像素的饱和度上限。
	*
	* 低于这个值算「无彩色」—— 白底、灰底、黑底都归这里。
	* 它们**不参与投票**, 但**不计入分母**: 否则一张纯白桌面会让唯一有彩色的
	* 一个小图标独占 100% 票数, 环境光跟着那个图标跳。
	*/
	var GRAY_SAT_THRESHOLD = .12;
	/** 单个桶至少要有这么多像素才算是「一个色」 */
	var MIN_BUCKET_PIXELS = 4;
	function rgbToHsl(rgb) {
		const r = rgb.r / 255;
		const g = rgb.g / 255;
		const b = rgb.b / 255;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const d = max - min;
		const l = (max + min) / 2;
		if (d === 0) return {
			h: 0,
			s: 0,
			l
		};
		const s = l > .5 ? d / (2 - max - min) : d / (max + min);
		let h;
		if (max === r) h = (g - b) / d % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
		return {
			h,
			s,
			l
		};
	}
	function hslToRgb(hsl) {
		const h = (hsl.h % 360 + 360) % 360;
		const s = clamp01$1(hsl.s);
		const l = clamp01$1(hsl.l);
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const x = c * (1 - Math.abs(h / 60 % 2 - 1));
		const m = l - c / 2;
		let rp = 0;
		let gp = 0;
		let bp = 0;
		if (h < 60) {
			rp = c;
			gp = x;
		} else if (h < 120) {
			rp = x;
			gp = c;
		} else if (h < 180) {
			gp = c;
			bp = x;
		} else if (h < 240) {
			gp = x;
			bp = c;
		} else if (h < 300) {
			rp = x;
			bp = c;
		} else {
			rp = c;
			bp = x;
		}
		return {
			r: Math.round((rp + m) * 255),
			g: Math.round((gp + m) * 255),
			b: Math.round((bp + m) * 255)
		};
	}
	function clamp01$1(v) {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}
	/** 夹到 [min, max] 区间 */
	function clamp$1(v, min, max) {
		return v < min ? min : v > max ? max : v;
	}
	/**
	* 从 RGB 像素里找主色。
	*
	* @param pixels 扁平数组 [r,g,b,r,g,b,...]
	*/
	function dominantColor(pixels) {
		const count = Math.floor(pixels.length / 3);
		if (count === 0) return null;
		const bucketCount = new Int32Array(HUE_BUCKETS);
		const bucketR = new Float64Array(HUE_BUCKETS);
		const bucketG = new Float64Array(HUE_BUCKETS);
		const bucketB = new Float64Array(HUE_BUCKETS);
		let colorful = 0;
		for (let i = 0; i < count; i++) {
			const r = pixels[i * 3] ?? 0;
			const g = pixels[i * 3 + 1] ?? 0;
			const b = pixels[i * 3 + 2] ?? 0;
			const hsl = rgbToHsl({
				r,
				g,
				b
			});
			if (hsl.s < GRAY_SAT_THRESHOLD || hsl.l < .03 || hsl.l > .97) continue;
			colorful++;
			const idx = Math.min(35, Math.floor(hsl.h / BUCKET_DEG));
			bucketCount[idx] = (bucketCount[idx] ?? 0) + 1;
			bucketR[idx] = (bucketR[idx] ?? 0) + r;
			bucketG[idx] = (bucketG[idx] ?? 0) + g;
			bucketB[idx] = (bucketB[idx] ?? 0) + b;
		}
		if (colorful === 0) return null;
		/**
		* 找票最多的桶。
		*
		* **关键: 相邻桶先合并, 再比票数。**
		*
		* 为什么不能逐桶比完再合并: 色相量化有边界, 两种很接近的蓝 (h=217 和
		* h=220) 正好落在边界两侧, 逐桶比时它们各占一半 —— 明明是同一个色,
		* 却被当成两个色, 票数被腰斩, 环境光会不稳。
		*
		* 所以这里对每个桶, 取它**和左右邻居**的总票数来比。取最大的是哪个桶,
		* 就以哪个桶为中心取这一组三桶的均值。
		*/
		let bestIdx = -1;
		let bestVotes = 0;
		for (let i = 0; i < HUE_BUCKETS; i++) {
			const prev = bucketCount[(i - 1 + HUE_BUCKETS) % HUE_BUCKETS] ?? 0;
			const self = bucketCount[i] ?? 0;
			const next = bucketCount[(i + 1) % HUE_BUCKETS] ?? 0;
			const votes = prev + self + next;
			if (votes > bestVotes) {
				bestVotes = votes;
				bestIdx = i;
			}
		}
		if (bestIdx < 0 || bestVotes < MIN_BUCKET_PIXELS) return null;
		let n = 0;
		let sr = 0;
		let sg = 0;
		let sb = 0;
		for (let d = -1; d <= 1; d++) {
			const i = (bestIdx + d + HUE_BUCKETS) % HUE_BUCKETS;
			const c = bucketCount[i] ?? 0;
			if (c === 0) continue;
			n += c;
			sr += bucketR[i] ?? 0;
			sg += bucketG[i] ?? 0;
			sb += bucketB[i] ?? 0;
		}
		if (n === 0) return null;
		const rgb = {
			r: Math.round(sr / n),
			g: Math.round(sg / n),
			b: Math.round(sb / n)
		};
		return {
			rgb,
			hsl: rgbToHsl(rgb),
			/** 这一组三桶的像素数占全部有彩色像素的比例 */
			share: n / colorful
		};
	}
	/**
	* 把主色映射成三个环境光色。
	*
	* @param base     主色
	* @param mode     深浅 —— 深色底要更亮的光, 浅色底要更暗的光, 否则看不见
	* @param strength 0~1, 整体强度
	*/
	function toAmbientColors(base, mode, strength) {
		const sat = clamp$1(base.s * .85, .12, .62);
		const lightL = mode === "dark" ? .62 : .52;
		const l = Math.min(base.l * .5 + .28, lightL);
		return {
			a: hslToRgb({
				h: base.h - 14,
				s: sat,
				l: l * 1
			}),
			b: hslToRgb({
				h: base.h + 12,
				s: sat * .9,
				l: l * .82
			}),
			c: hslToRgb({
				h: base.h + 26,
				s: sat * .78,
				l: l * .66
			})
		};
	}
	/**
	* 把 RGB 转成 token 要的 `rgb(r g b / a)` 形式。
	*
	* **为什么用百分比不透明度而不是十六进制 alpha**:
	* 宿主 token 表里 ambient 三项就是这么写的 (`rgb(112 146 255 / 20%)`),
	* 保持同一记法, 换肤与审计那套逻辑读起来才一致。
	*
	* @param alpha 数字 = 百分比; 字符串 = 原样嵌入的 CSS 表达式 (如 calc(...))
	*/
	function toTokenValue(rgb, alpha) {
		return `rgb(${Math.round(clamp01$1(rgb.r / 255) * 255)} ${Math.round(clamp01$1(rgb.g / 255) * 255)} ${Math.round(clamp01$1(rgb.b / 255) * 255)} / ${typeof alpha === "number" ? `${Math.round(clamp01$1(alpha / 100) * 100)}%` : alpha})`;
	}
	/**
	* 指数平滑 —— 让颜色渐变而不是跳变。
	*
	* @param alpha 0~1, 越大跟得越快
	*/
	function smooth(current, target, alpha) {
		return current + (target - current) * clamp01$1(alpha);
	}
	/**
	* 插值角度。色相是环形的 —— 350° → 10° 应该走 20° 而不是 -340°。
	*/
	function smoothHue(current, target, alpha) {
		return (current + ((target - current + 540) % 360 - 180) * clamp01$1(alpha) + 360) % 360;
	}
	// src/ambient.ts
	/**
	* 环境光驱动器 —— 把「屏幕主色」变成「宿主的环境光 token」。
	*
	* 这一层是插件的心脏, 但它刻意**只做一件事**: 算出该写哪三个 token 值,
	* 然后交给 `theme` 能力面。DOM、动画、时间轴全都不归它管。
	*
	* 为什么走 `theme` 能力面而不是自己写 `document.documentElement.style`:
	* 主题控制器维护的是**层栈**。提交一层之后, 别人提交的层照样在,
	* 自己撤销时 (`remove`) 下层的值自动重新露出来。
	* 自己写 inline style 就没这个性质 —— 卸载时得记得把旧值写回去,
	* 而「旧值」在多层覆盖下根本没有意义 (见 packages/ui/src/theme.ts 的注释)。
	*
	* **呼吸**为什么不在这里做:
	* 呼吸是**视觉**上的缓慢明暗起伏, 它的周期是秒级 —— 用 CSS 动画做,
	* CPU 占用是 0; 用 JS 定时器做, 每秒都要唤醒主线程。
	* 所以 JS 只负责**更新颜色**, 「亮一下暗一下」交给 CSS 的 @keyframes。
	* 但宿主的 `.shell::before` 用的是静态渐变, 没有动画 ——
	* 所以呼吸由本插件注入的一条 CSS 动画实现（见 ambient.css）。
	*/
	/** 三个环境光 token 名 —— 宿主 `.shell::before` 的三个径向渐变各取一个 */
	var AMBIENT_TOKENS = {
		a: "--meng-alias-ambient-a",
		b: "--meng-alias-ambient-b",
		c: "--meng-alias-ambient-c"
	};
	var AmbientDriver = class {
		smoothed = null;
		layerId;
		theme;
		config;
		/** 是否已经写过一次 */
		committed = false;
		constructor(layerId, theme, config) {
			this.layerId = layerId;
			this.theme = theme;
			this.config = config;
		}
		/**
		* 喂进一帧的主色, 返回是否真的更新了。
		*
		* 返回 false 表示「这次不值得写 DOM」—— 颜色几乎没变。
		* 写 DOM 是这个插件唯一的开销, 所以要挡掉无意义的更新。
		*/
		update(color) {
			const target = {
				h: color.hsl.h,
				s: color.hsl.s,
				l: color.hsl.l
			};
			const prev = this.smoothed;
			if (!prev) {
				this.smoothed = {
					h: target.h,
					s: target.s,
					l: target.l,
					share: color.share
				};
				this.commit(this.smoothed);
				return true;
			}
			/**
			* 速度不是线性的: 变化越大追得越快。
			*
			* 理由: 小幅抖动就该被平滑吃掉 (屏幕上一闪而过的光标不该让背景闪),
			* 大幅变化就该快速跟上 (你换了个深色主题, 背景要立刻变, 不能慢吞吞地飘)。
			* 固定系数做不到两头兼顾。
			*/
			const delta = hueDistance(prev.h, target.h);
			const speed = clamp01(this.config.responsiveness) * (.15 + Math.min(delta / 90, 1) * .85);
			const next = {
				h: smoothHue(prev.h, target.h, speed),
				s: smooth(prev.s, target.s, speed),
				l: smooth(prev.l, target.l, speed),
				share: smooth(prev.share, color.share, speed)
			};
			if (hueDistance(prev.h, next.h) < .35 && Math.abs(prev.s - next.s) < .004 && Math.abs(prev.l - next.l) < .004) {
				this.smoothed = next;
				return false;
			}
			this.smoothed = next;
			this.commit(next);
			return true;
		}
		/** 把平滑后的状态写成三个 token */
		commit(state) {
			const { a, b, c } = toAmbientColors({
				h: state.h,
				s: state.s,
				l: state.l
			}, this.config.mode, this.config.strength);
			/**
			* 不透明度跟着**饱和度**走。
			*
			* 灰色为主色时（白底文档占了大半屏）光应该几乎看不见 —— 不然整片
			* 界面被蒙一层灰, 反而变脏。有彩色时才让光透出来。
			*/
			const vividness = clamp01((state.s - .1) / .45);
			const alpha = (this.config.mode === "dark" ? 26 : 20) * vividness * this.config.strength + 2;
			/**
			* 呼吸在这里接进来。
			*
			* alpha 不是死数, 而是一个**带 CSS 变量的表达式** —— 颜色由 JS 写
			* (随屏幕变), 起伏由 CSS 动画乘上去 (随时间变)。两条线互不干扰。
			*
			* 幅度为 0 时因子恒为 1（光还在, 只是不呼吸）—— 不是把光关掉。
			*/
			const breathe = this.config.breathe;
			const factor = breathe <= 0 ? 1 : `(1 + (var(--sa-breath, 1) - 1) * ${breathe})`;
			this.theme.apply(this.layerId, {
				[AMBIENT_TOKENS.a]: toTokenValue(a, `calc(${alpha.toFixed(2)}% * ${factor})`),
				[AMBIENT_TOKENS.b]: toTokenValue(b, `calc(${(alpha * .85).toFixed(2)}% * ${factor})`),
				[AMBIENT_TOKENS.c]: toTokenValue(c, `calc(${(alpha * .7).toFixed(2)}% * ${factor})`)
			});
			this.committed = true;
		}
		/** 配置变了要重算一次 —— 否则要等到下一帧才生效 */
		reconfigure(config) {
			this.config = config;
			if (this.smoothed) this.commit(this.smoothed);
		}
		/** 撤销这一层。**卸载时必须调**, 否则环境光会一直留在页面上 */
		dispose() {
			if (!this.committed) return;
			this.theme.remove(this.layerId);
			this.committed = false;
			this.smoothed = null;
		}
		/** 当前平滑状态。给设置页显示用 */
		current() {
			return this.smoothed;
		}
	};
	/** 两个色相之间的最短距离（环形） */
	function hueDistance(a, b) {
		return Math.abs((a - b + 540) % 360 - 180);
	}
	function clamp01(v) {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}
	// src/capture.ts
	/**
	* 屏幕捕获与像素采样。
	*
	* 三件事, 每件都有个坑:
	*
	* 1. **授权是一次性的, 流是活的**。
	*    `getDisplayMedia` 必须由**用户手势**触发 (浏览器硬要求)。所以本模块
	*    不在 apply 里就抓 —— apply 时没有手势, 必然被拒。抓屏动作放在
	*    设置分区里那个按钮上, 由用户点。
	*
	* 2. **视频帧不是画布**。
	*    `<video>` 的 `drawImage` 出来的是画面, 但每帧都按视频原始分辨率
	*    画再读像素, 一个 4K 屏每帧就是 800 万次读 —— 页面直接卡死。
	*    所以先缩到 32×32 再采样: 主色是个统计量, 不需要分辨率。
	*
	* 3. **`requestVideoFrameCallback` 比 `setInterval` 对**。
	*    屏幕没变化时视频不产生新帧, 按固定间隔轮询会白烧 CPU;
	*    按帧回调则是**有画面才干活**。
	*/
	/** 采样边长。32 = 1024 个像素, 统计主色绰绰有余 */
	var SAMPLE_SIZE = 32;
	/**
	* 连续多少帧全黑才提示「可能没权限」。
	*
	* 取 8 帧: 一帧全黑可能是刚好切到黑屏的瞬间, 8 帧连续全黑基本可以确定
	* 是系统没放行。采样帧率是 4~8fps, 所以 8 帧约 1~2 秒 —— 够短, 不至于
	* 让用户等太久才发现问题。
	*/
	var BLACK_FRAME_THRESHOLD = 8;
	/**
	* 判断一帧是不是全黑。
	*
	* 判据是「所有像素都低于某个亮度」, 而不是「严格等于 0」——
	* macOS 给的「黑屏」其实是很暗的深灰 (压缩 + 色彩空间转换的结果),
	* 严格判 0 永远不成立。
	*/
	function isFullyBlack(data) {
		if (data.length === 0) return false;
		for (let i = 0; i < data.length; i += 4) if (.2126 * (data[i] ?? 0) + .7152 * (data[i + 1] ?? 0) + .0722 * (data[i + 2] ?? 0) > 6) return false;
		return true;
	}
	/**
	* 一路屏幕捕获。
	*
	* 用法: `await capture.start()` (必须在用户手势里), 然后它自己跑,
	* `capture.stop()` 收摊。卸载时**必须** stop —— 忘了停, 屏幕共享指示灯
	* 会一直亮着, 用户会以为被监控了。
	*/
	var ScreenCapture = class {
		stream = null;
		video = null;
		canvas = null;
		ctx = null;
		frameCallback = null;
		stopped = false;
		options;
		/**
		* 不用参数属性（`constructor(private readonly options: ...)`）——
		* Node 的 strip-only 模式不支持那套语法, 写了这个文件就没法在 node 下
		* 直接跑测试。多写两行, 换测试能跑。
		*/
		constructor(options) {
			this.options = options;
		}
		/** 当前是否在跑 */
		get active() {
			return this.stream !== null;
		}
		/**
		* 开始捕获。**必须在用户手势的调用栈里**。
		*
		* 失败不抛 —— 失败原因（没授权 / 不支持 / 被拒）走 onState,
		* 因为这些都是用户能理解并处理的情况, 不该炸调用方。
		*/
		async start() {
			if (this.stream) return true;
			if (!navigator.mediaDevices?.getDisplayMedia) {
				this.options.onState("unsupported", "这个浏览器不支持屏幕捕获 (getDisplayMedia)");
				return false;
			}
			this.options.onState("requesting");
			let stream;
			try {
				stream = await navigator.mediaDevices.getDisplayMedia({
					video: {
						width: { ideal: 320 },
						height: { ideal: 180 },
						frameRate: {
							ideal: 4,
							max: 8
						}
					},
					audio: false
				});
			} catch (err) {
				const message = describeCaptureError(err);
				this.options.onState(message.includes("取消") ? "ended" : "denied", message);
				return false;
			}
			stream.getVideoTracks()[0]?.addEventListener("ended", () => {
				this.options.onState("ended", "屏幕共享已停止");
				this.dispose();
			});
			this.stream = stream;
			this.stopped = false;
			const video = document.createElement("video");
			video.srcObject = stream;
			video.muted = true;
			video.playsInline = true;
			this.video = video;
			const canvas = document.createElement("canvas");
			canvas.width = SAMPLE_SIZE;
			canvas.height = SAMPLE_SIZE;
			this.canvas = canvas;
			this.ctx = canvas.getContext("2d", { willReadFrequently: true });
			try {
				await video.play();
			} catch (err) {
				this.options.onState("denied", describeCaptureError(err));
				this.dispose();
				return false;
			}
			this.options.onState("running");
			this.scheduleFrame();
			return true;
		}
		/**
		* 挂下一帧回调。
		*
		* `requestVideoFrameCallback` 只在**真有新帧**时触发 —— 屏幕静止时
		* 一次回调都不来, CPU 占用是 0。用 `setInterval` 的话每秒空转 4 次。
		*/
		scheduleFrame() {
			if (this.stopped || !this.video) return;
			const video = this.video;
			if (typeof video.requestVideoFrameCallback === "function") {
				this.frameCallback = video.requestVideoFrameCallback(() => {
					if (this.stopped) return;
					this.sample();
					this.scheduleFrame();
				});
				return;
			}
			this.frameCallback = window.setTimeout(() => {
				if (this.stopped) return;
				this.sample();
				this.scheduleFrame();
			}, 250);
		}
		/** 采一帧, 算主色 */
		sample() {
			const video = this.video;
			const ctx = this.ctx;
			if (!video || !ctx || this.stopped) return;
			const width = video.videoWidth;
			const height = video.videoHeight;
			if (width === 0 || height === 0) return;
			if (this.lastSize?.width !== width || this.lastSize?.height !== height) {
				this.lastSize = {
					width,
					height
				};
				this.options.onSize?.({
					width,
					height
				});
			}
			try {
				ctx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
				const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
				if (isFullyBlack(data)) {
					this.blackFrames++;
					if (this.blackFrames >= BLACK_FRAME_THRESHOLD && !this.warnedBlack) {
						this.warnedBlack = true;
						this.options.onState("no-permission", "抓到的是全黑画面 —— 系统可能还没给「屏幕录制」权限（macOS: 系统设置 › 隐私与安全性 › 屏幕录制）");
					}
				} else {
					this.blackFrames = 0;
					this.warnedBlack = false;
				}
				const color = dominantColor(data);
				if (color) this.options.onSample(color);
			} catch {}
		}
		/** 连续全黑的帧数 */
		blackFrames = 0;
		/** 是否已经就「全黑」提示过一次 */
		warnedBlack = false;
		lastSize = null;
		/** 停止捕获并彻底释放。**卸载时必须调** */
		stop() {
			this.stopped = true;
			if (this.frameCallback !== null) {
				const video = this.video;
				if (video && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(this.frameCallback);
				window.clearTimeout(this.frameCallback);
				this.frameCallback = null;
			}
			this.dispose();
			this.options.onState("idle");
		}
		/** 释放媒体资源（不通知状态） */
		dispose() {
			this.stream?.getTracks().forEach((track) => track.stop());
			this.stream = null;
			if (this.video) {
				this.video.srcObject = null;
				this.video = null;
			}
			this.ctx = null;
			this.canvas = null;
		}
	};
	/**
	* 把 `getDisplayMedia` 的异常翻译成人话。
	*
	* `DOMException` 的 name 是稳定的, message 各家浏览器不同 —— 所以按 name 判,
	* 不按 message 判。
	*/
	function describeCaptureError(err) {
		if (!(err instanceof Error)) return "屏幕捕获失败";
		const name = err.name;
		switch (name) {
			case "NotAllowedError": return "屏幕捕获被拒绝（需要在浏览器弹窗里允许共享）";
			case "NotFoundError": return "没有找到可捕获的屏幕";
			case "NotSupportedError": return "这个环境不支持屏幕捕获";
			case "SecurityError": return "屏幕捕获被安全策略拦下";
			case "AbortError": return "屏幕捕获已取消";
			default: return err.message || `屏幕捕获失败 (${name})`;
		}
	}
	// src/settings.ts
	var DEFAULT_SETTINGS = {
		enabled: true,
		strength: .55,
		responsiveness: .5,
		breathe: .6
	};
	var KEY = "meng.plugin.screen-ambient.settings";
	/** 读设置。坏数据 / 存不下 → 默认值 */
	function readSettings() {
		try {
			const raw = localStorage.getItem(KEY);
			if (!raw) return { ...DEFAULT_SETTINGS };
			return normalize(JSON.parse(raw));
		} catch {
			return { ...DEFAULT_SETTINGS };
		}
	}
	/** 写设置。存不下就静默失败 —— 界面不该因为存不下而崩 */
	function writeSettings(settings) {
		try {
			localStorage.setItem(KEY, JSON.stringify(normalize(settings)));
		} catch {}
	}
	/**
	* 归一化 —— **每个字段都要夹紧**。
	*
	* 为什么: 设置是从 localStorage 读出来的, 而 localStorage 里什么都能被写
	* （别的脚本、手改、上一版插件留下的旧结构）。一个 `strength: 999` 会让
	* alpha 算出来爆掉, 一个 `enabled: "yes"` 会被当真值用。
	* 所以这里不信任任何值, 一律夹回合法区间。
	*/
	function normalize(input) {
		return {
			enabled: input.enabled === void 0 ? DEFAULT_SETTINGS.enabled : Boolean(input.enabled),
			strength: clamp(input.strength, DEFAULT_SETTINGS.strength, 0, 1),
			responsiveness: clamp(input.responsiveness, DEFAULT_SETTINGS.responsiveness, 0, 1),
			breathe: clamp(input.breathe, DEFAULT_SETTINGS.breathe, 0, 1)
		};
	}
	function clamp(value, fallback, min, max) {
		const n = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(n)) return fallback;
		return n < min ? min : n > max ? max : n;
	}
	// src/client-entry.tsx
	/**
	* screen-ambient 的 bundle 入口 —— 执行后**只**注册 factory, 不跑任何副作用。
	*
	* 这是 docs/08 §1 那句「执行 ≠ 装载」的样板:
	*   执行这一行代码时, CSS 没注入、slot 没注册、屏幕没抓;
	*   全部锁在 factory 闭包里, 等 shell 调用 `apply` 时才发生。
	* 顺序因此自解: 谁先被下载、谁先被执行都无所谓。
	*
	* `__MENG_LOADER__` 由宿主注入 (modules/client 的 evaluate), 不是真全局。
	*
	* ── 这个插件做了什么 ──
	*
	* 抓屏幕 → 逐帧采样降采样后的画面 → 算主色调 → 写进宿主的环境光 token
	* (`--meng-alias-ambient-a/b/c`) → 宿主的 `.shell::before` 三块径向渐变
	* 就跟着屏幕主色变, 并由 CSS 动画做缓慢的明暗呼吸。
	*
	* **为什么不自己插一层背景**: 宿主已经有环境光层了, 而且它是**三块**渐变。
	* 自己再插一层就是两层光叠着, 反而脏。改 token 才是干净的做法 ——
	* 宿主为此专门留了这三个 token, 它们就是给人换的。
	*/
	var ID = "screen-ambient";
	var LAYER_ID = "screen-ambient";
	__MENG_LOADER__.load({
		id: ID,
		factory: () => ({
			/**
			* 只声明 `slots`。
			*
			* **为什么不声明 `theme`**: shell 会校验 inject 里每个能力面是否真的存在,
			* 缺了就判 pending —— 插件永远挂着, 而不是失败, 报错信息还指向
			* 「等待能力面」这种看不懂的地方。
			*
			* `theme` 只有 web shell 提供 (桌面端主进程没有注册它), 而这个插件
			* 本来就只跑 web 端 (抓屏依赖 getDisplayMedia)。但**声明 inject 是给
			* shell 看的**: 少声明一个, 就多一份「运行时才发现缺」的余地。
			* 这里改成**运行时检查** —— 缺 theme 时给出明确的中文提示并停用功能,
			* 而不是让 shell 挂起。
			*/
			inject: ["slots"],
			apply(ctx) {
				const slots = ctx.get("slots");
				if (!slots) throw new Error(`${ID} 需要 slots 能力面`);
				const theme = ctx.get("theme");
				const style = document.createElement("style");
				style.setAttribute("data-plugin", ID);
				style.textContent = panel_default;
				document.head.appendChild(style);
				let settings = readSettings();
				let snapshot = {
					state: "idle",
					color: null,
					message: ""
				};
				let capture = null;
				let driver = null;
				/** 呼吸 CSS 单独一张表 —— 它有自己的 data-plugin 标记, 卸载时一并摘掉 */
				let breathStyle = null;
				/** 当前是深色还是浅色。决定环境光该亮还是该暗 */
				function currentMode() {
					return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
				}
				function driverConfig() {
					return {
						strength: settings.strength,
						responsiveness: settings.responsiveness,
						mode: currentMode(),
						breathe: settings.breathe
					};
				}
				/**
				* 呼吸动画的 style。
				*
				* 只有**真的支持 @property** 才注入 —— 不支持的话自定义属性不可插值,
				* 动画会在 50% 处生硬跳变, 那还不如不呼吸。
				*/
				function ensureBreathStyle() {
					if (!CAN_BREATHE) return;
					if (breathStyle?.isConnected) return;
					breathStyle = document.createElement("style");
					breathStyle.setAttribute("data-plugin", `${ID}-breath`);
					breathStyle.textContent = BREATH_CSS;
					document.head.appendChild(breathStyle);
				}
				/**
				* 一个极小的订阅机制 —— 插件不引状态库, 一个 Set 就够了。
				*
				* 这个插件的状态就三样: 设置、抓屏快照、驱动状态。
				*/
				const listeners = /* @__PURE__ */ new Set();
				function notify() {
					for (const fn of listeners) fn();
				}
				function subscribe(fn) {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				}
				/**
				* 开始抓屏。
				*
				* **必须在用户手势的调用栈里** —— 浏览器硬要求。所以它由设置页的
				* 「开始共享」按钮调用, 而不是 apply 里自动开始。
				*/
				async function startCapture() {
					if (capture?.active) return;
					if (!theme) {
						snapshot = {
							state: "unsupported",
							color: null,
							message: "这个宿主没有提供 theme 能力面, 无法驱动环境光"
						};
						notify();
						return;
					}
					ensureBreathStyle();
					capture = new ScreenCapture({
						onSample: (color) => {
							snapshot = {
								...snapshot,
								color
							};
							if (!driver) driver = new AmbientDriver(LAYER_ID, theme, driverConfig());
							driver.update(color);
						},
						onState: (state, message) => {
							snapshot = {
								...snapshot,
								state,
								message: message ?? ""
							};
							/**
							* 停了就撤掉环境光这一层, 让宿主配色重新露出来。
							*
							* **`no-permission` 不撤** —— 那只是「画面全黑」的提示, 捕获本身
							* 还在跑。用户去系统设置里给了权限、重启应用之后, 采样会自己恢复。
							* 把它当成「停了」反而会误导用户以为要重新点一次。
							*/
							if (state === "idle" || state === "ended" || state === "denied") {
								driver?.dispose();
								driver = null;
								snapshot = {
									...snapshot,
									color: null
								};
							}
							notify();
						},
						onSize: (size) => {
							snapshot = {
								...snapshot,
								size
							};
							notify();
						}
					});
					await capture.start();
				}
				function stopCapture() {
					capture?.stop();
					capture = null;
				}
				function updateSettings(next) {
					settings = next;
					writeSettings(settings);
					driver?.reconfigure(driverConfig());
					notify();
				}
				const bridge = {
					get settings() {
						return settings;
					},
					get snapshot() {
						return snapshot;
					},
					onSettings: updateSettings,
					onStart: () => {
						startCapture();
					},
					onStop: stopCapture
				};
				/**
				* 分区组件。
				*
				* 宿主每次渲染分区都新建这个函数 → React 会把它当成**新组件**,
				* 于是每次渲染都卸载重挂, 状态全丢。所以订阅必须建立在**组件内部**,
				* 不能靠父组件传 props。
				*/
				function SettingsSection() {
					const [, setTick] = (0, react.useState)(0);
					(0, react.useEffect)(() => {
						return subscribe(() => setTick((n) => n + 1));
					}, []);
					return (0, react.createElement)(Panel, { bridge });
				}
				const off = slots.register(ID, {
					name: "settings.section",
					component: SettingsSection,
					order: 900,
					meta: {
						label: "屏幕环境光",
						group: "插件",
						origin: "external"
					}
				});
				return () => {
					off();
					style.remove();
					breathStyle?.remove();
					/**
					* 停掉抓屏。**必须** —— 忘了停, 屏幕共享指示灯会一直亮着,
					* 用户会以为被监控了。
					*/
					stopCapture();
					driver?.dispose();
					driver = null;
					listeners.clear();
				};
			}
		})
	});
})(__MENG_REQUIRE__("react"), __MENG_REQUIRE__("react/jsx-runtime"));
