export function aggregateCellVoltageSamples(samples, maxBuckets, startTimestamp, endTimestamp) {
  if (!Array.isArray(samples)) {
    throw new TypeError("Вимірювання напруги мають бути масивом.");
  }
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
    throw new RangeError("Кількість часових інтервалів має бути додатним цілим числом.");
  }
  if (samples.length === 0) return [];

  const firstTimestamp = startTimestamp ?? samples[0].timestamp;
  const lastTimestamp = endTimestamp ?? samples.at(-1).timestamp;
  const timeRange = Math.max(lastTimestamp - firstTimestamp, 1);
  const bucketCount = Math.min(maxBuckets, Math.max(1, Math.ceil(timeRange / 1000)));
  const buckets = Array.from({ length: bucketCount }, () => ({
    timestampSum: 0,
    sampleCount: 0,
    minimum: Infinity,
    maximum: -Infinity,
    voltageSum: 0,
    voltageCount: 0,
    cells: [],
  }));

  for (const sample of samples) {
    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.max(
        0,
        Math.floor(((sample.timestamp - firstTimestamp) / timeRange) * bucketCount),
      ),
    );
    const bucket = buckets[bucketIndex];
    bucket.timestampSum += sample.timestamp;
    bucket.sampleCount += 1;

    sample.cellVoltages.forEach((voltage, cellIndex) => {
      if (!Number.isFinite(voltage) || voltage <= 0) return;

      const cell = (bucket.cells[cellIndex] ??= {
        minimum: Infinity,
        maximum: -Infinity,
        voltageSum: 0,
        voltageCount: 0,
      });
      cell.minimum = Math.min(cell.minimum, voltage);
      cell.maximum = Math.max(cell.maximum, voltage);
      cell.voltageSum += voltage;
      cell.voltageCount += 1;
      bucket.minimum = Math.min(bucket.minimum, voltage);
      bucket.maximum = Math.max(bucket.maximum, voltage);
      bucket.voltageSum += voltage;
      bucket.voltageCount += 1;
    });
  }

  return buckets.flatMap((bucket, index) =>
    bucket.sampleCount === 0
      ? []
      : [
          {
            index,
            bucketCount,
            timestamp: bucket.timestampSum / bucket.sampleCount,
            minimum: bucket.voltageCount > 0 ? bucket.minimum : undefined,
            maximum: bucket.voltageCount > 0 ? bucket.maximum : undefined,
            average: bucket.voltageCount > 0 ? bucket.voltageSum / bucket.voltageCount : undefined,
            cells: bucket.cells.map((cell) =>
              cell
                ? {
                    minimum: cell.minimum,
                    maximum: cell.maximum,
                    average: cell.voltageSum / cell.voltageCount,
                  }
                : undefined,
            ),
          },
        ],
  );
}
