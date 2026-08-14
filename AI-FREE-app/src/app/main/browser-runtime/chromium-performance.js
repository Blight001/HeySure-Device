'use strict';

function elapsedMs(startedAt, now) {
  return Number(now() - startedAt) / 1e6;
}

function createChromiumPerformanceSpan(logger, operation, options = {}) {
  const now = options.now || process.hrtime.bigint;
  const startedAt = now();
  let previousAt = startedAt;
  const phases = [];

  function mark(name) {
    const currentAt = now();
    phases.push(`${String(name)}Ms=${elapsedMs(previousAt, () => currentAt).toFixed(1)}`);
    previousAt = currentAt;
  }

  function write(outcome, error) {
    const suffix = error ? ` error=${String(error.code || 'UNKNOWN').slice(0, 64)}` : '';
    logger?.info?.(
      `[ChromiumPerformance] operation=${String(operation)} outcome=${outcome} `
      + `totalMs=${elapsedMs(startedAt, now).toFixed(1)} ${phases.join(' ')}${suffix}`,
    );
  }

  return {
    mark,
    finish(outcome = 'ok') { write(String(outcome)); },
    fail(error) { write('failed', error); },
  };
}

module.exports = { createChromiumPerformanceSpan };
