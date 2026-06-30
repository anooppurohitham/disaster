const DEFAULT_MIN_SAMPLE = 0.025;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function createPlaceholderWaveform(sampleCount: number) {
  return Array.from({ length: sampleCount }, (_, index) => {
    const progress = sampleCount <= 1 ? 0 : index / (sampleCount - 1);
    const slowPulse = 0.18 + Math.sin(progress * Math.PI * 3.5) * 0.08;
    const midTexture = Math.abs(Math.sin(progress * Math.PI * 17)) * 0.28;
    const fastTexture = Math.abs(Math.cos(progress * Math.PI * 43)) * 0.18;
    const contour =
      progress < 0.2
        ? 0.64
        : progress < 0.45
          ? 0.92
          : progress < 0.72
            ? 0.74
            : 0.58;
    return clamp(slowPulse + midTexture + fastTexture, DEFAULT_MIN_SAMPLE, contour);
  });
}

export function getWaveformSampleCount(durationSeconds: number) {
  return clamp(Math.ceil(durationSeconds * 64), 1600, 12000);
}

export function extractWaveformSamples(buffer: AudioBuffer, sampleCount = 400) {
  if (!buffer.numberOfChannels || !buffer.length || sampleCount <= 0) {
    return createPlaceholderWaveform(Math.max(1, sampleCount));
  }

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const bucketSize = Math.max(1, Math.floor(buffer.length / sampleCount));
  const raw = Array.from({ length: sampleCount }, (_, bucket) => {
    const start = bucket * bucketSize;
    const end = Math.min(buffer.length, bucket === sampleCount - 1 ? buffer.length : start + bucketSize);
    const stride = Math.max(1, Math.floor((end - start) / 320));
    let peak = 0;
    let energy = 0;
    let count = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[sampleIndex] ?? 0;
      mixed /= channels.length;
      const amplitude = Math.abs(mixed);
      peak = Math.max(peak, amplitude);
      energy += mixed * mixed;
      count += 1;
    }

    if (!count) return DEFAULT_MIN_SAMPLE;
    const rms = Math.sqrt(energy / count);
    const transient = Math.max(0, peak - rms);
    return rms * 0.68 + peak * 0.24 + transient * 0.2;
  });

  const smoothed = raw.map((sample, index) => {
    const previous = raw[Math.max(0, index - 1)] ?? sample;
    const next = raw[Math.min(raw.length - 1, index + 1)] ?? sample;
    const broadPrevious = raw[Math.max(0, index - 2)] ?? previous;
    const broadNext = raw[Math.min(raw.length - 1, index + 2)] ?? next;
    return broadPrevious * 0.08 + previous * 0.22 + sample * 0.4 + next * 0.22 + broadNext * 0.08;
  });

  const maxValue = smoothed.reduce((highest, sample) => Math.max(highest, sample), DEFAULT_MIN_SAMPLE);
  return smoothed.map((sample) => {
    const normalized = clamp(sample / maxValue, 0, 1);
    return clamp(Math.pow(normalized, 0.82), DEFAULT_MIN_SAMPLE, 1);
  });
}
