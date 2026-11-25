(function(react, react_jsx_runtime) {
	// src/market.css?inline
	var market_default = ".plugin-market {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-4);\n  max-width: 980px;\n  color: var(--meng-alias-fg-secondary);\n  font-size: var(--meng-specific-text-sm);\n}\n.plugin-market h3,\n.plugin-market h4,\n.plugin-market p { margin: 0; }\n.plugin-market h4 { color: var(--meng-alias-fg-primary); font-size: var(--meng-specific-text-sm); }\n.plugin-market__header,\n.plugin-market__card-heading {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--meng-specific-space-3);\n}\n.plugin-market__header > div { display: grid; gap: var(--meng-specific-space-1); }\n.plugin-market__tabs {\n  display: flex;\n  flex-wrap: wrap;\n  gap: var(--meng-specific-space-1);\n  padding: var(--meng-specific-space-1);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-inset);\n}\n.plugin-market__tab {\n  flex: 1 1 120px;\n  padding: var(--meng-specific-space-2) var(--meng-specific-space-3);\n  border: 0;\n  border-radius: var(--meng-specific-radius-sm);\n  background: transparent;\n  color: var(--meng-alias-fg-secondary);\n  font: inherit;\n  cursor: pointer;\n}\n.plugin-market__tab:hover { background: var(--meng-alias-bg-hover); }\n.plugin-market__tab.is-active {\n  background: var(--meng-alias-bg-raised);\n  color: var(--meng-alias-fg-primary);\n  box-shadow: var(--meng-alias-shadow-sm);\n}\n.plugin-market__panel { display: grid; gap: var(--meng-specific-space-4); }\n.plugin-market__row,\n.plugin-market__form {\n  display: flex;\n  gap: var(--meng-specific-space-2);\n  flex-wrap: wrap;\n}\n.plugin-market__form { align-items: flex-start; }\n.plugin-market__input {\n  flex: 1 1 260px;\n  min-width: 0;\n  padding: var(--meng-specific-space-2);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-primary);\n  font: inherit;\n}\n.plugin-market__textarea { flex-basis: 100%; min-height: 72px; resize: vertical; }\n.plugin-market__button {\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l2);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-primary);\n  font: inherit;\n  cursor: pointer;\n}\n.plugin-market__button:hover:not(:disabled) { background: var(--meng-alias-bg-hover); }\n.plugin-market__button:disabled { opacity: .5; cursor: not-allowed; }\n.plugin-market__button--danger { color: var(--meng-alias-danger); }\n.plugin-market__list { display: grid; gap: var(--meng-specific-space-3); }\n.plugin-market__card {\n  display: grid;\n  gap: var(--meng-specific-space-2);\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n}\n.plugin-market__card--inline {\n  grid-template-columns: minmax(150px, 1fr) minmax(190px, 1.5fr) auto auto;\n  align-items: center;\n}\n.plugin-market__title { color: var(--meng-alias-fg-primary); font-weight: var(--meng-specific-weight-strong); }\n.plugin-market__muted { color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.plugin-market__versions { display: flex; flex-wrap: wrap; gap: var(--meng-specific-space-2); }\n.plugin-market__code {\n  overflow-wrap: anywhere;\n  color: var(--meng-alias-fg-muted);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-xs);\n}\n.plugin-market__output {\n  max-height: 220px;\n  overflow: auto;\n  padding: var(--meng-specific-space-3);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-xs);\n  white-space: pre-wrap;\n}\n.plugin-market__metrics {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));\n  gap: var(--meng-specific-space-2);\n}\n.plugin-market__metric {\n  display: grid;\n  gap: var(--meng-specific-space-1);\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n}\n.plugin-market__metric span { color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.plugin-market__metric strong { color: var(--meng-alias-fg-primary); font-size: var(--meng-specific-text-lg); }\n.plugin-market__badge {\n  display: inline-flex;\n  align-items: center;\n  width: fit-content;\n  padding: 2px 8px;\n  border-radius: 999px;\n  font-size: var(--meng-specific-text-xs);\n  white-space: nowrap;\n}\n.plugin-market__badge--ok { background: var(--meng-alias-positive-subtle); color: var(--meng-alias-positive); }\n.plugin-market__badge--warn { background: var(--meng-alias-warning-subtle); color: var(--meng-alias-warning); }\n.plugin-market__badge--bad { background: var(--meng-alias-danger-subtle); color: var(--meng-alias-danger); }\n.plugin-market__event {\n  display: grid;\n  grid-template-columns: auto minmax(160px, 1fr) auto;\n  align-items: center;\n  gap: var(--meng-specific-space-2);\n  padding: var(--meng-specific-space-2) 0;\n  border-bottom: 1px solid var(--meng-alias-border-l1);\n}\n.plugin-market__note { grid-column: 2 / -1; color: var(--meng-alias-fg-secondary); }\n@media (max-width: 720px) {\n  .plugin-market__card--inline { grid-template-columns: 1fr auto; }\n  .plugin-market__card--inline .plugin-market__muted { grid-column: 1 / -1; }\n  .plugin-market__event { grid-template-columns: auto 1fr; }\n  .plugin-market__event > :last-child { grid-column: 2; }\n}\n\n/* 插件中心：一套数据，三种布局。 */\n.plugin-center {\n  display: grid;\n  gap: var(--meng-specific-space-3);\n  min-width: 0;\n}\n.plugin-center__toolbar,\n.plugin-center__search,\n.plugin-center__layout,\n.plugin-center__plugin-main,\n.plugin-center__plugin-foot,\n.plugin-center__plugin-title,\n.plugin-center__update,\n.plugin-center__empty,\n.plugin-center__restart,\n.plugin-center__modal-actions {\n  display: flex;\n  align-items: center;\n}\n.plugin-center__toolbar {\n  justify-content: space-between;\n  gap: var(--meng-specific-space-3);\n  flex-wrap: wrap;\n}\n.plugin-center__search {\n  flex: 1 1 340px;\n  gap: var(--meng-specific-space-2);\n}\n.plugin-center__search .plugin-market__input { flex: 1 1 auto; }\n.plugin-center__layout {\n  gap: 2px;\n  padding: 3px;\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n}\n.plugin-center__layout button,\n.plugin-center__chip,\n.plugin-center__secondary,\n.plugin-center__primary,\n.plugin-center__text-button,\n.plugin-center__restart-action {\n  border: 0;\n  font: inherit;\n  cursor: pointer;\n}\n.plugin-center__layout button {\n  padding: 5px 9px;\n  border-radius: calc(var(--meng-specific-radius-sm) - 2px);\n  background: transparent;\n  color: var(--meng-alias-fg-muted);\n  font-size: var(--meng-specific-text-xs);\n}\n.plugin-center__layout button[data-active] {\n  background: var(--meng-alias-bg-raised);\n  color: var(--meng-alias-fg-primary);\n  box-shadow: var(--meng-alias-shadow-sm);\n}\n.plugin-center__market-tools {\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-inset);\n}\n.plugin-center__market-tools > summary {\n  padding: var(--meng-specific-space-2) var(--meng-specific-space-3);\n  color: var(--meng-alias-fg-muted);\n  cursor: pointer;\n  font-size: var(--meng-specific-text-xs);\n}\n.plugin-center__market-tools > :not(summary) { margin: 0 var(--meng-specific-space-2) var(--meng-specific-space-2); }\n.plugin-center__restart {\n  justify-content: space-between;\n  gap: var(--meng-specific-space-3);\n  padding: var(--meng-specific-space-2) var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-warning-subtle);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-warning-subtle);\n  color: var(--meng-alias-warning);\n}\n.plugin-center__restart-action {\n  padding: 0;\n  background: transparent;\n  color: inherit;\n  font-weight: var(--meng-specific-weight-strong);\n}\n.plugin-center__filters { display: grid; gap: var(--meng-specific-space-2); }\n.plugin-center__filter-group { display: flex; align-items: center; gap: var(--meng-specific-space-2); min-width: 0; }\n.plugin-center__filter-label { flex: 0 0 auto; color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.plugin-center__chips { display: flex; gap: var(--meng-specific-space-1); flex-wrap: wrap; min-width: 0; }\n.plugin-center__chip {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  padding: 5px 8px;\n  border-radius: 999px;\n  background: transparent;\n  color: var(--meng-alias-fg-muted);\n  font-size: var(--meng-specific-text-xs);\n}\n.plugin-center__chip span {\n  min-width: 18px;\n  padding: 1px 5px;\n  border-radius: 999px;\n  background: var(--meng-alias-bg-inset);\n  text-align: center;\n}\n.plugin-center__chip[data-active] { background: var(--meng-alias-bg-raised); color: var(--meng-alias-fg-primary); }\n.plugin-center__chip[data-active] span { background: var(--meng-alias-positive-subtle); color: var(--meng-alias-positive); }\n.plugin-center__list { display: grid; gap: var(--meng-specific-space-2); min-width: 0; }\n.plugin-center__plugin {\n  position: relative;\n  display: grid;\n  gap: var(--meng-specific-space-2);\n  min-width: 0;\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-raised);\n  overflow: hidden;\n}\n.plugin-center__plugin::before {\n  content: \"\";\n  position: absolute;\n  inset: 0 auto 0 0;\n  width: 3px;\n  background: var(--meng-alias-border-l2);\n}\n.plugin-center__plugin[data-source=\"builtin\"]::before { background: var(--meng-alias-fg-muted); }\n.plugin-center__plugin[data-source=\"external\"]::before { background: var(--meng-alias-positive); }\n.plugin-center__plugin[data-source=\"market\"]::before { background: var(--meng-alias-warning); }\n.plugin-center__plugin[data-state=\"restart\"]::before { background: var(--meng-alias-warning); }\n.plugin-center__plugin[data-state=\"failed\"]::before { background: var(--meng-alias-danger); }\n.plugin-center__plugin-main { gap: var(--meng-specific-space-3); min-width: 0; }\n.plugin-center__plugin-icon {\n  display: grid;\n  place-items: center;\n  flex: 0 0 34px;\n  width: 34px;\n  height: 34px;\n  border-radius: 9px;\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-secondary);\n  font-weight: var(--meng-specific-weight-strong);\n}\n.plugin-center__plugin-copy { display: grid; gap: 3px; min-width: 0; flex: 1; }\n.plugin-center__plugin-title { gap: var(--meng-specific-space-2); min-width: 0; }\n.plugin-center__plugin-title strong { color: var(--meng-alias-fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.plugin-center__plugin-title span {\n  flex: 0 0 auto;\n  padding: 1px 6px;\n  border-radius: 999px;\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-muted);\n  font-size: 10px;\n}\n.plugin-center__plugin-meta { color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); overflow-wrap: anywhere; }\n.plugin-center__plugin-copy p { color: var(--meng-alias-fg-secondary); font-size: var(--meng-specific-text-xs); line-height: 1.5; }\n.plugin-center__plugin-foot { justify-content: space-between; gap: var(--meng-specific-space-2); padding-top: var(--meng-specific-space-2); border-top: 1px solid var(--meng-alias-border-l1); }\n.plugin-center__status { display: inline-flex; align-items: center; gap: 6px; color: var(--meng-alias-fg-muted); font-size: var(--meng-specific-text-xs); }\n.plugin-center__status i { width: 7px; height: 7px; border-radius: 999px; background: currentColor; }\n.plugin-center__status[data-tone=\"active\"] { color: var(--meng-alias-positive); }\n.plugin-center__status[data-tone=\"restart\"] { color: var(--meng-alias-warning); }\n.plugin-center__status[data-tone=\"failed\"] { color: var(--meng-alias-danger); }\n.plugin-center__status[data-tone=\"available\"] { color: var(--meng-alias-warning); }\n.plugin-center__locked { color: var(--meng-alias-fg-muted); font-size: 10px; }\n.plugin-center__text-button { padding: 0; background: transparent; color: var(--meng-alias-danger); font-size: var(--meng-specific-text-xs); }\n.plugin-center__primary,\n.plugin-center__secondary {\n  padding: 6px 11px;\n  border-radius: var(--meng-specific-radius-sm);\n  font-size: var(--meng-specific-text-xs);\n}\n.plugin-center__primary { background: var(--meng-alias-fg-primary); color: var(--meng-alias-bg-raised); }\n.plugin-center__secondary { border: 1px solid var(--meng-alias-border-l1); background: var(--meng-alias-bg-inset); color: var(--meng-alias-fg-primary); }\n.plugin-center__primary:disabled,\n.plugin-center__secondary:disabled,\n.plugin-center__text-button:disabled { opacity: .45; cursor: not-allowed; }\n.plugin-center__switch {\n  position: relative;\n  flex: 0 0 38px;\n  width: 38px;\n  height: 22px;\n  padding: 0;\n  border: 0;\n  border-radius: 999px;\n  background: var(--meng-alias-border-l2);\n  cursor: pointer;\n  transition: background .16s ease;\n}\n.plugin-center__switch span {\n  position: absolute;\n  top: 3px;\n  left: 3px;\n  width: 16px;\n  height: 16px;\n  border-radius: 999px;\n  background: var(--meng-alias-bg-raised);\n  box-shadow: var(--meng-alias-shadow-sm);\n  transition: transform .16s ease;\n}\n.plugin-center__switch[aria-checked=\"true\"] { background: var(--meng-alias-positive); }\n.plugin-center__switch[aria-checked=\"true\"] span { transform: translateX(16px); }\n.plugin-center__switch:disabled { cursor: not-allowed; opacity: .4; }\n.plugin-center__updates { display: grid; gap: var(--meng-specific-space-2); padding: var(--meng-specific-space-3); border-radius: var(--meng-specific-radius-md); background: var(--meng-alias-warning-subtle); }\n.plugin-center__update { justify-content: space-between; gap: var(--meng-specific-space-2); color: var(--meng-alias-warning); }\n.plugin-center__empty { justify-content: space-between; gap: var(--meng-specific-space-2); padding: var(--meng-specific-space-5); border: 1px dashed var(--meng-alias-border-l2); border-radius: var(--meng-specific-radius-md); color: var(--meng-alias-fg-muted); }\n.plugin-center__empty button { border: 0; background: transparent; color: var(--meng-alias-fg-primary); cursor: pointer; }\n\n.plugin-center--cards .plugin-center__list { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n.plugin-center--rows .plugin-center__plugin { grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: var(--meng-specific-space-2) var(--meng-specific-space-3); }\n.plugin-center--rows .plugin-center__plugin-main { gap: var(--meng-specific-space-2); }\n.plugin-center--rows .plugin-center__plugin-icon { width: 28px; height: 28px; flex-basis: 28px; border-radius: 7px; }\n.plugin-center--rows .plugin-center__plugin-copy p { display: none; }\n.plugin-center--rows .plugin-center__plugin-foot { justify-content: flex-end; padding-top: 0; border-top: 0; }\n.plugin-center--split { grid-template-columns: 210px minmax(0, 1fr); align-items: start; }\n.plugin-center--split .plugin-center__toolbar,\n.plugin-center--split .plugin-center__market-tools,\n.plugin-center--split .plugin-center__updates { grid-column: 1 / -1; }\n.plugin-center__rail {\n  display: grid;\n  gap: var(--meng-specific-space-4);\n  padding: var(--meng-specific-space-3);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-inset);\n  position: sticky;\n  top: var(--meng-specific-space-3);\n}\n.plugin-center--split .plugin-center__filter-group { display: grid; gap: var(--meng-specific-space-1); }\n.plugin-center--split .plugin-center__chips { display: grid; }\n.plugin-center--split .plugin-center__chip { justify-content: space-between; border-radius: var(--meng-specific-radius-sm); }\n.plugin-center--split .plugin-center__list { grid-template-columns: 1fr; }\n\n.plugin-center__modal-backdrop {\n  position: fixed;\n  inset: 0;\n  z-index: 80;\n  display: grid;\n  place-items: center;\n  padding: var(--meng-specific-space-4);\n  background: color-mix(in srgb, var(--meng-alias-bg-base) 55%, transparent);\n  backdrop-filter: blur(6px);\n}\n.plugin-center__modal {\n  width: min(400px, 100%);\n  display: grid;\n  gap: var(--meng-specific-space-3);\n  padding: var(--meng-specific-space-5);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: 16px;\n  background: var(--meng-alias-bg-raised);\n  box-shadow: 0 24px 70px rgb(0 0 0 / 22%);\n}\n.plugin-center__modal-mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; background: var(--meng-alias-warning-subtle); color: var(--meng-alias-warning); font-size: 20px; }\n.plugin-center__modal h4 { margin: 0; color: var(--meng-alias-fg-primary); font-size: var(--meng-specific-text-lg); }\n.plugin-center__modal p { margin: 0; color: var(--meng-alias-fg-secondary); line-height: 1.6; }\n.plugin-center__modal-actions { justify-content: flex-end; gap: var(--meng-specific-space-2); }\n.plugin-center__modal-error { color: var(--meng-alias-danger) !important; }\n\n.plugin-center button:focus-visible,\n.plugin-center__modal button:focus-visible { outline: 2px solid var(--meng-alias-focus-ring); outline-offset: 2px; }\n\n@media (max-width: 860px) {\n  .plugin-center--cards .plugin-center__list { grid-template-columns: 1fr; }\n  .plugin-center--split { grid-template-columns: 1fr; }\n  .plugin-center__rail { position: static; }\n}\n@media (max-width: 640px) {\n  .plugin-center__filter-group { align-items: flex-start; }\n  .plugin-center__toolbar { align-items: stretch; }\n  .plugin-center__layout { align-self: flex-end; }\n  .plugin-center--rows .plugin-center__plugin { grid-template-columns: 1fr; align-items: stretch; }\n  .plugin-center--rows .plugin-center__plugin-foot { justify-content: space-between; padding-top: var(--meng-specific-space-2); border-top: 1px solid var(--meng-alias-border-l1); }\n}\n@media (prefers-reduced-motion: reduce) {\n  .plugin-center__switch,\n  .plugin-center__switch span { transition: none; }\n}\n\n/* 分栏版精修：圆润、悬停浮起、边缘高光。 */\n.plugin-center--split {\n  position: relative;\n  padding: 8px;\n  border-radius: 24px;\n  background:\n    radial-gradient(circle at 18% -12%, color-mix(in srgb, var(--meng-alias-positive) 10%, transparent), transparent 34%),\n    radial-gradient(circle at 92% 8%, color-mix(in srgb, var(--meng-alias-focus-ring) 8%, transparent), transparent 30%),\n    linear-gradient(160deg, color-mix(in srgb, var(--meng-alias-bg-raised) 58%, transparent), transparent 62%);\n}\n.plugin-center--split .plugin-center__toolbar,\n.plugin-center--split .plugin-center__market-tools {\n  border-radius: 18px;\n  border-color: color-mix(in srgb, var(--meng-alias-border-l1) 72%, transparent);\n  background: color-mix(in srgb, var(--meng-alias-bg-inset) 82%, transparent);\n  box-shadow: inset 0 1px 0 color-mix(in srgb, white 24%, transparent);\n}\n.plugin-center--split .plugin-center__rail {\n  overflow: hidden;\n  border-radius: 22px;\n  border-color: color-mix(in srgb, var(--meng-alias-border-l1) 62%, transparent);\n  background:\n    radial-gradient(circle at 0 0, color-mix(in srgb, var(--meng-alias-positive) 9%, transparent), transparent 42%),\n    linear-gradient(165deg, color-mix(in srgb, var(--meng-alias-bg-raised) 92%, transparent), color-mix(in srgb, var(--meng-alias-bg-inset) 84%, transparent));\n  box-shadow:\n    inset 0 1px 0 color-mix(in srgb, white 30%, transparent),\n    0 16px 38px color-mix(in srgb, var(--meng-alias-fg-primary) 7%, transparent);\n  backdrop-filter: blur(16px);\n}\n.plugin-center--split .plugin-center__rail::before {\n  content: \"\";\n  position: absolute;\n  inset: -28px 12% auto;\n  height: 52px;\n  border-radius: 999px;\n  background: color-mix(in srgb, var(--meng-alias-positive) 28%, transparent);\n  filter: blur(30px);\n  opacity: .55;\n  pointer-events: none;\n}\n.plugin-center--split .plugin-center__chip {\n  position: relative;\n  border: 1px solid transparent;\n  border-radius: 13px;\n  transition: background .18s ease, border-color .18s ease, box-shadow .18s ease, color .18s ease, transform .18s ease;\n}\n.plugin-center--split .plugin-center__chip:hover {\n  background: color-mix(in srgb, var(--meng-alias-bg-raised) 72%, transparent);\n  color: var(--meng-alias-fg-primary);\n  transform: translateX(2px);\n}\n.plugin-center--split .plugin-center__chip[data-active] {\n  border-color: color-mix(in srgb, var(--meng-alias-positive) 20%, var(--meng-alias-border-l1));\n  background: linear-gradient(120deg, color-mix(in srgb, var(--meng-alias-positive) 10%, var(--meng-alias-bg-raised)), var(--meng-alias-bg-raised));\n  box-shadow:\n    inset 0 1px 0 color-mix(in srgb, white 28%, transparent),\n    0 0 18px color-mix(in srgb, var(--meng-alias-positive) 10%, transparent);\n}\n.plugin-center--split .plugin-center__plugin {\n  overflow: hidden;\n  border-radius: 18px;\n  border-color: color-mix(in srgb, var(--meng-alias-border-l1) 66%, transparent);\n  background:\n    linear-gradient(145deg, color-mix(in srgb, white 5%, transparent), transparent 42%),\n    color-mix(in srgb, var(--meng-alias-bg-raised) 94%, transparent);\n  box-shadow:\n    inset 0 1px 0 color-mix(in srgb, white 22%, transparent),\n    0 4px 14px color-mix(in srgb, var(--meng-alias-fg-primary) 4%, transparent);\n  transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease, background .2s ease;\n}\n.plugin-center--split .plugin-center__plugin::after {\n  content: \"\";\n  position: absolute;\n  inset: 0;\n  padding: 1px;\n  border-radius: inherit;\n  background: linear-gradient(125deg,\n    color-mix(in srgb, var(--meng-alias-positive) 62%, transparent),\n    color-mix(in srgb, var(--meng-alias-focus-ring) 20%, transparent) 34%,\n    transparent 52%,\n    color-mix(in srgb, var(--meng-alias-warning) 24%, transparent));\n  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n  -webkit-mask-composite: xor;\n  mask-composite: exclude;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity .2s ease;\n}\n.plugin-center--split .plugin-center__plugin:hover {\n  transform: translateY(-2px);\n  border-color: color-mix(in srgb, var(--meng-alias-positive) 38%, var(--meng-alias-border-l1));\n  background:\n    linear-gradient(145deg, color-mix(in srgb, white 8%, transparent), transparent 46%),\n    color-mix(in srgb, var(--meng-alias-bg-raised) 98%, transparent);\n  box-shadow:\n    inset 0 1px 0 color-mix(in srgb, white 38%, transparent),\n    0 16px 36px color-mix(in srgb, var(--meng-alias-fg-primary) 10%, transparent),\n    0 0 26px color-mix(in srgb, var(--meng-alias-positive) 12%, transparent);\n}\n.plugin-center--split .plugin-center__plugin:hover::after { opacity: .82; }\n.plugin-center--split .plugin-center__plugin:hover .plugin-center__plugin-icon {\n  background: color-mix(in srgb, var(--meng-alias-positive) 13%, var(--meng-alias-bg-inset));\n  box-shadow: 0 0 18px color-mix(in srgb, var(--meng-alias-positive) 16%, transparent);\n}\n.plugin-center--split .plugin-center__plugin:hover .plugin-center__status i {\n  box-shadow: 0 0 10px currentColor;\n}\n.plugin-center--split .plugin-center__plugin-icon {\n  border-radius: 12px;\n  transition: background .2s ease, box-shadow .2s ease;\n}\n.plugin-center--split .plugin-center__switch[aria-checked=\"true\"] {\n  box-shadow:\n    0 0 0 1px color-mix(in srgb, var(--meng-alias-positive) 28%, transparent),\n    0 0 16px color-mix(in srgb, var(--meng-alias-positive) 24%, transparent);\n}\n.plugin-center--split .plugin-center__primary,\n.plugin-center--split .plugin-center__secondary {\n  border-radius: 11px;\n  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;\n}\n.plugin-center--split .plugin-center__primary:hover:not(:disabled),\n.plugin-center--split .plugin-center__secondary:hover:not(:disabled) {\n  transform: translateY(-1px);\n  box-shadow: 0 8px 18px color-mix(in srgb, var(--meng-alias-fg-primary) 12%, transparent);\n}\n.plugin-center__modal {\n  position: relative;\n  overflow: hidden;\n  border-radius: 22px;\n  border-color: color-mix(in srgb, var(--meng-alias-border-l1) 60%, transparent);\n  background:\n    radial-gradient(circle at 12% 0, color-mix(in srgb, var(--meng-alias-warning) 14%, transparent), transparent 36%),\n    var(--meng-alias-bg-raised);\n}\n.plugin-center__modal::before {\n  content: \"\";\n  position: absolute;\n  inset: 0 0 auto;\n  height: 1px;\n  background: linear-gradient(90deg, transparent, color-mix(in srgb, white 72%, transparent), transparent);\n}\n.plugin-center__modal-mark {\n  border-radius: 14px;\n  box-shadow: 0 0 24px color-mix(in srgb, var(--meng-alias-warning) 18%, transparent);\n}\n@media (prefers-reduced-motion: reduce) {\n  .plugin-center--split .plugin-center__plugin,\n  .plugin-center--split .plugin-center__chip,\n  .plugin-center--split .plugin-center__primary,\n  .plugin-center--split .plugin-center__secondary,\n  .plugin-center--split .plugin-center__plugin::after {\n    transition: none;\n  }\n  .plugin-center--split .plugin-center__plugin:hover,\n  .plugin-center--split .plugin-center__chip:hover,\n  .plugin-center--split .plugin-center__primary:hover:not(:disabled),\n  .plugin-center--split .plugin-center__secondary:hover:not(:disabled) {\n    transform: none;\n  }\n}\n";
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
			label: "插件库"
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
			library: [],
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
		const [restartPrompt, setRestartPrompt] = (0, react.useState)(null);
		const [restarting, setRestarting] = (0, react.useState)(false);
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
			if (!transport) return;
			search();
		}, [transport]);
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
			version && `${pluginId}${version}`;
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
				setRestartPrompt({
					title: "插件已安装",
					message: `${result.name}@${result.version} 需要重启后才会生效。`
				});
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function togglePlugin(plugin, enabled) {
			if (!transport || !plugin.configurable) return;
			setBusy(`toggle:${plugin.packageName}`);
			setOutput("");
			try {
				await transport.invoke("pluginMarket.plugin.set", {
					name: plugin.packageName,
					enabled,
					confirm: true
				});
				setOutput(enabled ? `${plugin.id} 将在重启后启动` : `${plugin.id} 将在重启后关闭`);
				await reloadDashboard();
				setRestartPrompt({
					title: enabled ? "插件已启用" : "插件已关闭",
					message: `${plugin.id} 的状态需要重启后才会生效。`
				});
			} catch (error) {
				setOutput(errorText(error));
			} finally {
				setBusy("");
			}
		}
		async function restartNow() {
			if (!transport) return;
			setRestarting(true);
			try {
				if (!(await transport.invoke("pluginMarket.restart", { confirm: true })).supported) {
					setRestartPrompt((current) => current ? {
						...current,
						unsupported: true
					} : current);
					setRestarting(false);
				}
			} catch (error) {
				setOutput(errorText(error));
				setRestarting(false);
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
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "插件中心" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "plugin-market__muted",
						children: [
							dashboard.library.filter((item) => item.runtime === "active").length,
							" 个运行中 · ",
							dashboard.library.length,
							" 个已安装"
						]
					})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "plugin-market__button",
						disabled: Boolean(busy),
						onClick: () => void reloadDashboard(),
						children: "刷新"
					})]
				}),
				dashboard.library.some((item) => item.restartRequired) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-center__restart",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "有插件变更等待生效" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "plugin-center__restart-action",
						onClick: () => setRestartPrompt({
							title: "需要重启",
							message: "插件状态已变更，重启后生效。"
						}),
						children: "查看"
					})]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
					className: "plugin-market__tabs",
					"aria-label": "插件中心分区",
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
					library: dashboard.library,
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
					uninstall,
					togglePlugin
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
				}) : null,
				restartPrompt ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "plugin-center__modal-backdrop",
					role: "presentation",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-center__modal",
						role: "dialog",
						"aria-modal": "true",
						"aria-labelledby": "plugin-restart-title",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "plugin-center__modal-mark",
								"aria-hidden": "true",
								children: "↻"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								id: "plugin-restart-title",
								children: restartPrompt.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: restartPrompt.message }),
							restartPrompt.unsupported ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "plugin-center__modal-error",
								children: "当前环境不能自动重启，请关闭并重新打开梦。"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "plugin-center__modal-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "plugin-market__button",
									onClick: () => setRestartPrompt(null),
									children: "稍后"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "plugin-center__primary",
									disabled: restarting,
									onClick: () => restartPrompt.unsupported ? setRestartPrompt(null) : void restartNow(),
									children: restarting ? "正在重启…" : restartPrompt.unsupported ? "知道了" : "立即重启"
								})]
							})
						]
					})
				}) : null
			]
		});
	}
	function DiscoverPanel(props) {
		const [layout, setLayout] = (0, react.useState)(() => {
			const saved = localStorage.getItem("meng.pluginCenter.layout");
			return saved === "rows" || saved === "split" || saved === "cards" ? saved : "cards";
		});
		const [category, setCategory] = (0, react.useState)("all");
		const [stateFilter, setStateFilter] = (0, react.useState)("all");
		const deferredQuery = (0, react.useDeferredValue)(props.query.trim().toLowerCase());
		(0, react.useEffect)(() => {
			localStorage.setItem("meng.pluginCenter.layout", layout);
		}, [layout]);
		const library = (0, react.useMemo)(() => props.library.filter((plugin) => {
			if (deferredQuery && !`${plugin.id} ${plugin.packageName} ${plugin.name}`.toLowerCase().includes(deferredQuery)) return false;
			if (category === "builtin" && plugin.source !== "builtin") return false;
			if ((category === "external" || category === "market") && plugin.source !== "external") return false;
			if (stateFilter === "active" && (plugin.runtime !== "active" || !plugin.enabled)) return false;
			if (stateFilter === "restart" && !plugin.restartRequired) return false;
			if (stateFilter === "off" && plugin.enabled) return false;
			return true;
		}), [
			category,
			deferredQuery,
			props.library,
			stateFilter
		]);
		const installedIds = (0, react.useMemo)(() => new Set(props.library.map((plugin) => plugin.id)), [props.library]);
		const marketOnly = (0, react.useMemo)(() => {
			if (category === "builtin") return [];
			if (stateFilter !== "all" && stateFilter !== "off") return [];
			return props.plugins.filter((plugin) => {
				if (installedIds.has(plugin.id)) return false;
				return !deferredQuery || `${plugin.id} ${plugin.name} ${plugin.description ?? ""}`.toLowerCase().includes(deferredQuery);
			});
		}, [
			category,
			deferredQuery,
			installedIds,
			props.plugins,
			stateFilter
		]);
		const counts = (0, react.useMemo)(() => ({
			all: props.library.length,
			builtin: props.library.filter((plugin) => plugin.source === "builtin").length,
			external: props.library.filter((plugin) => plugin.source === "external").length,
			market: props.plugins.filter((plugin) => !installedIds.has(plugin.id)).length,
			active: props.library.filter((plugin) => plugin.runtime === "active" && plugin.enabled).length,
			restart: props.library.filter((plugin) => plugin.restartRequired).length,
			off: props.library.filter((plugin) => !plugin.enabled).length
		}), [
			installedIds,
			props.library,
			props.plugins
		]);
		const filters = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-center__filter-group",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "plugin-center__filter-label",
				children: "来源"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "plugin-center__chips",
				children: [
					[
						"all",
						"全部",
						counts.all
					],
					[
						"builtin",
						"内置",
						counts.builtin
					],
					[
						"external",
						"外部",
						counts.external
					],
					[
						"market",
						"可安装",
						counts.market
					]
				].map(([id, label, count]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "plugin-center__chip",
					"data-active": category === id ? "" : void 0,
					onClick: () => setCategory(id),
					children: [label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: count })]
				}, id))
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "plugin-center__filter-group",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "plugin-center__filter-label",
				children: "状态"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "plugin-center__chips",
				children: [
					[
						"all",
						"全部",
						counts.all
					],
					[
						"active",
						"已启用",
						counts.active
					],
					[
						"restart",
						"需重启",
						counts.restart
					],
					[
						"off",
						"已关闭",
						counts.off
					]
				].map(([id, label, count]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "plugin-center__chip",
					"data-active": stateFilter === id ? "" : void 0,
					onClick: () => setStateFilter(id),
					children: [label, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: count })]
				}, id))
			})]
		})] });
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: `plugin-center plugin-center--${layout}`,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-center__toolbar",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-center__search",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.query,
							onChange: (event) => props.setQuery(event.target.value),
							placeholder: "搜索插件"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "plugin-center__secondary",
							disabled: Boolean(props.busy),
							onClick: () => void props.search(),
							children: props.busy === "search" ? "搜索中…" : "搜索市场"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "plugin-center__layout",
						role: "group",
						"aria-label": "插件库布局",
						children: [
							["cards", "卡片"],
							["rows", "列表"],
							["split", "分栏"]
						].map(([id, label]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							"data-active": layout === id ? "" : void 0,
							onClick: () => setLayout(id),
							children: label
						}, id))
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
					className: "plugin-center__market-tools",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: "市场筛选" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-market__row",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
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
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
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
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "plugin-center__secondary",
									disabled: Boolean(props.busy),
									onClick: () => void props.checkUpdates(),
									children: props.busy === "updates" ? "检查中…" : "检查更新"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.customSource,
							onChange: (event) => props.setCustomSource(event.target.value),
							placeholder: "临时 catalog 地址或本地路径"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "plugin-market__input",
							value: props.rolloutKey,
							onChange: (event) => props.setRolloutKey(event.target.value),
							placeholder: "灰度标识"
						})
					]
				}),
				props.updates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-center__updates",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "可用更新" }), props.updates.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-center__update",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.name }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								item.installed,
								" → ",
								item.available
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "plugin-center__primary",
								disabled: Boolean(props.busy),
								onClick: () => void props.install(item.pluginId, item.available),
								children: "更新"
							})
						]
					}, item.pluginId))]
				}) : null,
				layout === "split" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("aside", {
					className: "plugin-center__rail",
					children: filters
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-center__content",
					children: [
						layout !== "split" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "plugin-center__filters",
							children: filters
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-center__list",
							children: [library.map((plugin) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PluginCard, {
								plugin,
								busy: props.busy,
								large: layout === "cards",
								toggle: (enabled) => void props.togglePlugin(plugin, enabled),
								uninstall: () => void props.uninstall(plugin.packageName)
							}, plugin.packageName)), marketOnly.map((plugin) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarketCard, {
								plugin,
								channel: props.channel,
								busy: props.busy,
								install: (version) => void props.install(plugin.id, version)
							}, plugin.id))]
						}),
						library.length === 0 && marketOnly.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-center__empty",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "没有匹配的插件" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => {
									props.setQuery("");
									setCategory("all");
									setStateFilter("all");
								},
								children: "清除筛选"
							})]
						}) : null
					]
				})
			]
		});
	}
	function PluginCard(props) {
		const { plugin } = props;
		const status = pluginStatus(plugin);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
			className: "plugin-center__plugin",
			"data-source": plugin.source,
			"data-state": status.tone,
			"data-large": props.large ? "" : void 0,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "plugin-center__plugin-main",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "plugin-center__plugin-icon",
						"aria-hidden": "true",
						children: plugin.source === "builtin" ? "内" : "外"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "plugin-center__plugin-copy",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-center__plugin-title",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: plugin.id }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: plugin.source === "builtin" ? "系统内置" : "外部插件" })]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "plugin-center__plugin-meta",
							children: [plugin.packageName, plugin.version ? ` · ${plugin.version}` : ""]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PluginSwitch, {
						checked: plugin.enabled,
						disabled: !plugin.configurable || Boolean(props.busy),
						label: `${plugin.id} ${plugin.enabled ? "已启用" : "已关闭"}`,
						title: plugin.configurable ? plugin.enabled ? "关闭插件" : "启用插件" : "系统内置插件随应用启动",
						onChange: props.toggle
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "plugin-center__plugin-foot",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "plugin-center__status",
					"data-tone": status.tone,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}), status.label]
				}), plugin.source === "external" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "plugin-center__text-button",
					disabled: Boolean(props.busy),
					onClick: props.uninstall,
					children: "卸载"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "plugin-center__locked",
					children: "固定启用"
				})]
			})]
		});
	}
	function MarketCard(props) {
		const versions = versionsForChannel(props.plugin, props.channel);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
			className: "plugin-center__plugin",
			"data-source": "market",
			"data-state": "available",
			"data-large": "",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "plugin-center__plugin-main",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "plugin-center__plugin-icon",
					"aria-hidden": "true",
					children: "＋"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "plugin-center__plugin-copy",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "plugin-center__plugin-title",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: props.plugin.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "市场插件" })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "plugin-center__plugin-meta",
							children: [props.plugin.id, props.plugin.publisher ? ` · ${props.plugin.publisher.name}` : ""]
						}),
						props.plugin.description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: props.plugin.description }) : null
					]
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "plugin-center__plugin-foot",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "plugin-center__status",
					"data-tone": "available",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}), "可安装"]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: "plugin-center__primary",
					disabled: Boolean(props.busy),
					onClick: () => props.install(versions[0]?.version),
					children: props.busy === `install:${props.plugin.id}` ? "安装中…" : `安装${versions[0] ? ` ${versions[0].version}` : ""}`
				})]
			})]
		});
	}
	function PluginSwitch(props) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			role: "switch",
			"aria-checked": props.checked,
			"aria-label": props.label,
			title: props.title,
			className: "plugin-center__switch",
			disabled: props.disabled,
			onClick: () => props.onChange(!props.checked),
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})
		});
	}
	function pluginStatus(plugin) {
		if (plugin.runtime === "failed") return {
			label: "启动失败",
			tone: "failed"
		};
		if (plugin.restartRequired) return {
			label: plugin.enabled ? "未激活（需重启）" : "已关闭（需重启）",
			tone: "restart"
		};
		if (plugin.enabled && plugin.runtime === "active") return {
			label: "已启用",
			tone: "active"
		};
		return {
			label: plugin.enabled ? "等待启动" : "已关闭",
			tone: "off"
		};
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
						label: "插件中心",
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
