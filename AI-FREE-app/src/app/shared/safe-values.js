'use strict';

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstPresent(...values) {
  return values.find(isPresent);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function firstNonNull(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function firstNonNullOr(fallback, ...values) {
  const value = firstNonNull(...values);
  return value === undefined ? fallback : value;
}

function firstText(...values) {
  const value = firstPresent(...values);
  return String(isPresent(value) ? value : '');
}

function callOptional(target, methodName, ...args) {
  const method = target && target[methodName];
  if (typeof method !== 'function') return undefined;
  return method.apply(target, args);
}

module.exports = { callOptional, firstDefined, firstNonNull, firstNonNullOr, firstPresent, firstText, isPresent };
