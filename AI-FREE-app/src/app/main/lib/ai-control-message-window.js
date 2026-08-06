'use strict';

function toolCallIds(message) {
  if (String(message?.role || '') !== 'assistant' || !Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls.map((call) => String(call?.id || '').trim()).filter(Boolean);
}

function groupValidMessages(messages = []) {
  const source = Array.isArray(messages) ? messages.filter((item) => item && typeof item === 'object') : [];
  const groups = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (String(message?.role || '') === 'tool') continue;

    const ids = toolCallIds(message);
    if (!ids.length) {
      groups.push([message]);
      continue;
    }

    const tools = [];
    let cursor = index + 1;
    while (cursor < source.length && String(source[cursor]?.role || '') === 'tool') {
      tools.push(source[cursor]);
      cursor += 1;
    }
    const returnedIds = new Set(tools.map((item) => String(item?.tool_call_id || '').trim()).filter(Boolean));
    if (ids.every((id) => returnedIds.has(id))) {
      groups.push([message, ...tools]);
    } else {
      // OpenAI 兼容接口会拒绝不完整的工具调用链。只清除无法配对的
      // tool_calls，保留助手文本；正常对话内容不做数量或字符裁剪。
      const { tool_calls: _discarded, ...plainAssistant } = message;
      if (String(plainAssistant.content || '').trim()) groups.push([plainAssistant]);
    }
    index = cursor - 1;
  }
  return groups;
}

function limitAiControlMessages(messages = []) {
  return groupValidMessages(messages).flat();
}

module.exports = {
  groupValidMessages,
  limitAiControlMessages,
};
