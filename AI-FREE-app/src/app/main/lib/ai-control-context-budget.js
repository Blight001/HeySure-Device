'use strict';

const { groupValidMessages } = require('./ai-control-message-window');

const DEFAULT_MAX_REQUEST_CHARS = 60000;
const DEFAULT_TOOL_RESULT_CHARS = 12000;
const DEFAULT_TEXT_MESSAGE_CHARS = 16000;
const DEFAULT_SUMMARY_CHARS = 6000;

function serializedLength(messages, tools) {
  try { return JSON.stringify({ messages, tools }).length; } catch (_) { return Number.MAX_SAFE_INTEGER; }
}

function truncateMiddle(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const marker = `\n...[已截短 ${text.length - maxChars} 字符]...\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function compactToolCalls(toolCalls, maxArgumentChars) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((call) => {
    const args = String(call?.function?.arguments || '');
    if (args.length <= maxArgumentChars) return call;
    return {
      ...call,
      function: {
        ...(call.function || {}),
        arguments: JSON.stringify({
          _truncated: true,
          original_chars: args.length,
          preview: truncateMiddle(args, Math.max(200, maxArgumentChars - 80)),
        }),
      },
    };
  });
}

function compactMessage(message, limits) {
  const copy = { ...message };
  delete copy.reasoning;
  delete copy.tool_events;
  delete copy.trace_events;
  if (copy.role === 'tool') {
    copy.content = truncateMiddle(copy.content, limits.toolResultChars);
  } else if (typeof copy.content === 'string') {
    copy.content = truncateMiddle(copy.content, limits.textMessageChars);
  }
  if (copy.role === 'assistant' && Array.isArray(copy.tool_calls)) {
    copy.tool_calls = compactToolCalls(copy.tool_calls, limits.toolArgumentChars);
  }
  return copy;
}

function compactGroup(group, limits) {
  return group.map((message) => compactMessage(message, limits));
}

function summaryLines(groups, maxChars) {
  const lines = [];
  let used = 0;
  for (const group of groups) {
    for (const message of group) {
      if (!['user', 'assistant'].includes(message?.role) || message?.tool_calls?.length) continue;
      const content = String(message.content || '').replace(/\s+/g, ' ').trim();
      if (!content) continue;
      const label = message.role === 'user' ? '用户' : '助手';
      const line = `${label}：${truncateMiddle(content, 360)}`;
      if (used + line.length > maxChars) return lines;
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines;
}

function createHistorySummary(groups, maxChars) {
  if (!groups.length || maxChars < 80) return null;
  const heading = `[较早对话摘要：已压缩 ${groups.length} 个消息组]`;
  const lines = summaryLines(groups, Math.max(0, maxChars - heading.length - 1));
  return { role: 'user', content: [heading, ...lines].join('\n') };
}

function partitionGroups(messages) {
  const system = [];
  const conversation = [];
  for (const group of groupValidMessages(messages)) {
    if (group.length === 1 && group[0]?.role === 'system') system.push(...group);
    else conversation.push(group);
  }
  return { system, conversation };
}

function normalizeLimits(options = {}) {
  return {
    maxRequestChars: Number(options.maxRequestChars) || DEFAULT_MAX_REQUEST_CHARS,
    toolResultChars: Number(options.toolResultChars) || DEFAULT_TOOL_RESULT_CHARS,
    textMessageChars: Number(options.textMessageChars) || DEFAULT_TEXT_MESSAGE_CHARS,
    summaryChars: Number(options.summaryChars) || DEFAULT_SUMMARY_CHARS,
    toolArgumentChars: Number(options.toolArgumentChars) || 8000,
  };
}

function collectRecentGroups(system, conversation, tools, limits) {
  const compacted = conversation.map((group) => compactGroup(group, limits));
  const kept = [];
  let firstKeptIndex = compacted.length;
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const candidate = [...system, ...compacted.slice(index).flat()];
    if (serializedLength(candidate, tools) > limits.maxRequestChars) break;
    firstKeptIndex = index;
    kept.unshift(compacted[index]);
  }
  return { kept, omitted: conversation.slice(0, firstKeptIndex) };
}

function forceLatestGroup(system, conversation, tools, limits) {
  if (!conversation.length) return { kept: [], omitted: [] };
  const tight = {
    ...limits, toolResultChars: 2000, textMessageChars: 4000, toolArgumentChars: 2000,
  };
  return {
    kept: [compactGroup(conversation.at(-1), tight)],
    omitted: conversation.slice(0, -1),
  };
}

function fitAiControlContext(messages = [], tools = [], options = {}) {
  const limits = normalizeLimits(options);
  const { system, conversation } = partitionGroups(messages);
  let selected = collectRecentGroups(system, conversation, tools, limits);
  if (selected.omitted.length) {
    const reserved = Math.min(limits.summaryChars, Math.floor(limits.maxRequestChars * 0.2));
    selected = collectRecentGroups(system, conversation, tools, {
      ...limits,
      maxRequestChars: Math.max(1000, limits.maxRequestChars - reserved),
    });
  }
  if (!selected.kept.length && conversation.length) {
    selected = forceLatestGroup(system, conversation, tools, limits);
  }
  const flattened = selected.kept.flat();
  const withoutSummary = [...system, ...flattened];
  const remaining = limits.maxRequestChars - serializedLength(withoutSummary, tools);
  const summary = createHistorySummary(selected.omitted, Math.min(limits.summaryChars, remaining - 80));
  const fitted = summary ? [...system, summary, ...flattened] : withoutSummary;
  return groupValidMessages(fitted).flat();
}

module.exports = {
  DEFAULT_MAX_REQUEST_CHARS,
  compactMessage,
  createHistorySummary,
  fitAiControlContext,
  serializedLength,
  truncateMiddle,
};
