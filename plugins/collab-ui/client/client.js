(function(react, react_jsx_runtime) {
	// \0rolldown/runtime.js
	var __create = Object.create;
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __getProtoOf = Object.getPrototypeOf;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: ((k) => from[k]).bind(null, key),
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
		value: mod,
		enumerable: true
	}) : target, mod));
	react = __toESM(react, 1);
	// src/collab.css?inline
	var collab_default = ".collab-root { position: relative; flex: none; }\n.collab-trigger {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: var(--meng-specific-control-h);\n  padding: 0 8px;\n  border: 1px solid transparent;\n  border-radius: var(--meng-specific-radius-full);\n  background: transparent;\n  color: var(--meng-alias-fg-muted);\n  font: inherit;\n  font-size: var(--meng-specific-text-xs);\n  cursor: pointer;\n  white-space: nowrap;\n}\n.collab-trigger:hover { color: var(--meng-alias-fg-secondary); background: var(--meng-alias-bg-hover); }\n.collab-trigger[data-active=\"true\"] { color: var(--meng-alias-fg-primary); border-color: var(--meng-alias-border-l1); background: var(--meng-alias-bg-inset); }\n.collab-symbol { display: inline-flex; gap: 2px; align-items: flex-end; height: 10px; }\n.collab-symbol i { display: block; width: 2px; border-radius: 2px; background: currentColor; opacity: .55; }\n.collab-symbol i:nth-child(1) { height: 5px; }\n.collab-symbol i:nth-child(2) { height: 9px; }\n.collab-symbol i:nth-child(3) { height: 7px; }\n.collab-trigger[data-active=\"true\"] .collab-symbol i { opacity: 1; color: var(--meng-alias-positive); }\n.collab-chevron { font-size: 10px; opacity: .65; }\n.collab-pop {\n  position: absolute;\n  left: 0;\n  bottom: calc(100% + 8px);\n  z-index: 40;\n  width: min(330px, calc(100vw - 40px));\n  overflow: hidden;\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: 14px;\n  background: color-mix(in srgb, var(--meng-alias-bg-raised) 96%, transparent);\n  box-shadow: 0 18px 48px color-mix(in srgb, var(--meng-alias-fg-primary) 14%, transparent);\n  backdrop-filter: blur(18px) saturate(1.1);\n}\n.collab-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px; padding: 5px; border-bottom: 1px solid var(--meng-alias-border-l1); background: var(--meng-alias-bg-inset); }\n.collab-tabs button { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; height: 28px; padding: 0 4px; border: 0; border-radius: 8px; background: transparent; color: var(--meng-alias-fg-muted); font: inherit; font-size: var(--meng-specific-text-xs); cursor: pointer; }\n.collab-tabs button:hover { color: var(--meng-alias-fg-primary); background: var(--meng-alias-bg-hover); }\n.collab-tabs button[data-active=\"true\"] { color: var(--meng-alias-fg-primary); background: var(--meng-alias-bg-surface); box-shadow: 0 1px 5px color-mix(in srgb, var(--meng-alias-fg-primary) 7%, transparent); }\n.collab-tabs button span { padding: 1px 4px; border-radius: 999px; background: var(--meng-alias-bg-active); color: var(--meng-alias-fg-muted); font-variant-numeric: tabular-nums; }\n.collab-tabs button i { width: 5px; height: 5px; border-radius: 50%; background: var(--meng-alias-positive); box-shadow: 0 0 7px color-mix(in srgb, var(--meng-alias-positive) 40%, transparent); }\n.collab-panel { min-height: 112px; padding: 12px; }\n.collab-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }\n.collab-row strong, .collab-summary strong { color: var(--meng-alias-fg-primary); font-size: var(--meng-specific-text-sm); }\n.collab-row p, .collab-objective, .collab-reason { margin: 4px 0 0; color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); line-height: 1.5; }\n.collab-primary, .collab-actions button { flex: none; height: 28px; padding: 0 10px; border: 1px solid var(--meng-alias-border-l1); border-radius: 8px; background: var(--meng-alias-bg-surface); color: var(--meng-alias-fg-secondary); font: inherit; font-size: var(--meng-specific-text-xs); cursor: pointer; }\n.collab-primary:hover:not(:disabled), .collab-actions button:hover:not(:disabled) { color: var(--meng-alias-fg-primary); background: var(--meng-alias-bg-hover); }\n.collab-primary:disabled, .collab-actions button:disabled { opacity: .5; cursor: default; }\n.collab-summary { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }\n.collab-summary span { color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.collab-todos { display: grid; gap: 5px; max-height: 180px; overflow: auto; margin: 0; padding: 0; list-style: none; }\n.collab-todos li { display: flex; gap: 7px; color: var(--meng-alias-fg-secondary); font-size: var(--meng-specific-text-xs); line-height: 1.45; }\n.collab-todos li > span:first-child { flex: none; width: 12px; color: var(--meng-alias-positive); text-align: center; }\n.collab-todos li[data-status=\"in_progress\"] { color: var(--meng-alias-fg-primary); }\n.collab-todos li[data-status=\"in_progress\"] > span:first-child { color: var(--meng-alias-warning); }\n.collab-todos li[data-status=\"completed\"] { color: var(--meng-alias-fg-muted); text-decoration: line-through; }\n.collab-objective { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }\n.collab-reason { color: var(--meng-alias-danger); }\n.collab-actions { display: flex; gap: 6px; margin-top: 10px; }\n.collab-agent-list { display: grid; gap: 5px; color: var(--meng-alias-fg-secondary); font-size: var(--meng-specific-text-xs); }\n.collab-empty { margin: 20px 0; color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); text-align: center; }\n@media (max-width: 560px) { .collab-trigger > span:nth-child(2) { max-width: 70px; overflow: hidden; text-overflow: ellipsis; } }\n";
	// src/client-entry.tsx
	var ID = "collab-ui";
	__MENG_LOADER__.load({
		id: ID,
		factory: () => ({
			inject: ["slots", "transport"],
			apply(ctx) {
				const slots = ctx.get("slots");
				const transport = ctx.get("transport");
				if (!slots) throw new Error("collab-ui 需要 slots");
				const style = document.createElement("style");
				style.dataset.plugin = ID;
				style.textContent = collab_default;
				document.head.appendChild(style);
				const off = slots.register(ID, {
					name: "composer.tools",
					component: (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CollabMenu, {
						transport,
						sessionId: props.sessionId,
						busy: props.busy,
						ensureSession: props.ensureSession
					}),
					order: 10,
					meta: {
						label: "协作",
						group: "协作",
						origin: "builtin"
					}
				});
				return () => {
					off();
					style.remove();
				};
			}
		})
	});
	function CollabMenu({ transport, sessionId, busy, ensureSession }) {
		const [open, setOpen] = react.useState(false);
		const [tab, setTab] = react.useState("plan");
		const [planActive, setPlanActive] = react.useState(false);
		const [todos, setTodos] = react.useState([]);
		const [goal, setGoal] = react.useState();
		const [runs, setRuns] = react.useState([]);
		const [working, setWorking] = react.useState(false);
		const root = react.useRef(null);
		const resolvedSession = react.useRef(sessionId);
		react.useEffect(() => {
			resolvedSession.current = sessionId;
		}, [sessionId]);
		const load = react.useCallback(() => {
			if (!transport || !sessionId) {
				setPlanActive(false);
				setTodos([]);
				setGoal(void 0);
				setRuns([]);
				return;
			}
			Promise.all([
				transport.invoke("plan.status", { sessionId }),
				transport.invoke("todo.status", { sessionId }),
				transport.invoke("goal.status", { sessionId }),
				transport.invoke("subagent.status", { sessionId })
			]).then(([plan, todo, goalResult, agent]) => {
				setPlanActive(plan.active === true);
				setTodos(todo.todos ?? []);
				setGoal(goalResult.goal ?? void 0);
				setRuns((agent.runs ?? []).filter((run) => run.running));
			}).catch(() => {
				setPlanActive(false);
				setTodos([]);
				setGoal(void 0);
				setRuns([]);
			});
		}, [transport, sessionId]);
		react.useEffect(load, [load]);
		react.useEffect(() => {
			if (!transport || !sessionId) return;
			return transport.subscribe((event) => {
				if (event.sessionId !== sessionId) return;
				if (event.type === "plan/mode" || event.type === "plan/submitted" || event.type === "todo/write" || event.type === "goal/change" || event.type === "subagent/started" || event.type === "subagent/completed") load();
			});
		}, [
			transport,
			sessionId,
			load
		]);
		react.useEffect(() => {
			if (!open) return;
			const onDown = (event) => {
				if (root.current && !root.current.contains(event.target)) setOpen(false);
			};
			const onKey = (event) => {
				if (event.key === "Escape") setOpen(false);
			};
			document.addEventListener("mousedown", onDown);
			document.addEventListener("keydown", onKey);
			return () => {
				document.removeEventListener("mousedown", onDown);
				document.removeEventListener("keydown", onKey);
			};
		}, [open]);
		const completed = todos.filter((item) => item.status === "completed").length;
		const activeRuns = runs.length;
		const activeLabel = planActive ? "Plan" : goal?.phase === "active" ? "Goal" : todos.length > 0 ? `Todo ${completed}/${todos.length}` : activeRuns > 0 ? "子智能体" : "协作";
		const hasActivity = planActive || todos.length > 0 || goal !== void 0 || activeRuns > 0;
		async function sid() {
			const current = resolvedSession.current;
			if (current) return current;
			const created = await ensureSession?.("协作任务");
			if (created) resolvedSession.current = created;
			return created;
		}
		async function togglePlan() {
			if (!transport || working) return;
			setWorking(true);
			try {
				const target = await sid();
				if (!target) return;
				await transport.invoke("plan.set", {
					sessionId: target,
					active: !planActive
				});
				setPlanActive((value) => !value);
				setOpen(false);
			} finally {
				setWorking(false);
			}
		}
		async function controlGoal(action) {
			if (!transport || !sessionId || working) return;
			setWorking(true);
			try {
				await transport.invoke("goal.control", {
					sessionId,
					action
				});
				load();
			} finally {
				setWorking(false);
			}
		}
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "collab-root",
			ref: root,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "collab-trigger",
				"data-active": hasActivity ? "true" : "false",
				"aria-haspopup": "menu",
				"aria-expanded": open,
				title: "计划、待办、长期目标和子智能体",
				onClick: () => setOpen((value) => !value),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "collab-symbol",
						"aria-hidden": "true",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: activeLabel }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "collab-chevron",
						"aria-hidden": "true",
						children: "⌄"
					})
				]
			}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "collab-pop",
				role: "menu",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "collab-tabs",
						role: "tablist",
						"aria-label": "协作类型",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabButton, {
								value: "plan",
								selected: tab,
								set: setTab,
								label: "Plan"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabButton, {
								value: "todo",
								selected: tab,
								set: setTab,
								label: "Todo",
								count: todos.length ? `${completed}/${todos.length}` : void 0
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabButton, {
								value: "goal",
								selected: tab,
								set: setTab,
								label: "Goal",
								dot: goal?.phase === "active"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabButton, {
								value: "agents",
								selected: tab,
								set: setTab,
								label: "子智能体",
								count: activeRuns ? String(activeRuns) : void 0
							})
						]
					}),
					tab === "plan" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "collab-panel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "collab-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: planActive ? "Plan 模式开启" : "先规划再执行" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: planActive ? "当前只调研，方案批准后才退出。" : "进入后会先出完整方案，等你批准。" })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "collab-primary",
								disabled: working || busy,
								onClick: () => void togglePlan(),
								children: planActive ? "退出" : "进入"
							})]
						})
					}),
					tab === "todo" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "collab-panel",
						children: todos.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "当前还没有执行清单" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "collab-summary",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
								completed,
								"/",
								todos.length
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "已完成" })]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
							className: "collab-todos",
							children: todos.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								"data-status": item.status,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: item.status === "completed" ? "✓" : item.status === "in_progress" ? "•" : ""
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.content })]
							}, item.content))
						})] })
					}),
					tab === "goal" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "collab-panel",
						children: goal ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "collab-summary",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
									goal.roundsStarted,
									"/",
									goal.maxGoalRounds
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: phaseLabel(goal.phase) })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "collab-objective",
								children: goal.objective
							}),
							goal.blockedReason && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "collab-reason",
								children: goal.blockedReason
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "collab-actions",
								children: [
									goal.phase === "active" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: working,
										onClick: () => void controlGoal("pause"),
										children: "暂停"
									}),
									(goal.phase === "paused" || goal.phase === "blocked") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: working,
										onClick: () => void controlGoal("resume"),
										children: "继续"
									}),
									goal.phase === "active" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: working,
										onClick: () => void controlGoal("complete"),
										children: "完成"
									})
								]
							})
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "当前没有长期目标" })
					}),
					tab === "agents" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "collab-panel",
						children: activeRuns.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Empty, { text: "当前没有运行中的子智能体" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "collab-summary",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: activeRuns.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "个独立会话运行中" })]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "collab-agent-list",
							children: activeRuns.map((run) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["子智能体 · ", run.sessionId.slice(-8)] }, run.id))
						})] })
					})
				]
			})]
		});
	}
	function TabButton({ value, selected, set, label, count, dot }) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			role: "tab",
			"aria-selected": selected === value,
			"data-active": selected === value ? "true" : "false",
			onClick: () => set(value),
			children: [
				label,
				count ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: count }) : null,
				dot ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { "aria-hidden": "true" }) : null
			]
		});
	}
	function Empty({ text }) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: "collab-empty",
			children: text
		});
	}
	function phaseLabel(phase) {
		if (phase === "active") return "自动续轮";
		if (phase === "paused") return "已暂停";
		if (phase === "completed") return "已完成";
		return "已阻塞";
	}
})(__MENG_REQUIRE__("react"), __MENG_REQUIRE__("react/jsx-runtime"));
