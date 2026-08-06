'use strict';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serializeArguments(value) {
  if (typeof value === 'string') return value || '{}';
  if (value === undefined || value === null) return '{}';
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function normalizeToolCall(call, index) {
  const source = isObject(call) ? call : {};
  const fn = isObject(source.function) ? source.function : source;
  const name = String(fn.name ?? source.name ?? source.tool ?? '').trim();
  const args = fn.arguments ?? source.arguments ?? source.input ?? fn.input ?? fn.parameters;
  return {
    id: String(source.id || `native-tool-${index + 1}`),
    type: 'function',
    function: { name, arguments: serializeArguments(args) },
  };
}

function nativeCallSources(message) {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) return message.tool_calls;
  if (isObject(message?.function_call)) return [message.function_call];
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter((part) => {
    const type = String(part?.type || '').toLowerCase();
    return ['tool_use', 'tool_call', 'function_call'].includes(type);
  });
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (typeof part === 'string') return part;
    const type = String(part?.type || '').toLowerCase();
    if (['tool_use', 'tool_call', 'function_call'].includes(type)) return '';
    return String(part?.text ?? part?.content ?? '');
  }).join('');
}

function normalizeToolCallMessage(message) {
  const sources = nativeCallSources(message);
  return {
    content: normalizeMessageContent(message?.content),
    toolCalls: sources.map(normalizeToolCall),
  };
}

module.exports = { normalizeMessageContent, normalizeToolCallMessage, normalizeToolCall };

