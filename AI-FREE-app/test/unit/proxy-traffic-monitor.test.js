const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBillableTrafficTracker,
  isBillableProxyConnection,
} = require('../../src/app/main/ipc/register/proxy-traffic-monitor');

function connection(id, chains, upload, download) {
  return { id, chains, upload, download };
}

test('only connections using a proxy chain are billable', () => {
  assert.equal(isBillableProxyConnection(connection('a', ['DIRECT'], 1, 2)), false);
  assert.equal(isBillableProxyConnection(connection('b', ['DIRECT', '🚀节点选择'], 1, 2)), false);
  assert.equal(isBillableProxyConnection(connection('c', ['REJECT'], 1, 2)), false);
  assert.equal(isBillableProxyConnection(connection('d', [], 1, 2)), false);
  assert.equal(isBillableProxyConnection(connection('e', ['新加坡 01', '🚀节点选择'], 1, 2)), true);
});

test('direct traffic is excluded while proxy connection deltas are counted', () => {
  const tracker = createBillableTrafficTracker();

  assert.deepEqual(tracker.sample({
    uploadTotal: 10_000,
    downloadTotal: 20_000,
    connections: [
      connection('direct', ['DIRECT'], 1_000, 2_000),
      connection('proxy', ['美国 01', '🚀节点选择'], 100, 200),
    ],
  }), { upload: 0, download: 0 });

  assert.deepEqual(tracker.sample({
    uploadTotal: 50_000,
    downloadTotal: 90_000,
    connections: [
      connection('direct', ['DIRECT'], 20_000, 40_000),
      connection('proxy', ['美国 01', '🚀节点选择'], 150, 350),
    ],
  }), { upload: 50, download: 150 });
});

test('new proxy connections are counted without re-counting existing ones', () => {
  const tracker = createBillableTrafficTracker();
  tracker.sample({ connections: [connection('old', ['日本 01'], 100, 200)] });

  assert.deepEqual(tracker.sample({
    connections: [
      connection('old', ['日本 01'], 120, 260),
      connection('new', ['新加坡 01'], 30, 70),
    ],
  }), { upload: 50, download: 130 });

  assert.deepEqual(tracker.sample({
    connections: [connection('new', ['新加坡 01'], 40, 90)],
  }), { upload: 10, download: 20 });
});

test('counter rollback is treated as a new counter epoch', () => {
  const tracker = createBillableTrafficTracker();
  tracker.sample({ connections: [connection('proxy', ['美国 01'], 500, 800)] });
  assert.deepEqual(
    tracker.sample({ connections: [connection('proxy', ['美国 01'], 20, 30)] }),
    { upload: 20, download: 30 },
  );
});

test('idle snapshots with null connections are valid and count nothing', () => {
  const tracker = createBillableTrafficTracker();
  // 没有活动代理请求时，Mihomo 的 Go nil slice 会把 connections
  // 序列化成 null；这是合法空闲响应，不能触发“格式无效”并停掉 Clash。
  assert.deepEqual(
    tracker.sample({ uploadTotal: 0, downloadTotal: 0, connections: null }),
    { upload: 0, download: 0 },
  );
  tracker.sample({ connections: [connection('proxy', ['美国 01'], 100, 200)] });
  assert.deepEqual(
    tracker.sample({ uploadTotal: 300, downloadTotal: 500, connections: null }),
    { upload: 0, download: 0 },
  );
  assert.deepEqual(
    tracker.sample({ connections: [connection('proxy', ['美国 01'], 40, 90)] }),
    { upload: 40, download: 90 },
  );
});

test('invalid snapshots fail instead of resetting counters and double counting', () => {
  const tracker = createBillableTrafficTracker();
  tracker.sample({ connections: [connection('proxy', ['美国 01'], 100, 200)] });
  assert.throws(() => tracker.sample({ uploadTotal: 100 }), /响应格式无效/);
  assert.deepEqual(
    tracker.sample({ connections: [connection('proxy', ['美国 01'], 130, 260)] }),
    { upload: 30, download: 60 },
  );
});
