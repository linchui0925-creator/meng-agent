(function(react_jsx_runtime, _meng_ui) {
	// src/theme.css?inline
	var theme_default = "/* ── 主题导航 ──\n   一行三个图标按钮: 侧栏只有 264px, 三个带文字的项会挤成两行。\n   当前项靠背景 + 底边高亮说话, 文字只留给读屏和 tooltip。 */\n\n.theme-group {\n  margin-top: var(--meng-specific-space-2);\n  padding-top: var(--meng-specific-space-2);\n  border-top: 1px solid var(--meng-alias-border-l1);\n}\n\n.theme-head {\n  display: flex;\n  align-items: center;\n  gap: var(--meng-specific-space-2);\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-2);\n  color: var(--meng-alias-fg-muted);\n  font-size: var(--meng-specific-text-xs);\n  letter-spacing: 0.06em;\n}\n\n/* 当前模式写在组标题右边: 一眼知道现在是什么, 又不用三个按钮各带一段文字 */\n.theme-current {\n  margin-left: auto;\n  letter-spacing: 0;\n  color: var(--meng-alias-fg-secondary);\n}\n\n.theme-items {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: var(--meng-specific-space-1);\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-2);\n}\n\n.theme-item {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  min-height: 28px;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-muted);\n  font: inherit;\n  font-size: var(--meng-specific-text-xs);\n  cursor: pointer;\n}\n\n.theme-item:hover {\n  background: var(--meng-alias-bg-hover);\n  color: var(--meng-alias-fg-secondary);\n}\n\n.theme-item[data-active] {\n  background: var(--meng-alias-bg-surface);\n  border-color: var(--meng-alias-border-l1);\n  color: var(--meng-alias-fg-primary);\n}\n\n.theme-item:focus-visible {\n  outline: 2px solid var(--meng-alias-focus-ring);\n  outline-offset: -2px;\n}\n\n.theme-item svg {\n  width: 13px;\n  height: 13px;\n  flex: none;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.4;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\n\n.theme-item[data-active] svg {\n  color: var(--meng-alias-accent);\n}\n\n";
	// src/theme-nav.ts
	/** 「跟随系统」。单独提出来是因为它是兜底值, themeNavOption 要拿它当默认 */
	var SYSTEM = {
		id: "system",
		label: "跟随系统",
		icon: "system"
	};
	var THEME_NAV_OPTIONS = [
		SYSTEM,
		{
			id: "light",
			label: "浅色",
			icon: "sun"
		},
		{
			id: "dark",
			label: "深色",
			icon: "moon"
		}
	];
	/**
	* 某个主题模式对应哪个选项。
	*
	* 兜底回「跟随系统」而不是抛异常: 侧栏是**常驻**界面, 它崩了整屏都不可用。
	* 而不认识的模式本来就只可能来自脏数据 (prefs.ts 已经逐字段回落过,
	* 这里是第二道保险 —— 万一有别处塞进来一个 'purple', 侧栏照样能画)。
	*/
	function themeNavOption(mode) {
		return THEME_NAV_OPTIONS.find((o) => o.id === mode) ?? SYSTEM;
	}
	// src/ThemeNav.tsx
	function ThemeNav({ themeMode, onThemeChange }) {
		const current = themeNavOption(themeMode);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "theme-group",
			"data-theme-nav-group": "",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "theme-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "主题" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "theme-current",
					children: current.label
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "theme-items",
				role: "group",
				"aria-label": "主题",
				children: THEME_NAV_OPTIONS.map((option) => {
					const active = option.id === current.id;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "theme-item",
						"data-active": active ? "" : void 0,
						"aria-current": active ? "true" : void 0,
						"aria-label": option.label,
						title: option.label,
						onClick: () => onThemeChange(option.id),
						"data-theme-option": option.id,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThemeIcon, { icon: option.icon })
					}, option.id);
				})
			})]
		});
	}
	function ThemeIcon({ icon }) {
		if (icon === "sun") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			viewBox: "0 0 16 16",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "8",
				r: "3"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" })]
		});
		if (icon === "moon") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
			viewBox: "0 0 16 16",
			"aria-hidden": "true",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1Z" })
		});
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			viewBox: "0 0 16 16",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "2.2",
				y: "3",
				width: "11.6",
				height: "8",
				rx: "1.4"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 13.4h4M8 11v2.4" })]
		});
	}
	// src/ThemeToggle.tsx
	function ThemeToggle({ theme, onToggleTheme }) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_meng_ui.Tooltip, {
			label: `切到${theme === "dark" ? "浅色" : "深色"}`,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_meng_ui.IconButton, {
				"aria-label": "切换主题",
				size: "sm",
				onClick: onToggleTheme,
				"data-theme-toggle": "",
				children: theme === "dark" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 16 16",
					width: "16",
					height: "16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8",
						cy: "8",
						r: "3"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" })]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					viewBox: "0 0 16 16",
					width: "16",
					height: "16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1Z" })
				})
			})
		});
	}
	// src/client-entry.tsx
	/**
	* theme-ui 客户端插件入口：主题切换入口全部在这里，宿主只提供主题状态和能力。
	*/
	var ID = "theme-ui";
	__MENG_LOADER__.load({
		id: ID,
		factory: () => ({
			inject: ["slots"],
			apply(ctx) {
				const slots = ctx.get("slots");
				if (!slots) throw new Error(`${ID} 需要 slots 能力面`);
				const style = document.createElement("style");
				style.setAttribute("data-plugin", ID);
				style.textContent = theme_default;
				document.head.appendChild(style);
				const offNav = slots.register(ID, {
					name: "sidebar.utility",
					component: ThemeNav,
					order: 40,
					meta: {
						label: "主题",
						origin: "builtin"
					}
				});
				const offToggle = slots.register(ID, {
					name: "topbar.actions",
					component: ThemeToggle,
					order: 20,
					meta: {
						label: "主题切换",
						origin: "builtin"
					}
				});
				return () => {
					offNav();
					offToggle();
					style.remove();
				};
			}
		})
	});
})(__MENG_REQUIRE__("react/jsx-runtime"), __MENG_REQUIRE__("@meng/ui"));
