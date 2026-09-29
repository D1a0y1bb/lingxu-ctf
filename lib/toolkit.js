/**
 * 零依赖的 `defineTool` 兼容实现。
 *
 * 为什么不直接 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
 *  profile 安装的第三方插件不在 DSH 自身的模块解析路径上，静态导入
 *  `@deepseek-ai/dsh-*` 有解析失败与版本错配双重风险。而宿主 `ctx.tools.register()`
 *  只要求一个普通对象（name / description / parameters(JSON Schema) / output / execute），
 *  参数校验是「工具定义自己」的职责（见 dsh-tools `defineTool` 实现）。
 *  因此这里本地实现同样的 DSL → JSON Schema 转换与校验，行为对齐、零依赖。
 *
 * 支持的参数 DSL（与 dsh-tools 文档一致）：
 *  { type: 'string'|'number'|'integer'|'boolean'|'null', required?, description?, enum?, default? }
 *  { type: 'array', items: <spec>, required?, description? }
 *  { type: 'object', properties: {..}, required?, description? }
 *  { type: 'json', required?, description? }        // 任意 JSON
 *  { oneOf: [<spec>, ...], required?, description? } // 恰好其一
 */

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** 把单个 value spec 编译成 JSON Schema 节点。 */
function compileValueSpec(spec, path) {
  if (!spec || typeof spec !== 'object') {
    throw new Error(`defineTool: ${path} 的 schema 必须是对象`)
  }

  const out = {}
  if (spec.description) out.description = String(spec.description)

  if (Array.isArray(spec.oneOf)) {
    if (spec.oneOf.length === 0) throw new Error(`defineTool: ${path}.oneOf 不能为空`)
    const variants = spec.oneOf.map((v, i) => compileValueSpec(v, `${path}.oneOf[${i}]`))
    // JSON Schema 的 oneOf：恰好匹配其一
    return { ...out, oneOf: variants }
  }

  const type = spec.type
  if (type === 'json') {
    // 任意 JSON：不加 type 约束（DSH 的 'json' 即无约束节点）
    return out
  }
  if (!SCALAR_TYPES.has(type) && type !== 'array' && type !== 'object') {
    throw new Error(`defineTool: ${path}.type 不支持 "${String(type)}"`)
  }

  out.type = type
  if (Array.isArray(spec.enum)) out.enum = spec.enum.map((v) => v)

  if (type === 'array') {
    out.items = spec.items ? compileValueSpec(spec.items, `${path}.items`) : {}
  } else if (type === 'object') {
    const props = spec.properties && typeof spec.properties === 'object' ? spec.properties : {}
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(props)) {
      properties[key] = compileValueSpec(value, `${path}.${key}`)
      if (value && value.required === true) required.push(key)
    }
    out.properties = properties
    if (required.length) out.required = required
  }

  return out
}

/** 参数 DSL（属性映射）→ 顶层 object JSON Schema。 */
export function parametersToJsonSchema(parameters = {}) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    properties[key] = compileValueSpec(spec, `parameters.${key}`)
    if (spec && spec.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

/** 输出 DSL → JSON Schema。 */
export function valueToJsonSchema(spec) {
  return compileValueSpec(spec ?? { type: 'json' }, 'output.schema')
}

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/**
 * 校验值是否符合 JSON Schema 子集。返回违规描述数组（空 = 通过）。
 * 只覆盖本插件用到的子集：type / enum / required / properties / items / oneOf。
 */
export function validateJsonSchemaValue(schema, value, path = 'value') {
  const violations = []
  if (!schema || typeof schema !== 'object') return violations

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((variant) => validateJsonSchemaValue(variant, value, path).length === 0)
    if (matched.length !== 1) {
      violations.push(`${path} 必须恰好匹配 oneOf 中的一个分支（当前匹配 ${matched.length} 个）`)
    }
    return violations
  }

  if (schema.type && !matchesType(value, schema.type)) {
    violations.push(`${path} 期望 ${schema.type}，实际 ${typeName(value)}`)
    return violations
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} 必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')} 之一`)
  }

  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) violations.push(`${path}.${key} 为必填`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) violations.push(...validateJsonSchemaValue(sub, value[key], `${path}.${key}`))
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      violations.push(...validateJsonSchemaValue(schema.items, item, `${path}[${i}]`))
    })
  }

  return violations
}

/** 无效参数错误。宿主会把 execute 抛出的错误转成工具失败结果。 */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.code = 'INVALID_ARGS'
    this.violations = violations
  }
}

/**
 * 构造一个 registry-ready 的工具定义。
 *
 * @param {{
 *  name: string,
 *  description: string,
 *  parameters?: Record<string, unknown>,
 *  output: { schema: unknown, render: (args: any, value: any) => Array<{type:'text',text:string}> },
 *  timeoutMs?: number,
 *  execute: (args: any, exec: any) => Promise<unknown>,
 * }} options
 */
export function defineTool(options) {
  if (!options?.name) throw new Error('defineTool: name 必填')
  if (!options?.description) throw new Error(`defineTool(${options.name}): description 必填`)
  if (!options?.output?.schema) throw new Error(`defineTool(${options.name}): output.schema 必填`)
  if (typeof options.execute !== 'function') throw new Error(`defineTool(${options.name}): execute 必填`)
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs 必须是正有限数`)
  }

  const parameters = parametersToJsonSchema(options.parameters)
  const outputSchema = valueToJsonSchema(options.output.schema)
  const userExecute = options.execute
  const userRender = options.output.render
  const validate = (args) => validateJsonSchemaValue(parameters, args, '')

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args, exec)
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  return tool
}

/** 便捷构造纯文本输出声明。 */
export function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  }
}

export default { defineTool, parametersToJsonSchema, valueToJsonSchema, validateJsonSchemaValue, ToolArgsError, textOutput }
