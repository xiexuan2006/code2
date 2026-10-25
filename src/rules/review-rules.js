/**
 * 确定性代码审查规则。
 *
 * 为什么用规则引擎而不是完全依赖 LLM：
 *  - MVP 需要「可运行、可复现」，离线环境也能稳定演示；
 *  - 规则命中天然带行号，便于 FixAgent 定点修复与 UI 高亮；
 *  - LLM 仅用于生成说明文字/初始代码（可选），不影响流程正确性。
 */

export const SEVERITY_WEIGHT = { high: 30, medium: 15, low: 5 }
export const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 }

export const RULES = [
  {
    id: 'OFF_BY_ONE',
    severity: 'high',
    title: '循环边界可能越界',
    test: (line) => /for\s*\([^)]*<=\s*\w+\.length/.test(line),
    message: '使用 <= 与 length 比较，最后一次迭代会访问 undefined 元素，可能抛出 TypeError。',
    suggestion: '改为 < 比较，遍历 0..length-1。',
    fixLine: (line) => line.replace(/<=\s*(\w+)\.length/g, '< $1.length'),
  },
  {
    id: 'LOOSE_EQUAL',
    severity: 'medium',
    title: '使用了宽松相等比较',
    test: (line) => /(^|[^=!<>])==(?!=)/.test(line) || /(^|[^!])!=(?!=)/.test(line),
    message: '== / != 会触发隐式类型转换，容易产生难以排查的相等性判断错误。',
    suggestion: '改用 === / !== 进行严格比较。',
    fixLine: (line) =>
      line.replace(/(^|[^=!<>])==(?!=)/g, '$1===').replace(/(^|[^!])!=(?!=)/g, '$1!=='),
  },
  {
    id: 'VAR_USAGE',
    severity: 'medium',
    title: '使用了 var 声明',
    test: (line) => /\bvar\s+\w+/.test(line),
    message: 'var 存在变量提升与函数级作用域问题，容易造成闭包取值错误。',
    suggestion: '改用 let / const（块级作用域）。',
    fixLine: (line) => line.replace(/\bvar\s+/g, 'let '),
  },
  {
    id: 'CONSOLE_LOG',
    severity: 'low',
    title: '代码中直接输出调试日志',
    test: (line) => /\bconsole\.(log|debug)\s*\(/.test(line),
    message: '生产代码直接 console 输出，建议交给统一日志组件并区分环境。',
    suggestion: '替换为 logger.info / logger.debug，或在构建阶段移除。',
    // 低优先级问题不自动修改，保留给人工决定
    fixLine: null,
  },
  // ↓↓↓ 扩展：安全审查规则。这类问题涉及业务语义，不提供自动修复，用于演示「达到上限转人工」分支
  {
    id: 'EVAL_USAGE',
    severity: 'high',
    tag: 'security',
    title: '使用了 eval 动态执行字符串',
    test: (line) => /(^|[^.\w])eval\s*\(/.test(line),
    message: 'eval 会把字符串当代码执行，外部输入可直接造成远程代码执行（RCE）。',
    suggestion: '改用显式解析（如 JSON.parse）或受控的白名单表达式求值。',
    fixLine: null,
  },
  {
    id: 'HARDCODED_SECRET',
    severity: 'high',
    tag: 'security',
    title: '疑似硬编码凭据',
    test: (line) =>
      /(api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"]{6,}['"]/i.test(line),
    message: '凭据写死在源码中会随代码库泄露，且无法按环境轮换。',
    suggestion: '改为从环境变量或密钥管理服务读取。',
    fixLine: null,
  },
  {
    id: 'INNER_HTML',
    severity: 'medium',
    tag: 'security',
    title: '直接赋值 innerHTML',
    test: (line) => /\.innerHTML\s*=/.test(line),
    message: '拼接后的 innerHTML 会执行注入的脚本，存在 XSS 风险。',
    suggestion: '改用 textContent，或对接入内容做转义/使用可信模板。',
    fixLine: null,
  },
]

const RULE_MAP = new Map(RULES.map((rule) => [rule.id, rule]))

/** 扫描代码，返回带行号的问题列表 */
export function analyze(code, mode = 'all') {
  const lines = String(code ?? '').split(/\r?\n/)
  const issues = []

  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.test(line)) continue
      issues.push({
        id: `${rule.id}@L${index + 1}`,
        ruleId: rule.id,
        severity: rule.severity,
        line: index + 1,
        snippet: line.trim(),
        title: rule.title,
        message: rule.message,
        suggestion: rule.suggestion,
        fixable: Boolean(rule.fixLine),
        tag: rule.tag ?? 'quality',
      })
    }
  })

  if (mode === 'logic') return issues.filter((i) => i.severity !== 'low')
  if (mode === 'style') return issues.filter((i) => i.severity === 'low')
  return issues
}

/** 评分：满分 100，按严重级别扣分 */
export function scoreOf(issues) {
  const deduction = issues.reduce((sum, issue) => sum + (SEVERITY_WEIGHT[issue.severity] ?? 0), 0)
  return Math.max(0, 100 - deduction)
}

/** 是否通过：存在 high / medium 问题即视为不通过（low 为风格建议） */
export function passedOf(issues) {
  return !issues.some((issue) => issue.severity === 'high' || issue.severity === 'medium')
}

/** 扩展：基础代码度量，补齐「审查报告」里除问题清单之外的信息 */
export function metricsOf(code) {
  const lines = String(code ?? '').split(/\r?\n/)
  const codeLines = lines.filter((line) => line.trim() && !/^\s*(\/\/|\/\*|\*)/.test(line))
  const commentLines = lines.filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line))
  return {
    totalLines: lines.length,
    codeLines: codeLines.length,
    commentLines: commentLines.length,
    blankLines: lines.filter((line) => !line.trim()).length,
    maxLineLength: lines.reduce((max, line) => Math.max(max, line.length), 0),
    functions: (String(code ?? '').match(/\bfunction\b|=>\s*\{/g) ?? []).length,
    branches: (String(code ?? '').match(/\b(if|else\s+if|switch|case)\b/g) ?? []).length,
  }
}

/** 只在指定严重级别中挑一个层级修复（让循环演示更真实：先修致命问题，再修次要问题） */
export function pickFixTarget(issues) {
  if (issues.some((issue) => issue.severity === 'high')) return 'high'
  if (issues.some((issue) => issue.severity === 'medium')) return 'medium'
  return null
}

/** 按行应用自动修复，返回新代码与修复明细 */
export function applyFixes(code, issues, severity) {
  const lines = String(code ?? '').split(/\r?\n/)
  const fixed = []

  for (const issue of issues.filter((item) => item.severity === severity)) {
    const rule = RULE_MAP.get(issue.ruleId)
    if (!rule?.fixLine) continue
    const index = issue.line - 1
    if (index < 0 || index >= lines.length) continue
    const before = lines[index]
    const after = rule.fixLine(before)
    if (after === before) continue
    lines[index] = after
    fixed.push({
      ruleId: rule.id,
      line: issue.line,
      title: rule.title,
      before: before.trim(),
      after: after.trim(),
    })
  }

  return { code: lines.join('\n'), fixed }
}
