'use strict';

const TAG_BLOCK_PATTERN = /<(mcp-call|mcp_call|tool_call|invoke|xai:function_call)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const TAG_START_PATTERN = /<(?:mcp-call|mcp_call|tool_call|invoke|xai:function_call)\b[^>]*>/i;
const PARAMETER_PATTERN = /<(?:[\w-]+:)?(?:parameter|argument|arg)\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?(?:parameter|argument|arg)\s*>/gi;
const FENCE_PATTERN = /```[ \t]*([\w-]*)[ \t]*\r?\n([\s\S]*?)```/g;
const TOOL_FENCE_LANGUAGES = new Set(['tool_call', 'tool-call', 'function_call', 'mcp', 'mcp_call', 'mcp-call']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readAttribute(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(String(attributes || ''));
  return match ? String(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function parseJson(value, detail = '调用内容不是有效的 JSON') {
  try { return JSON.parse(String(value || '').trim()); } catch (_) { throw new Error(detail); }
}

function parseArguments(value) {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'string'
    ? parseJson(value, 'arguments 不是有效的 JSON')
    : value;
  if (!isPlainObject(parsed)) throw new Error('arguments 必须是 JSON 对象');
  return parsed;
}

function payloadParts(payload) {
  if (!isPlainObject(payload)) throw new Error('调用内容必须是 JSON 对象');
  const fn = isPlainObject(payload.function) ? payload.function : payload;
  const name = String(payload.tool ?? payload.tool_name ?? fn.name ?? payload.name ?? '').trim();
  const args = payload.arguments ?? payload.args ?? payload.input
    ?? fn.arguments ?? fn.args ?? fn.input ?? fn.parameters;
  if (!name) throw new Error('缺少工具名（tool/name）');
  return { name, args: parseArguments(args) };
}

function parsePayloadCalls(body) {
  const parsed = parseJson(body);
  const payloads = Array.isArray(parsed) ? parsed : [parsed];
  if (!payloads.length) throw new Error('调用列表不能为空');
  return payloads.map(payloadParts);
}

function parseParameterValue(value) {
  const text = decodeXmlText(value).trim();
  if (!text) return '';
  try { return JSON.parse(text); } catch (_) { return text; }
}

function parseNamedArguments(body) {
  const source = String(body || '').trim();
  const args = {};
  let count = 0;
  PARAMETER_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(PARAMETER_PATTERN)) {
    const name = readAttribute(match[1], 'name');
    if (!name) throw new Error('parameter 缺少 name 属性');
    args[name] = parseParameterValue(match[2]);
    count += 1;
  }
  if (count) return args;
  const wrapped = /^<(?:arguments|parameters)\b[^>]*>([\s\S]*?)<\/(?:arguments|parameters)\s*>$/i.exec(source);
  return source ? parseArguments(wrapped ? wrapped[1] : source) : {};
}

function parseTagBlock(tag, attributes, body) {
  if (tag === 'invoke' || tag === 'xai:function_call') {
    const name = readAttribute(attributes, 'name') || readAttribute(attributes, 'tool');
    if (!name) throw new Error(`${tag} 缺少 name 属性`);
    return [{ name, args: parseNamedArguments(body) }];
  }
  return parsePayloadCalls(body);
}

function parseTrailingTag(source) {
  const match = /^<(mcp-call|mcp_call|tool_call|invoke|xai:function_call)\b([^>]*)>([\s\S]*)$/i.exec(source);
  if (!match) throw new Error('调用标签未闭合或结束标签不匹配');
  return parseTagBlock(String(match[1]).toLowerCase(), match[2], match[3]);
}

function resemblesToolPayload(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every(resemblesToolPayload);
  if (!isPlainObject(value)) return false;
  if (value.tool || value.tool_name || isPlainObject(value.function)) return true;
  return Boolean(value.name && (value.arguments !== undefined || value.args !== undefined || value.input !== undefined));
}

function looksLikeBrokenToolJson(source) {
  return /"(?:tool|tool_name|function)"\s*:|"name"\s*:[\s\S]*"(?:arguments|args|input)"\s*:/i.test(source);
}

function parseFence(language, body) {
  const normalizedLanguage = String(language || '').toLowerCase();
  if (normalizedLanguage && normalizedLanguage !== 'json' && !TOOL_FENCE_LANGUAGES.has(normalizedLanguage)) return null;
  let payload;
  try {
    payload = JSON.parse(String(body || '').trim());
  } catch (_) {
    if (TOOL_FENCE_LANGUAGES.has(normalizedLanguage) || looksLikeBrokenToolJson(body)) {
      throw new Error('Markdown 工具调用代码块不是有效的 JSON');
    }
    return null;
  }
  return resemblesToolPayload(payload) ? parsePayloadCalls(body) : null;
}

function createToolCalls(calls, round) {
  return calls.map((call, index) => ({
    id: `text-mcp-${round + 1}-${index + 1}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
}

function diagnosticContent(remainingContent, detail) {
  const prefix = String(remainingContent || '').trim();
  const diagnostic = `MCP 调用格式错误：${detail}`;
  return prefix ? `${prefix}\n\n${diagnostic}` : diagnostic;
}

function parseTextMcpCalls(content, round = 0) {
  const source = String(content || '');
  const calls = [];
  let detected = false;
  let parseError = '';
  const parseMatch = (parser) => {
    try { calls.push(...parser()); } catch (error) { parseError ||= error?.message || String(error); }
  };
  TAG_BLOCK_PATTERN.lastIndex = 0;
  let remaining = source.replace(TAG_BLOCK_PATTERN, (_match, tag, attributes, body) => {
    detected = true;
    parseMatch(() => parseTagBlock(String(tag).toLowerCase(), attributes, body));
    return '';
  });
  FENCE_PATTERN.lastIndex = 0;
  remaining = remaining.replace(FENCE_PATTERN, (match, language, body) => {
    let parsed = null;
    parseMatch(() => { parsed = parseFence(language, body); return parsed || []; });
    if (!parsed && !parseError) return match;
    detected = true;
    return '';
  });
  const malformedIndex = remaining.search(TAG_START_PATTERN);
  if (malformedIndex >= 0) {
    detected = true;
    const trailing = remaining.slice(malformedIndex);
    remaining = remaining.slice(0, malformedIndex);
    parseMatch(() => parseTrailingTag(trailing));
  }
  if (!detected) return { detected: false, content: source, toolCalls: [], error: '' };
  if (parseError) return {
    detected: true, content: diagnosticContent(remaining, parseError), toolCalls: [], error: parseError,
  };
  return { detected: true, content: remaining.trim(), toolCalls: createToolCalls(calls, round), error: '' };
}

module.exports = { parseTextMcpCalls };
