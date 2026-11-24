(function(react, react_jsx_runtime) {
	// src/market.css?inline
	var market_default = ".plugin-market {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-4);\n  max-width: 980px;\n  color: var(--meng-alias-fg-secondary);\n  font-size: var(--meng-specific-text-sm);\n}\n.plugin-market h3,\n.plugin-market h4,\n.plugin-market p { margin: 0; }\n.plugin-market h4 { color: var(--meng-alias-fg-primary); font-size: var(--meng-specific-text-sm); }\n.plugin-market__header,\n.plugin-market__card-heading {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--meng-specific-space-3);\n}\n.plugin-market__header > div { display: grid; gap: var(--meng-specific-space-1); }\n.plugin-market__tabs {\n  display: flex;\n  flex-wrap: wrap;\n  gap: var(--meng-specific-space-1);\n  padding: var(--meng-specific-space-1);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-inset);\n}\n.plugin-market__tab {\n  flex: 1 1 120px;\n  padding: var(--meng-specific-space-2) var(--meng-specific-space-3);\n  border: 0;\n  border-radius: var(--meng-specific-radius-sm);\n  background: transparent;\n  color: var(--meng-alias-fg-secondary);\n  font: inherit;\n  cursor: pointer;\n}\n.plugin-market__tab:hover { background: var(--meng-alias-bg-hover); }\n.plugin-market__tab.is-active {\n  background: var(--meng-alias-bg-raised);\n  color: var(--meng-alias-fg-primary);\n  box-shadow: var(--meng-alias-shadow-sm);\n}\n.plugin-market__panel { display: grid; gap: var(--meng-specific-space-4); }\n.plugin-market__row,\n.plugin-market__form {\n  display: flex;\n  gap: var(--meng-specific-space-2);\n  flex-wrap: wrap;\n}\n.plugin-market__form { align-items: flex-start; }\n.plugin-market__input {\n  flex: 1 1 260px;\n  min-width: 0;\n  padding: var(--meng-specific-space-2);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-primary);\n  font: inherit;\n}\n.plugin-market__textarea { flex-basis: 100%; min-height: 72px; resize: vertical; }\n.plugin-market__button {\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l2);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-primary);\n  font: inherit;\n  cursor: pointer;\n}\n.plugin-market__button:hover:not(:disabled) { background: var(--meng-alias-bg-hover); }\n.plugin-market__button:disabled { opacity: .5; cursor: not-allowed; }\n.plugin-market__button--danger { color: var(--meng-alias-danger); }\n.plugin-market__list { display: grid; gap: var(--meng-specific-space-3); }\n.plugin-market__card {\n  display: grid;\n  gap: var(--meng-specific-space-2);\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n}\n.plugin-market__card--inline {\n  grid-template-columns: minmax(150px, 1fr) minmax(190px, 1.5fr) auto auto;\n  align-items: center;\n}\n.plugin-market__title { color: var(--meng-alias-fg-primary); font-weight: var(--meng-specific-weight-strong); }\n.plugin-market__muted { color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.plugin-market__versions { display: flex; flex-wrap: wrap; gap: var(--meng-specific-space-2); }\n.plugin-market__code {\n  overflow-wrap: anywhere;\n  color: var(--meng-alias-fg-muted);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-xs);\n}\n.plugin-market__output {\n  max-height: 220px;\n  overflow: auto;\n  padding: var(--meng-specific-space-3);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-xs);\n  white-space: pre-wrap;\n}\n.plugin-market__metrics {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));\n  gap: var(--meng-specific-space-2);\n}\n.plugin-market__metric {\n  display: grid;\n  gap: var(--meng-specific-space-1);\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n}\n.plugin-market__metric span { color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.plugin-market__metric strong { color: var(--meng-alias-fg-primary); font-size: var(--meng-specific-text-lg); }\n.plugin-market__badge {\n  display: inline-flex;\n  align-items: center;\n  width: fit-content;\n  padding: 2px 8px;\n  border-radius: 999px;\n  font-size: var(--meng-specific-text-xs);\n  white-space: nowrap;\n}\n.plugin-market__badge--ok { background: var(--meng-alias-positive-subtle); color: var(--meng-alias-positive); }\n.plugin-market__badge--warn { background: var(--meng-alias-warning-subtle); color: var(--meng-alias-warning); }\n.plugin-market__badge--bad { background: var(--meng-alias-danger-subtle); color: var(--meng-alias-danger); }\n.plugin-market__event {\n  display: grid;\n  grid-template-columns: auto minmax(160px, 1fr) auto;\n  align-items: center;\n  gap: var(--meng-specific-space-2);\n  padding: var(--meng-specific-space-2) 0;\n  border-bottom: 1px solid var(--meng-alias-border-l1);\n}\n.plugin-market__note { grid-column: 2 / -1; color: var(--meng-alias-fg-secondary); }\n@media (max-width: 720px) {\n  .plugin-market__card--inline { grid-template-columns: 1fr auto; }\n  .plugin-market__card--inline .plugin-market__muted { grid-column: 1 / -1; }\n  .plugin-market__event { grid-template-columns: auto 1fr; }\n  .plugin-market__event > :last-child { grid-column: 2; }\n}\n";
	// src/MarketPanel.tsx
	var EMPTY_SUMMARY = {
		installs: 0,
		updates: 0,
		uninstalls: 0,
		workerCrashes: 0,
		feedback: 0,
		compatibility: {
			ok: 0,
			broken: 0,
			unknown: 0
		},
		byPlugin: {}
	};
	var TABS = [
		{
			id: "discover",
			label: "发现"
		},
		{
			id: "publishers",
			label: "发布者"
		},
		{
			id: "sources",
			label: "市场源"
		},
		{
			id: "telemetry",
			label: "反馈与遥测"
		}
	];
	function MarketPanel({ transport }) {
		const [tab, setTab] = (0, react.useState)("discover");
		const [dashboard, setDashboard] = (0, react.useState)({
			publishers: [],
			sources: [],
			installed: [],
			telemetry: EMPTY_SUMMARY
		});
		const [telemetry, setTelemetry] = (0, react.useState)({
			summary: EMPTY_SUMMARY,
			events: []
		});
		const [busy, setBusy] = (0, react.useState)("");
		const [output, setOutput] = (0, react.useState)("");
		const [sourceId, setSourceId] = (0, react.useState)("auto");
		const [customSource, setCustomSource] = (0, react.useState)(() => localStorage.getItem("meng.market.customSource") ?? "");
		const [channel, setChannel] = (0, react.useState)("stable");
		const [query, setQuery] = (0, react.useState)("");
		const [rolloutKey, setRolloutKey] = (0, react.useState)(() => localStorage.getItem("meng.market.rolloutKey") ?? "");
		const [plugins, setPlugins] = (0, react.useState)([]);
		const [updates, setUpdates] = (0, react.useState)([]);
		const [publisherId, setPublisherId] = (0, react.useState)("");
		const [publisherName, setPublisherName] = (0, react.useState)("");
		const [publisherKey, setPublisherKey] = (0, react.useState)("");
		const [sourceDraftId, setSourceDraftId] = (0, react.useState)("");
		const [sourceDraftName, setSourceDraftName] = (0, react.useState)("");
		const [sourceDraftCatalog, setSourceDraftCatalog] = (0, react.useState)("");
		const [sourceDraftSignature, setSourceDraftSignature] = (0, react.useState)("");
		const [sourceDraftTrustStore, setSourceDraftTrustStore] = (0, react.useState)("");
		const [sourceDraftMirrors, setSourceDraftMirrors] = (0, react.useState)("");
		const [sourceDraftPriority, setSourceDraftPriority] = (0, react.useState)("100");
		const [feedbackPluginId, setFeedbackPluginId] = (0, react.useState)("");
		const [feedbackVersion, setFeedbackVersion] = (0, react.useState)("");
		const [compatible, setCompatible] = (0, react.useState)("ok");
		const [rating, setRating] = (0, react.useState)("5");
		const [note, setNote] = (0, react.useState)("");
		const reloadDashboard = (0, react.useCallback)(async () => {
			if (!transport) return;
			try {
				const [nextDashboard, nextTelemetry] = await Promise.all([transport.invoke("pluginMarket.dashboard"), transport.invoke("pluginMarket.telemetry", { limit: 80 })]);
				setDashboard(nextDashboard);
				setTelemetry(nextTelemetry);
			} catch (error) {
				setOutput(errorText(error));
			}
		}, [transport]);
		(0, react.useEffect)(() => {
			reloadDashboard();
		}, [reloadDashboard]);
		(0, react.useEffect)(() => {
			const timer = setTimeout(() => localStorage.setItem("meng.market.customSource", customSource), 300);
			return () => clearTimeout(timer);
		}, [customSource]);
		(0, react.useEffect)(() => {
			const timer = setTimeout(() => localStorage.setItem("meng.market.rolloutKey", rolloutKey), 300);
			return () => clearTimeout(timer);
		}, [rolloutKey]);
		const sourcePayload = customSource.trim() ? { source: customSource.trim() } : { sourceId: sourceId === "auto" ? void 0 : sourceId };
		async function search() {
			if (!transport) return;
			setBusy("search");
			setOutput("");
			try {
				const result = await transport.invoke("pluginMarket.search", {
					...sourcePayload,
					query
				});
				setPlugins(result.plugins);
				setOutput(`目录：${result.catalog.name} · ${result.plugins.length} 个插件`);
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function checkUpdates() {
			if (!transport) return;
			setBusy("updates");
			setOutput("");
			try {
				const result = await transport.invoke("pluginMarket.updates", {
					...sourcePayload,
					channel,
					rolloutKey
				});
				setUpdates(result.updates);
				setOutput(result.updates.length ? `发现 ${result.updates.length} 个更新` : "已是最新");
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function install(pluginId, version) {
			if (!transport) return;
			const label = version ? `${pluginId}@${version}` : pluginId;
			if (!window.confirm(`安装 ${label}？`)) return;
			setBusy(`install:${pluginId}`);
			setOutput("");
			try {
				const result = await transport.invoke("pluginMarket.install", {
					...sourcePayload,
					pluginId,
					...version ? { version } : {},
					channel,
					rolloutKey,
					confirm: true
				});
				setOutput(`已安装 ${result.name}@${result.version}`);
				await reloadDashboard();
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function uninstall(name) {
			if (!transport) return;
			if (!window.confirm(`卸载 ${name}？插件数据会保留。`)) return;
			setBusy(`uninstall:${name}`);
			setOutput("");
			try {
				await transport.invoke("pluginMarket.uninstall", {
					name,
					confirm: true
				});
				setOutput(`已卸载 ${name}，数据已保留`);
				await reloadDashboard();
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function addPublisher() {
			if (!transport) return;
			setBusy("publisher:add");
			setOutput("");
			try {
				const created = await transport.invoke("pluginMarket.publisher.add", {
					id: publisherId,
					name: publisherName,
					publicKey: publisherKey,
					confirm: true
				});
				setPublisherId("");
				setPublisherName("");
				setPublisherKey("");
				setOutput(`发布者 ${created.name} 已登记，keyId ${created.keyId}`);
				await reloadDashboard();
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function setPublisher(publisher, suspended) {
			if (!transport) return;
			setBusy(`publisher:${publisher.id}`);
			try {
				await transport.invoke("pluginMarket.publisher.set", {
					id: publisher.id,
					suspended,
					confirm: true
				});
				setOutput(`${publisher.name} 已${suspended ? "暂停" : "恢复"}`);
				await reloadDashboard();
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function addSource() {
			if (!transport) return;
			setBusy("source:add");
			try {
				const created = await transport.invoke("pluginMarket.source.add", {
					id: sourceDraftId,
					name: sourceDraftName || sourceDraftId,
					catalog: sourceDraftCatalog,
					priority: Number(sourceDraftPriority) || 100,
					...sourceDraftSignature.trim() ? { signature: sourceDraftSignature.trim() } : {},
					...sourceDraftTrustStore.trim() ? { trustStore: sourceDraftTrustStore.trim() } : {},
					...sourceDraftMirrors.split("\n").map((item) => item.trim()).filter(Boolean).length ? { mirrors: sourceDraftMirrors.split("\n").map((item) => item.trim()).filter(Boolean) } : {},
					confirm: true
				});
				setSourceDraftId("");
				setSourceDraftName("");
				setSourceDraftCatalog("");
				setSourceDraftSignature("");
				setSourceDraftTrustStore("");
				setSourceDraftMirrors("");
				setSourceDraftPriority("100");
				setSourceId(created.id);
				setOutput(`市场源 ${created.name} 已添加`);
				await reloadDashboard();
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function setSource(source, patch) {
			if (!transport) return;
			setBusy(`source:${source.id}`);
			try {
				await transport.invoke("pluginMarket.source.set", {
					id: source.id,
					...patch,
					confirm: true
				});
				await reloadDashboard();
				setOutput(`${source.name} 已更新`);
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function removeSource(source) {
			if (!transport) return;
			if (!window.confirm(`删除市场源 ${source.name}？`)) return;
			setBusy(`source:${source.id}`);
			try {
				await transport.invoke("pluginMarket.source.remove", {
					id: source.id,
					confirm: true
				});
				if (sourceId === source.id) setSourceId("auto");
				await reloadDashboard();
				setOutput(`市场源 ${source.name} 已删除`);
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function submitFeedback() {
			if (!transport) return;
			setBusy("feedback");
			try {
				await transport.invoke("pluginMarket.feedback", {
					pluginId: feedbackPluginId,
					version: feedbackVersion,
					compatible,
					rating: Number(rating),
					note
				});
				setNote("");
				setOutput("反馈已记录到本机");
				await reloadDashboard();
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
			className: "plugin-market",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: "plugin-market__header",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "插件市场" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "plugin-market__muted",
						children: "安装、发布者、市场源和兼容反馈都在本机插件工坊里管理。"
					})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "plugin-market__button",
						disabled: Boolean(busy),
						onClick: () => void reloadDashboard(),
						children: "刷新"
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
					className: "plugin-market__tabs",
					"aria-label": "插件市场分区",
					children: TABS.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: `plugin-market__tab${tab === item.id ? " is-active" : ""}`,
						"aria-current": tab === item.id ? "page" : void 0,
						onClick: () => setTab(item.id),
						children: item.label
					}, item.id))
				}),
				tab === "discover" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiscoverPanel, {
					sources: dashboard.sources,
					installed: dashboard.installed,
					plugins,
					updates,
					busy,
					sourceId,
					customSource,
					channel,
					query,
					rolloutKey,
					setSourceId,
					setCustomSource,
					setChannel,
					setQuery,
					setRolloutKey,
					search,
					checkUpdates,
					install,
					uninstall
				}) : null,
				tab === "publishers" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PublishersPanel, {
					publishers: dashboard.publishers,
					busy,
					publisherId,
					publisherName,
					publisherKey,
					setPublisherId,
					setPublisherName,
					setPublisherKey,
					addPublisher,
					setPublisher
				}) : null,
				tab === "sources" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourcesPanel, {
					sources: dashboard.sources,
					busy,
					sourceDraftId,
					sourceDraftName,
					sourceDraftCatalog,
					sourceDraftSignature,
					sourceDraftTrustStore,
					sourceDraftMirrors,
					sourceDraftPriority,
					setSourceDraftId,
					setSourceDraftName,
					setSourceDraftCatalog,
					setSourceDraftSignature,
					setSourceDraftTrustStore,
					setSourceDraftMirrors,
					setSourceDraftPriority,
					addSource,
					setSource,
					removeSource
				}) : null,
				tab === "telemetry" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TelemetryPanel, {
					telemetry,
					busy,
					pluginId: feedbackPluginId,
					version: feedbackVersion,
					compatible,
					rating,
					note,
					setPluginId: setFeedbackPluginId,
					setVersion: setFeedbackVersion,
					setCompatible,
					setRating,
					setNote,
					submitFeedback
				}) : null,
				output ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					className: "plugin-market__output",
					children: output
				}) : null
			]
		});
	}
	function DiscoverPanel(props) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-market__panel",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__row",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						className: "plugin-market__input",
						value: props.sourceId,
						onChange: (event) => props.setSourceId(event.target.value),
						"aria-label": "市场源",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "auto",
							children: "自动选择主市场源"
						}), props.sources.map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
							value: source.id,
							disabled: !source.enabled,
							children: [source.name, source.enabled ? "" : "（已停用）"]
						}, source.id))]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						className: "plugin-market__input",
						value: props.channel,
						onChange: (event) => props.setChannel(event.target.value),
						"aria-label": "发布通道",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "stable",
							children: "stable"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "beta",
							children: "beta"
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: "plugin-market__input",
					value: props.customSource,
					onChange: (event) => props.setCustomSource(event.target.value),
					placeholder: "可选：临时 catalog 地址或本地路径（优先于市场源）"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__row",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.query,
							onChange: (event) => props.setQuery(event.target.value),
							placeholder: "搜索插件"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.rolloutKey,
							onChange: (event) => props.setRolloutKey(event.target.value),
							placeholder: "灰度标识（可选，默认当前 profile）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "plugin-market__button",
							disabled: Boolean(props.busy),
							onClick: () => void props.search(),
							children: "搜索"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "plugin-market__button",
							disabled: Boolean(props.busy),
							onClick: () => void props.checkUpdates(),
							children: "检查更新"
						})
					]
				}),
				props.updates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__list",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "可用更新" }), props.updates.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-market__card plugin-market__card--inline",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "plugin-market__title",
								children: item.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "plugin-market__muted",
								children: [
									item.installed,
									" → ",
									item.available,
									" · ",
									item.channel
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "plugin-market__button",
								disabled: Boolean(props.busy),
								onClick: () => void props.install(item.pluginId, item.available),
								children: "更新"
							})
						]
					}, item.pluginId))]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "plugin-market__list",
					children: props.plugins.map((plugin) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
						className: "plugin-market__card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "plugin-market__title",
								children: plugin.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "plugin-market__muted",
								children: [plugin.id, plugin.publisher ? ` · ${plugin.publisher.name}` : ""]
							}),
							plugin.description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: plugin.description }) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "plugin-market__versions",
								children: versionsForChannel(plugin, props.channel).map((version) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									className: "plugin-market__button",
									disabled: Boolean(props.busy),
									onClick: () => void props.install(plugin.id, version.version),
									title: version.changelog ?? "",
									children: [
										version.version,
										" 安装",
										version.rollout !== void 0 && version.rollout < 100 ? ` · 灰度 ${version.rollout}%` : ""
									]
								}, version.version))
							})
						]
					}, plugin.id))
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__list",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "已安装" }),
						props.installed.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "plugin-market__muted",
							children: "还没有安装插件。"
						}) : null,
						props.installed.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-market__card plugin-market__card--inline",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "plugin-market__title",
									children: item.pluginId
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "plugin-market__muted",
									children: [
										item.name,
										" · ",
										item.version
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "plugin-market__button plugin-market__button--danger",
									disabled: Boolean(props.busy),
									onClick: () => void props.uninstall(item.name),
									children: "卸载"
								})
							]
						}, item.name))
					]
				})
			]
		});
	}
	function PublishersPanel(props) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-market__panel",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "plugin-market__muted",
					children: "发布者公钥用于核对目录声明和插件签名。暂停后，该发布者的插件不能再从市场安装。"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__form",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.publisherId,
							onChange: (event) => props.setPublisherId(event.target.value),
							placeholder: "发布者 id，例如 acme"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.publisherName,
							onChange: (event) => props.setPublisherName(event.target.value),
							placeholder: "显示名称"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: "plugin-market__input plugin-market__textarea",
							value: props.publisherKey,
							onChange: (event) => props.setPublisherKey(event.target.value),
							placeholder: "粘贴 Ed25519 公钥 PEM"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "plugin-market__button",
							disabled: Boolean(props.busy) || !props.publisherId.trim() || !props.publisherKey.trim(),
							onClick: () => void props.addPublisher(),
							children: "登记发布者"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "plugin-market__list",
					children: props.publishers.map((publisher) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-market__card plugin-market__card--inline",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "plugin-market__title",
								children: publisher.name
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "plugin-market__muted",
								children: [
									publisher.id,
									" · ",
									publisher.keyId
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
								tone: publisher.status === "active" ? "ok" : "warn",
								children: publisher.status === "active" ? "可用" : "已暂停"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "plugin-market__button",
								disabled: Boolean(props.busy),
								onClick: () => void props.setPublisher(publisher, publisher.status === "active"),
								children: publisher.status === "active" ? "暂停" : "恢复"
							})
						]
					}, publisher.id))
				})
			]
		});
	}
	function SourcesPanel(props) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-market__panel",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "plugin-market__muted",
					children: "优先级越高越先被自动选中。多个来源可以并存，停用后不会参与自动选择。"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__form",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.sourceDraftId,
							onChange: (event) => props.setSourceDraftId(event.target.value),
							placeholder: "来源 id"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.sourceDraftName,
							onChange: (event) => props.setSourceDraftName(event.target.value),
							placeholder: "显示名称"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.sourceDraftCatalog,
							onChange: (event) => props.setSourceDraftCatalog(event.target.value),
							placeholder: "catalog 地址或本地路径"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.sourceDraftPriority,
							onChange: (event) => props.setSourceDraftPriority(event.target.value),
							placeholder: "优先级，默认 100",
							inputMode: "numeric"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.sourceDraftSignature,
							onChange: (event) => props.setSourceDraftSignature(event.target.value),
							placeholder: "目录签名文件（可选）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.sourceDraftTrustStore,
							onChange: (event) => props.setSourceDraftTrustStore(event.target.value),
							placeholder: "信任库文件（有签名时必填）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: "plugin-market__input plugin-market__textarea",
							value: props.sourceDraftMirrors,
							onChange: (event) => props.setSourceDraftMirrors(event.target.value),
							placeholder: "下载镜像，每行一个（可选）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "plugin-market__button",
							disabled: Boolean(props.busy) || !props.sourceDraftId.trim() || !props.sourceDraftCatalog.trim(),
							onClick: () => void props.addSource(),
							children: "添加市场源"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "plugin-market__list",
					children: props.sources.map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-market__card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "plugin-market__card-heading",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "plugin-market__title",
										children: source.name
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										tone: source.enabled ? "ok" : "warn",
										children: source.enabled ? "启用" : "停用"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "plugin-market__muted",
										children: ["优先级 ", source.priority]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								className: "plugin-market__code",
								children: source.catalog
							}),
							source.mirrors?.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "plugin-market__muted",
								children: [
									"镜像 ",
									source.mirrors.length,
									" 个"
								]
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "plugin-market__versions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "plugin-market__button",
										disabled: Boolean(props.busy),
										onClick: () => void props.setSource(source, { enabled: !source.enabled }),
										children: source.enabled ? "停用" : "启用"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "plugin-market__button",
										disabled: Boolean(props.busy),
										onClick: () => void props.setSource(source, { priority: source.priority + 10 }),
										children: "提高优先级"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "plugin-market__button plugin-market__button--danger",
										disabled: Boolean(props.busy),
										onClick: () => void props.removeSource(source),
										children: "删除"
									})
								]
							})
						]
					}, source.id))
				})
			]
		});
	}
	function TelemetryPanel(props) {
		const summary = props.telemetry.summary;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-market__panel",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__metrics",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: "安装",
							value: summary.installs
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: "更新",
							value: summary.updates
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: "卸载",
							value: summary.uninstalls
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: "Worker 崩溃",
							value: summary.workerCrashes
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: "反馈",
							value: summary.feedback
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
							label: "平均评分",
							value: summary.averageRating ?? "—"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "plugin-market__muted",
					children: [
						"兼容结果：可用 ",
						summary.compatibility.ok,
						" · 有问题 ",
						summary.compatibility.broken,
						" · 未判断 ",
						summary.compatibility.unknown,
						"。数据只保存在本机。"
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__form",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.pluginId,
							onChange: (event) => props.setPluginId(event.target.value),
							placeholder: "插件 id"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.version,
							onChange: (event) => props.setVersion(event.target.value),
							placeholder: "版本，可选"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "plugin-market__input",
							value: props.compatible,
							onChange: (event) => props.setCompatible(event.target.value),
							"aria-label": "兼容结果",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "ok",
									children: "可用"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "broken",
									children: "有问题"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "unknown",
									children: "未判断"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: "plugin-market__input",
							value: props.rating,
							onChange: (event) => props.setRating(event.target.value),
							"aria-label": "评分",
							children: [
								5,
								4,
								3,
								2,
								1
							].map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value,
								children: [value, " 分"]
							}, value))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: "plugin-market__input plugin-market__textarea",
							value: props.note,
							onChange: (event) => props.setNote(event.target.value),
							placeholder: "遇到什么问题，或哪里做得不错（可选）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "plugin-market__button",
							disabled: Boolean(props.busy) || !props.pluginId.trim(),
							onClick: () => void props.submitFeedback(),
							children: "记录反馈"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-market__list",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "最近事件" }),
						props.telemetry.events.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "plugin-market__muted",
							children: "还没有记录。"
						}) : null,
						[...props.telemetry.events].reverse().map((event, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-market__event",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
									tone: eventTone(event),
									children: eventLabel(event)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [event.pluginId, event.version ? `@${event.version}` : ""] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "plugin-market__muted",
									children: formatTime(event.at)
								}),
								event.note ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "plugin-market__note",
									children: event.note
								}) : null
							]
						}, `${event.at}-${event.type}-${index}`))
					]
				})
			]
		});
	}
	function Metric({ label, value }) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-market__metric",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: value })]
		});
	}
	function StatusBadge({ children, tone }) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: `plugin-market__badge plugin-market__badge--${tone}`,
			children
		});
	}
	function eventLabel(event) {
		if (event.type === "feedback") {
			if (event.compatible === "ok") return `可用${event.rating ? ` · ${event.rating} 分` : ""}`;
			if (event.compatible === "broken") return "有问题";
			return "兼容未知";
		}
		if (event.type === "worker-crash") return "崩溃";
		if (event.type === "install") return "安装";
		if (event.type === "update") return "更新";
		if (event.type === "uninstall") return "卸载";
		return event.type;
	}
	function eventTone(event) {
		if (event.type === "worker-crash" || event.compatible === "broken") return "bad";
		if (event.compatible === "ok" || event.type === "install" || event.type === "update") return "ok";
		return "warn";
	}
	function formatTime(value) {
		return new Date(value).toLocaleString();
	}
	function versionsForChannel(plugin, channel) {
		return plugin.versions.filter((version) => {
			if (!version.channels || version.channels.length === 0) return channel === "stable";
			return version.channels.includes(channel);
		});
	}
	function errorText(error) {
		return error instanceof Error ? error.message : String(error);
	}
	// src/client-entry.tsx
	var ID = "plugin-studio";
	__MENG_LOADER__.load({
		id: ID,
		factory: () => ({
			inject: ["slots", "transport"],
			apply(ctx) {
				const slots = ctx.get("slots");
				if (!slots) throw new Error("plugin-studio 需要 slots 能力面");
				const transport = ctx.get("transport");
				const BoundPanel = () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarketPanel, { transport });
				const style = document.createElement("style");
				style.setAttribute("data-plugin", ID);
				style.textContent = market_default;
				document.head.appendChild(style);
				const off = slots.register(ID, {
					name: "settings.section",
					component: BoundPanel,
					order: 920,
					meta: {
						label: "插件市场",
						group: "插件",
						origin: "external"
					}
				});
				return () => {
					off();
					style.remove();
				};
			}
		})
	});
})(__MENG_REQUIRE__("react"), __MENG_REQUIRE__("react/jsx-runtime"));
