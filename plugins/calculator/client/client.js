(function(react, _meng_ui, react_jsx_runtime) {
	// src/calculator.css?inline
	var calculator_default = "/*\n  侧栏计算器。\n\n  尺寸参照侧栏本身 (264px 宽) —— 面板不能把下面的会话列表挤没,\n  所以收起时只占一行, 展开时整块内容限高。\n\n  颜色只用 alias token: 计算器是常驻界面, 主题切换时它得跟着换,\n  写死 hex 就会在深色模式下变成一块白板。\n*/\n\n.calc-wrap {\n  margin-top: var(--meng-specific-space-2);\n  padding-top: var(--meng-specific-space-2);\n  border-top: 1px solid var(--meng-alias-border-l1);\n}\n\n.calc-head {\n  display: flex;\n  align-items: center;\n  gap: var(--meng-specific-space-2);\n  width: 100%;\n  min-height: 30px;\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-2);\n  border: 0;\n  border-radius: var(--meng-specific-radius-md);\n  background: transparent;\n  color: var(--meng-alias-fg-secondary);\n  font: inherit;\n  font-size: var(--meng-specific-text-sm);\n  text-align: left;\n  cursor: pointer;\n}\n\n.calc-head:hover {\n  background: var(--meng-alias-bg-hover);\n  color: var(--meng-alias-fg-primary);\n}\n\n.calc-head:focus-visible {\n  outline: 2px solid var(--meng-alias-focus-ring);\n  outline-offset: -2px;\n}\n\n.calc-icon {\n  display: grid;\n  place-items: center;\n  flex: none;\n  width: 20px;\n  height: 20px;\n  border-radius: var(--meng-specific-radius-sm);\n  background: var(--meng-alias-bg-inset);\n  color: var(--meng-alias-fg-muted);\n}\n\n.calc-icon svg {\n  width: 12px;\n  height: 12px;\n  fill: none;\n  stroke: currentColor;\n  stroke-width: 1.4;\n  stroke-linecap: round;\n  stroke-linejoin: round;\n}\n\n/* 收起状态下, 标题右边直接给出结果 —— 不用展开就知道算出来多少 */\n.calc-peek {\n  margin-left: auto;\n  overflow: hidden;\n  max-width: 96px;\n  color: var(--meng-alias-fg-muted);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-xs);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.calc-chevron {\n  color: var(--meng-alias-fg-muted);\n  transition: transform var(--meng-specific-dur-fast) var(--meng-specific-ease);\n}\n\n.calc-chevron[data-open] {\n  transform: rotate(180deg);\n}\n\n.calc-body {\n  padding: var(--meng-specific-space-1) var(--meng-specific-space-2) var(--meng-specific-space-2);\n}\n\n/* ── 屏幕区 ──\n   两行: 上面是算式, 下面是结果。\n   结果**右对齐** —— 数字是右对齐才好比大小, 左对齐看着像在讲故事。 */\n\n.calc-screen {\n  display: flex;\n  flex-direction: column;\n  gap: var(--meng-specific-space-1);\n  padding: var(--meng-specific-space-2);\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-inset);\n}\n\n.calc-expression {\n  width: 100%;\n  min-height: 18px;\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: var(--meng-alias-fg-secondary);\n  font: inherit;\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-sm);\n  outline: none;\n}\n\n.calc-expression::placeholder {\n  color: var(--meng-alias-fg-disabled);\n}\n\n.calc-result {\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: var(--meng-specific-space-1);\n  min-height: 26px;\n  border-top: 1px solid var(--meng-alias-border-l1);\n  padding-top: var(--meng-specific-space-1);\n}\n\n.calc-result-value {\n  overflow: hidden;\n  color: var(--meng-alias-fg-primary);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-lg);\n  font-weight: var(--meng-specific-weight-strong);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.calc-result-empty {\n  color: var(--meng-alias-fg-disabled);\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-lg);\n}\n\n.calc-error {\n  color: var(--meng-alias-danger);\n  font-size: var(--meng-specific-text-xs);\n}\n\n.calc-copy {\n  flex: none;\n}\n\n/* ── 按键盘 ──\n   4 列网格。侧栏只有 264px, 每格约 56px —— 手指点得到。 */\n\n.calc-pad {\n  display: grid;\n  grid-template-columns: repeat(4, 1fr);\n  gap: var(--meng-specific-space-1);\n  margin-top: var(--meng-specific-space-2);\n}\n\n.calc-key {\n  display: grid;\n  place-items: center;\n  min-height: 30px;\n  padding: 0;\n  border: 1px solid var(--meng-alias-border-l1);\n  border-radius: var(--meng-specific-radius-md);\n  background: var(--meng-alias-bg-surface);\n  color: var(--meng-alias-fg-primary);\n  font: inherit;\n  font-family: var(--meng-specific-font-mono);\n  font-size: var(--meng-specific-text-sm);\n  cursor: pointer;\n}\n\n.calc-key:hover {\n  background: var(--meng-alias-bg-hover);\n}\n\n.calc-key:active {\n  background: var(--meng-alias-bg-active);\n}\n\n.calc-key:focus-visible {\n  outline: 2px solid var(--meng-alias-focus-ring);\n  outline-offset: -2px;\n}\n\n/* 运算符和等号不该跟数字长得一样 —— 否则一屏按键看不出哪排是运算 */\n.calc-key[data-variant='plain']:last-child {\n  color: var(--meng-alias-accent);\n}\n\n.calc-key[data-variant='muted'] {\n  color: var(--meng-alias-fg-muted);\n}\n\n.calc-key[data-variant='primary'] {\n  border-color: transparent;\n  background: var(--meng-alias-accent);\n  color: var(--meng-alias-fg-on-accent);\n}\n\n.calc-key[data-variant='primary']:hover {\n  background: var(--meng-alias-accent-hover);\n}\n";
	// src/calculator.ts
	/**
	* 侧栏「计算器」的算术内核。
	*
	* 为什么单独一个文件: 项目里的规矩是「能测的部分别塞进组件」
	* (见 theme-nav.ts + theme-nav.test.ts)。组件只负责画, 算术规则在这里,
	* 于是「2+2*3 到底等于几」能被一条断言钉住, 不必开浏览器。
	*
	* ── 为什么不用 eval / new Function ──
	* 表达式求值最省事的写法是 `new Function('return ' + expr)()`, 但那等于把
	* 用户输入当代码执行 —— 侧栏常驻, 算出来的结果还会被贴回输入框, 一旦有人
	* 贴进 `fetch('http://evil/')` 之类的表达式, 就是在给自己开一个任意代码执行的口子。
	* 代价只是一台小状态机, 换来的是「这个输入只会被当成算式看」。
	*
	* ── 支持的语法 ──
	*   数字: 12 / 3.5 / .5
	*   运算符: + - * / %   (括号改变优先级)
	*   一元: -3 / +(3) / 负号连用
	*   隐式乘法: 2(3+4) / 3pi —— 不支持, 写了会报错而不是猜
	*   幂: ** —— 不支持, 避免和「乘两次」混淆, 也省掉大数暴算的坑
	*
	* 刻意**不支持**的: 变量、函数调用、科学计数法、百分号后缀、位运算。
	* 这是个计算器, 不是表达式引擎; 每加一个语法糖都得配一条测试。
	*/
	/**
	* 求值失败时抛这个。
	*
	* `kind` 是这里最要紧的一行: 界面要分清两种失败 ——
	*   - `incomplete` **还没写完**: 「12+」「(1」「2++」。这是输入的中途状态, 不该报警。
	*   - `invalid`   **真的写错了**: 「1/0」「1)」「abc」。这才该给红字。
	*
	* 判据交给解析器, 而不是拿字符串猜 —— 「2++」看起来像错的, 但它是合法算式
	* 「2++3」的前缀, 猜错了会让用户每写一个符号就闪一次红。
	*/
	var CalcError = class extends Error {
		kind;
		constructor(message, kind = "invalid") {
			super(message);
			this.name = "CalcError";
			this.kind = kind;
		}
	};
	/**
	* 词法: 字符串 → token 流。
	*
	* 遇到不认识的东西直接抛 —— 这里**不做**「忽略非法字符」, 因为
	* `1 2 + 3` 被忽略成 `12 + 3` 的话, 用户算出来的数是错的却看不出来。
	*/
	function tokenize(input) {
		const tokens = [];
		let i = 0;
		while (i < input.length) {
			const ch = input[i];
			if (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
				i++;
				continue;
			}
			if (isDigit(ch) || ch === "." && isDigit(input[i + 1] ?? "")) {
				const start = i;
				let seenDot = false;
				while (i < input.length) {
					const c = input[i];
					if (isDigit(c)) i++;
					else if (c === "." && !seenDot) {
						seenDot = true;
						i++;
					} else break;
				}
				tokens.push({
					type: "num",
					value: input.slice(start, i)
				});
				continue;
			}
			if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
				tokens.push({
					type: "op",
					value: ch
				});
				i++;
				continue;
			}
			if (ch === "(") {
				tokens.push({
					type: "lparen",
					value: ch
				});
				i++;
				continue;
			}
			if (ch === ")") {
				tokens.push({
					type: "rparen",
					value: ch
				});
				i++;
				continue;
			}
			throw new CalcError(`不认识的符号「${ch}」`);
		}
		tokens.push({
			type: "end",
			value: ""
		});
		return tokens;
	}
	function isDigit(ch) {
		return ch >= "0" && ch <= "9";
	}
	/**
	* 语法 + 求值一起做 —— 递归下降。
	*
	* 优先级 (从低到高): + -  →  * / %  →  一元负号  →  括号 / 数字
	*
	* 为什么用递归下降而不是「先转成后缀再求值」: 表达式只有一层优先级时,
	* 递归下降的代码量和栈深都可控, 而且报错位置能直接指向出错的 token。
	*/
	function evaluate(input) {
		const trimmed = input.trim();
		if (trimmed === "") throw new CalcError("算式是空的");
		const tokens = tokenize(trimmed);
		let pos = 0;
		/**
		* token 流末尾永远补了一个 'end', 所以正常路径下不会越界。
		* 但解析器递归里 next() 可能被调过头 —— 这里兜一层, 越界就当 end 处理,
		* 免得整屏崩在 "Cannot read properties of undefined"。
		*/
		const END_TOKEN = {
			type: "end",
			value: ""
		};
		const peek = () => tokens[pos] ?? END_TOKEN;
		const next = () => tokens[pos++] ?? END_TOKEN;
		/** 表达式 := 项 (('+' | '-') 项)* */
		function parseExpression() {
			let left = parseTerm();
			for (;;) {
				const t = peek();
				if (t.type === "op" && (t.value === "+" || t.value === "-")) {
					next();
					const right = parseTerm();
					left = t.value === "+" ? left + right : left - right;
				} else return left;
			}
		}
		/** 项 := 因子 (('*' | '/' | '%') 因子)* */
		function parseTerm() {
			let left = parseFactor();
			for (;;) {
				const t = peek();
				if (t.type === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
					next();
					const right = parseFactor();
					if (t.value === "*") left *= right;
					else if (t.value === "/") {
						if (right === 0) throw new CalcError("除数不能为 0");
						left /= right;
					} else {
						if (right === 0) throw new CalcError("取模的除数不能为 0");
						left %= right;
					}
				} else return left;
			}
		}
		/** 因子 := ('+' | '-') 因子 | 括号 | 数字 */
		function parseFactor() {
			const t = peek();
			if (t.type === "op" && (t.value === "+" || t.value === "-")) {
				next();
				const v = parseFactor();
				return t.value === "-" ? -v : v;
			}
			if (t.type === "lparen") {
				next();
				const v = parseExpression();
				const close = next();
				if (close.type === "end") throw new CalcError("括号没关上", "incomplete");
				if (close.type !== "rparen") throw new CalcError("括号没关上");
				return v;
			}
			if (t.type === "num") {
				next();
				const n = Number(t.value);
				if (!Number.isFinite(n)) throw new CalcError("数字太大了");
				return n;
			}
			if (t.type === "end") throw new CalcError("算式还没写完", "incomplete");
			if (t.type === "op") throw new CalcError("算式还没写完", "incomplete");
			throw new CalcError("算式里有不该出现的符号");
		}
		const result = parseExpression();
		const rest = peek();
		if (rest.type !== "end") {
			if (rest.type === "rparen") throw new CalcError("括号多了一个");
			if (rest.type === "num") throw new CalcError("两个数字挨在一起了");
			throw new CalcError("算式还没写完", "incomplete");
		}
		return result;
	}
	/**
	* 结果怎么显示。
	*
	* 为什么把浮点尾巴剪掉: JS 的 0.1 + 0.2 = 0.30000000000000004,
	* 计算器显示这个用户会以为算错了。剪到 12 位小数, 再把整数值后面的
	* 「.0」去掉 —— 4 要写成 4, 不是 4.0。
	*/
	function formatResult(value) {
		if (!Number.isFinite(value)) return "错误";
		if (value === 0) return "0";
		const rounded = Number(value.toPrecision(12));
		if (Number.isInteger(rounded) && Math.abs(rounded) < 1e21) return String(rounded);
		return expandExponential(String(rounded));
	}
	/**
	* 把 JS 的科学计数法展开成普通小数。
	*
	* 为什么: `String(2.5e-8)` 给的是 "2.5e-8"。计算器里出现这个形态,
	* 用户得自己换算才知道是多少 —— 展开成 "0.000000025" 才是给人看的答案。
	*/
	function expandExponential(text) {
		const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
		if (!match) return text;
		const sign = match[1] ?? "";
		const intPart = match[2] ?? "";
		const fracPart = match[3] ?? "";
		const expText = match[4] ?? "0";
		const exponent = Number(expText);
		const digits = intPart + fracPart;
		const pointIndex = intPart.length + exponent;
		if (pointIndex <= 0) return `${sign}0.${"0".repeat(-pointIndex)}${digits}`;
		if (pointIndex >= digits.length) return `${sign}${digits}${"0".repeat(pointIndex - digits.length)}`;
		return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
	}
	/**
	* 输入框该显示什么 —— 每次按键后重算一次。
	*
	* 输入不完整时 (「12+」) 不报错, 只显示空串: 那不是错误, 是还没写完。
	* 只有**语法上真的错了** (比如「1/0」或者「1)」) 才提示。
	*
	* 判断「没写完」靠解析器给的 kind, 不靠字符串猜 —— 见 CalcError 的注释。
	*/
	function previewResult(input) {
		const trimmed = input.trim();
		if (trimmed === "") return {
			ok: true,
			value: ""
		};
		try {
			return {
				ok: true,
				value: formatResult(evaluate(trimmed))
			};
		} catch (err) {
			if (err instanceof CalcError && err.kind === "incomplete") return {
				ok: true,
				value: ""
			};
			return {
				ok: false,
				message: err instanceof Error ? err.message : "算式有问题"
			};
		}
	}
	// src/Calculator.tsx
	/**
	* 侧栏「计算器」。
	*
	* 它是独立前端插件，通过 `sidebar.utility` slot 挂进侧栏；
	* 核心 `SidebarNav` 只留座位，不直接 import 这个组件。
	*
	* ── 交互上的三个决定 ──
	*   1. **边打边算**: 每敲一键就更新结果。用户不用点「计算」才看到答案 ——
	*      那是老式计算器的做法, 而现在的用户期待输入框本身就是答案区。
	*   2. **折叠默认收起**: 侧栏 264px 宽, 一个展开的计算器会把会话列表挤没。
	*      收起时只占一行标题。
	*   3. **结果可复制**: 算出来的数八成是要贴走的, 一键复制比手抄靠谱。
	*/
	var styles = {
		wrap: "calc-wrap",
		head: "calc-head",
		icon: "calc-icon",
		peek: "calc-peek",
		chevron: "calc-chevron",
		body: "calc-body",
		screen: "calc-screen",
		expression: "calc-expression",
		result: "calc-result",
		resultValue: "calc-result-value",
		resultEmpty: "calc-result-empty",
		error: "calc-error",
		copy: "calc-copy",
		pad: "calc-pad",
		key: "calc-key"
	};
	/** 面板里的按钮布局。0 是显示位, = 单独一行。 */
	var KEYS = [
		[
			"C",
			"(",
			")",
			"/"
		],
		[
			"7",
			"8",
			"9",
			"*"
		],
		[
			"4",
			"5",
			"6",
			"-"
		],
		[
			"1",
			"2",
			"3",
			"+"
		],
		[
			"0",
			".",
			"±",
			"="
		]
	];
	function Calculator() {
		const [open, setOpen] = (0, react.useState)(false);
		const [expression, setExpression] = (0, react.useState)("");
		const inputRef = (0, react.useRef)(null);
		const preview = (0, react.useMemo)(() => previewResult(expression), [expression]);
		const append = (0, react.useCallback)((key) => {
			setExpression((current) => {
				switch (key) {
					case "C": return "";
					case "±": {
						const trimmed = current.trim();
						if (trimmed === "") return current;
						if (trimmed.startsWith("-")) return trimmed.slice(1);
						return `-${trimmed}`;
					}
					case "=":
						if (!preview.ok || preview.value === "") return current;
						return preview.value;
					case "(":
					case ")": {
						const last = current.trim().slice(-1);
						if (last === "(" || last === ")") {
							if (key === "(" && /[0-9)]$/.test(last)) return current;
						}
						return current + key;
					}
					default:
						if (key === "." && /[.]$/.test(current.trim())) return current;
						return current + key;
				}
			});
		}, [preview]);
		const onKeyDown = (0, react.useCallback)((event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				append("=");
				return;
			}
			if (/^[0-9+\-*/().]$/.test(event.key) && event.key.length === 1) {
				event.preventDefault();
				append(event.key);
			}
		}, [append]);
		const copyResult = (0, react.useCallback)(() => {
			if (!preview.ok || preview.value === "") return;
			navigator.clipboard?.writeText(preview.value);
		}, [preview]);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: styles.wrap,
			"data-calculator": "",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: styles.head,
				"aria-expanded": open,
				onClick: () => setOpen((current) => !current),
				"data-calculator-toggle": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.icon,
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							viewBox: "0 0 16 16",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
									x: "3",
									y: "2",
									width: "10",
									height: "12",
									rx: "1.6"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 5.5h5" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 8.5h.01M10 8.5h.01M6 11.5h.01M10 11.5h.01" })
							]
						})
					}),
					"计算器",
					!open && preview.ok && preview.value !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.peek,
						"data-calculator-peek": "",
						children: preview.value
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: styles.chevron,
						"data-open": open ? "" : void 0,
						"aria-hidden": "true",
						children: "⌄"
					})
				]
			}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.body,
				"data-calculator-body": "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: styles.screen,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						ref: inputRef,
						className: styles.expression,
						value: expression,
						onChange: (event) => setExpression(event.target.value),
						onKeyDown,
						placeholder: "算式",
						"aria-label": "算式",
						inputMode: "text",
						spellCheck: false,
						autoComplete: "off",
						"data-calculator-input": ""
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: styles.result,
						"data-calculator-result": "",
						children: preview.ok ? preview.value === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: styles.resultEmpty,
							"aria-hidden": "true",
							children: "—"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: styles.resultValue,
							children: preview.value
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_meng_ui.Tooltip, {
							label: "复制结果",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_meng_ui.IconButton, {
								size: "sm",
								"aria-label": "复制结果",
								onClick: copyResult,
								className: styles.copy,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
									viewBox: "0 0 16 16",
									width: "12",
									height: "12",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "1.5",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
										x: "5.5",
										y: "5.5",
										width: "8",
										height: "8",
										rx: "1.5"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 11h1" })]
								})
							})
						})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: styles.error,
							role: "alert",
							children: preview.message
						})
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: styles.pad,
					role: "group",
					"aria-label": "计算器按键",
					children: KEYS.flat().map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: styles.key,
						"data-key": key,
						"data-variant": key === "=" ? "primary" : "C" === key || key === "±" ? "muted" : "plain",
						onClick: () => append(key),
						children: key
					}, key))
				})]
			})]
		});
	}
	// src/client-entry.tsx
	/**
	* calculator 客户端插件入口。
	*
	* 执行这里只注册 factory；CSS、slot 注册和 React 组件都锁在 apply 里。
	* 卸载时 disposer 会移除 slot 占位和本插件注入的 style。
	*/
	var ID = "calculator";
	__MENG_LOADER__.load({
		id: ID,
		factory: () => ({
			inject: ["slots"],
			apply(ctx) {
				const slots = ctx.get("slots");
				if (!slots) throw new Error(`${ID} 需要 slots 能力面`);
				const style = document.createElement("style");
				style.setAttribute("data-plugin", ID);
				style.textContent = calculator_default;
				document.head.appendChild(style);
				const off = slots.register(ID, {
					name: "sidebar.utility",
					component: Calculator,
					order: 50,
					meta: {
						label: "计算器",
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
})(__MENG_REQUIRE__("react"), __MENG_REQUIRE__("@meng/ui"), __MENG_REQUIRE__("react/jsx-runtime"));
