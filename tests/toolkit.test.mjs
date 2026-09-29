import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineTool, parametersToJsonSchema, validateJsonSchemaValue, ToolArgsError, textOutput } from '../lib/toolkit.js'

test('parametersToJsonSchema: 必填/可选/枚举/描述', () => {
  const s = parametersToJsonSchema({
    url: { type: 'string', required: true, description: '平台地址' },
    kind: { type: 'string', enum: ['user', 'team'] },
    limit: { type: 'number' },
  })
  assert.equal(s.type, 'object')
  assert.deepEqual(s.required, ['url'])
  assert.equal(s.properties.url.type, 'string')
  assert.equal(s.properties.url.description, '平台地址')
  assert.deepEqual(s.properties.kind.enum, ['user', 'team'])
  assert.equal(s.properties.limit.type, 'number')
})

test('parametersToJsonSchema: 无必填时不产生 required 字段', () => {
  const s = parametersToJsonSchema({ a: { type: 'string' } })
  assert.equal('required' in s, false)
})

test('validateJsonSchemaValue: 类型与必填违规', () => {
  const s = parametersToJsonSchema({ a: { type: 'string', required: true }, b: { type: 'number' } })
  assert.equal(validateJsonSchemaValue(s, { a: 'x' }, '').length, 0)
  const v1 = validateJsonSchemaValue(s, {}, '')
  assert.equal(v1.length, 1)
  assert.match(v1[0], /必填/)
  const v2 = validateJsonSchemaValue(s, { a: 1 }, '')
  assert.match(v2[0], /期望 string/)
})

test('validateJsonSchemaValue: 嵌套 object / array / oneOf', () => {
  const s = parametersToJsonSchema({
    opts: { type: 'object', properties: { deep: { type: 'boolean', required: true } } },
    ids: { type: 'array', items: { type: 'integer' } },
    either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  })
  assert.equal(validateJsonSchemaValue(s, { opts: { deep: true }, ids: [1, 2], either: 'a' }, '').length, 0)
  assert.equal(validateJsonSchemaValue(s, { opts: {} }, '').length, 1)
  assert.equal(validateJsonSchemaValue(s, { ids: [1, 'x'] }, '').length, 1)
  assert.equal(validateJsonSchemaValue(s, { either: true }, '').length, 1)
})

test('json 类型不做约束', () => {
  const s = parametersToJsonSchema({ any: { type: 'json' } })
  assert.equal(validateJsonSchemaValue(s, { any: { deep: [1, 2] } }, '').length, 0)
})

test('defineTool: 形状与 registry 契约一致', async () => {
  const tool = defineTool({
    name: 'demo', description: 'demo tool',
    parameters: { x: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) { return `got ${args.x}` },
  })
  assert.equal(tool.name, 'demo')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(await tool.execute({ x: 'hi' }, {}), 'got hi')
  await assert.rejects(() => tool.execute({}, {}), ToolArgsError)
})

test('defineTool: 校验失败的错误带 violations', async () => {
  const tool = defineTool({
    name: 'd2', description: 'd',
    parameters: { n: { type: 'number', required: true } },
    output: textOutput(),
    async execute() { return '' },
  })
  try { await tool.execute({}, {}); assert.fail('应当抛错') }
  catch (e) { assert.equal(e.code, 'INVALID_ARGS'); assert.equal(e.violations.length, 1) }
})

test('defineTool: 缺必填字段时构造即失败', () => {
  assert.throws(() => defineTool({ name: 'x', description: 'y', execute() {} }), /output\.schema/)
  assert.throws(() => defineTool({ name: 'x', output: textOutput(), execute() {} }), /description/)
  assert.throws(() => defineTool({ name: 'x', description: 'y', parameters: { a: { type: 'bogus' } }, output: textOutput(), execute() {} }), /不支持/)
})

test('render 返回 ContentBlock 形状', () => {
  const tool = defineTool({ name: 'r', description: 'r', output: textOutput(), execute: async () => 'hi' })
  assert.deepEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
})
