(function(react, react_jsx_runtime) {
	// ../../plugins/demo-ui/src/panel.css?inline
	var panel_default = "/*\n * demo-ui 的样式。\n *\n * 以 `?inline` 导入成字符串, 由 factory 在**物化时**注入 (docs/08 §1: 副作用锁在 factory 里),\n * 并打上 `data-plugin=\"demo-ui\"` (docs/08 §6: 显式标记, 运行期只回收带自己标记的)。\n *\n * 用变量时守住 §4.2 那条: 颜色一律取 `--meng-alias-*`(宿主换肤时这一块跟着变),\n * 尺寸取 `--meng-specific-*`(结构层, 可以读, 不许改)。插件自己发明色值是绕过对比度审计。\n */\n\n.demo-ui-card {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-2);\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n  font-size: var(--meng-specific-text-sm);\n  color: var(--meng-alias-fg-secondary);\n}\n\n.demo-ui-card__title {\n  display: flex;\n  align-items: center;\n  gap: var(--meng-specific-space-2);\n  font-weight: var(--meng-specific-weight-strong);\n  color: var(--meng-alias-fg-primary);\n}\n\n.demo-ui-card__note {\n  color: var(--meng-alias-fg-muted);\n  font-size: var(--meng-specific-text-xs);\n  line-height: 1.5;\n}\n\n.demo-ui-card__button {\n  align-self: flex-start;\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l2);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-primary);\n  font: inherit;\n  cursor: pointer;\n}\n\n.demo-ui-card__button:hover {\n  background: var(--meng-alias-bg-hover);\n}\n\n/* ── 设置分区外壳（2026-11-17 起它是个 settings.section）── */\n\n.demo-ui-section {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-3);\n  max-width: 640px;\n}\n\n.demo-ui-section__lead {\n  margin: 0;\n  color: var(--meng-alias-fg-secondary);\n  font-size: var(--meng-specific-text-sm);\n  line-height: 1.6;\n}\n\n.demo-ui-section__lead code {\n  padding: 1px 4px;\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  font-family: var(--meng-specific-font-mono);\n  font-size: 11.5px;\n}\n";
	// ../../plugins/demo-ui/src/Panel.tsx
	/**
	* demo-ui 注册的那个**设置分区**（`settings.section`）。
	*
	* 2026-11-17 之前它挂在 `sidebar.footer` —— 侧栏底部一块"外部 bundle"卡片。
	* 那块地方现在归设置入口（左下角），而这张卡片本质上是个**诊断页**：
	* 它要证明的是"这段 UI 不在主应用产物里，却和宿主共用同一份 React"，
	* 放设置里比放在每天都看的侧栏里合适得多。
	*
	* 而且换到 `settings.section` 之后它证明的东西**更多**了：设置页左导航里
	* 那一项「外部 bundle」就是这个 bundle 自己注册的 —— 宿主没有为它写过一行代码。
	*
	* 这个文件里的 `import` 全部会被构建成 external (见 vite.plugin.config.ts 的
	* `output.globals`)，产物里落在 `__MENG_REQUIRE__("react")` 这种调用上 ——
	* 于是插件**不会**自带第二份 React，宿主与插件共用同一个实例。
	* 这也是 F5 最想证明的一件事: 插件是"外来的代码", 但 UI 状态跟宿主是一体的。
	*/
	function Panel() {
		const [clicks, setClicks] = (0, react.useState)(0);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "demo-ui-section",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "demo-ui-section__lead",
				children: [
					"这一页来自 ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "/plugins/demo-ui/client.js" }),
					"：它不在主应用产物里， 是运行时下载、执行、再挂进槽位的。左边导航里「外部 bundle」这一项也是它自己注册的 —— 宿主没有为它写过一行代码。"
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "demo-ui-card",
				"data-testid": "demo-ui-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "demo-ui-card__title",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "外部 bundle" })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "demo-ui-card__note",
						children: "React 用的是宿主那一份（构建期 external）。所以下面这个计数能加 —— hooks 活着，说明没有第二份 React。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "demo-ui-card__button",
						"data-testid": "demo-ui-button",
						onClick: () => setClicks((n) => n + 1),
						children: [
							"点了 ",
							clicks,
							" 次"
						]
					})
				]
			})]
		});
	}
	// ../../plugins/demo-ui/src/client-entry.tsx
	/**
	* demo-ui 的 bundle 入口 —— 执行后**只**注册 factory, 不跑任何副作用。
	*
	* 这是 docs/08 §1 那句 "执行 ≠ 装载" 的样板:
	*   执行这一行代码时, CSS 没注入、slot 没注册、React 没渲染;
	*   全部锁在 factory 闭包里, 等 shell 调用 `apply` 时才发生。
	* 顺序因此自解: 谁先被下载、谁先被执行都无所谓。
	*
	* `__MENG_LOADER__` / `__MENG_REQUIRE__` 由宿主注入 (modules/client 的 evaluate),
	* 不是真全局 —— 所以这段代码在 node 里也能被装载、被断言。
	*/
	var ID = "demo-ui";
	__MENG_LOADER__.load({
		id: ID,
		factory: () => {
			return {
				inject: ["slots"],
				apply(ctx) {
					const slots = ctx.get("slots");
					if (!slots) throw new Error(`${ID} 需要 slots 能力面`);
					const style = document.createElement("style");
					style.setAttribute("data-plugin", ID);
					style.textContent = panel_default;
					document.head.appendChild(style);
					const off = slots.register(ID, {
						name: "settings.section",
						component: Panel,
						order: 900,
						meta: {
							label: "外部 bundle",
							group: "插件",
							origin: "local"
						}
					});
					return () => {
						off();
						style.remove();
					};
				}
			};
		}
	});
})(__MENG_REQUIRE__("react"), __MENG_REQUIRE__("react/jsx-runtime"));
