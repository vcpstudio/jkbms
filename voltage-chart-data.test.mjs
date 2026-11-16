import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCellVoltageSamples } from "./voltage-chart-data.mjs";

test("aggregates crowded samples by time while preserving per-cell peaks", () => {
  const samples = [
    { timestamp: 0, cellVoltages: [3.2, 3.3] },
    { timestamp: 1000, cellVoltages: [3.5, 3.4] },
    { timestamp: 2000, cellVoltages: [3.4, 3.3] },
    { timestamp: 3000, cellVoltages: [3.3, 3.2] },
  ];

  const buckets = aggregateCellVoltageSamples(samples, 2);

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].minimum, 3.2);
  assert.equal(buckets[0].maximum, 3.5);
  assert.equal(buckets[0].cells[0].minimum, 3.2);
  assert.equal(buckets[0].cells[0].maximum, 3.5);
  assert.equal(buckets[0].cells[0].average, 3.35);
  assert.equal(buckets[1].cells[1].minimum, 3.2);
  assert.equal(buckets[1].cells[1].maximum, 3.3);
});

test("returns one bucket for a single sample and no buckets for empty history", () => {
  assert.deepEqual(aggregateCellVoltageSamples([], 10), []);
  assert.equal(
    aggregateCellVoltageSamples([{ timestamp: 1, cellVoltages: [3.3] }], 10)[0].average,
    3.3,
  );
});

test("keeps sparse samples at their original positions within the selected time window", () => {
  const buckets = aggregateCellVoltageSamples(
    [
      { timestamp: 250000, cellVoltages: [3.2] },
      { timestamp: 300000, cellVoltages: [3.3] },
    ],
    100,
    0,
    300000,
  );

  assert.equal(buckets[0].bucketCount, 100);
  assert.equal(buckets[0].index, 83);
  assert.equal(buckets[1].index, 99);
});
