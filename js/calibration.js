import { audioEngine } from './audio-engine.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Average several FFT frames (dB) from whichever spectrum source is active, to smooth
// out noise variance before measuring anything from it.
export async function captureAveragedSpectrum(frames = 10, intervalMs = 40) {
  let sum = null;
  let n = 0;
  for (let i = 0; i < frames; i++) {
    const spec = audioEngine.getSpectrum();
    if (spec && spec.length) {
      if (!sum) sum = new Float32Array(spec.length).fill(0);
      for (let j = 0; j < spec.length; j++) sum[j] += spec[j];
      n++;
    }
    await sleep(intervalMs);
  }
  if (!sum || n === 0) return null;
  for (let j = 0; j < sum.length; j++) sum[j] /= n;
  return sum;
}

function dbAt(freq, spectrum, sampleRate) {
  const nyquist = sampleRate / 2;
  const bin = Math.min(spectrum.length - 1, Math.max(0, Math.round((freq / nyquist) * spectrum.length)));
  return spectrum[bin];
}

function avgDb(loHz, hiHz, spectrum, sampleRate) {
  const nyquist = sampleRate / 2;
  const loBin = Math.max(0, Math.round((loHz / nyquist) * spectrum.length));
  const hiBin = Math.min(spectrum.length - 1, Math.round((hiHz / nyquist) * spectrum.length));
  let sum = 0, n = 0;
  for (let b = loBin; b <= hiBin; b++) { sum += spectrum[b]; n++; }
  return n ? sum / n : -100;
}

// Scan upward from a safely-passband frequency for the first sustained -3dB drop.
function estimateLowpassCutoffHz(spectrum, sampleRate) {
  const passband = avgDb(80, 250, spectrum, sampleRate);
  const threshold = passband - 3;
  const nyquist = sampleRate / 2;
  for (let hz = 100; hz < nyquist * 0.95; hz *= 1.03) {
    if (dbAt(hz, spectrum, sampleRate) < threshold && dbAt(hz * 1.2, spectrum, sampleRate) < threshold) {
      return hz;
    }
  }
  return null;
}

// Scan downward from a safely-passband frequency for the first sustained -3dB drop.
function estimateHighpassCutoffHz(spectrum, sampleRate) {
  const nyquist = sampleRate / 2;
  const passband = avgDb(nyquist * 0.3, nyquist * 0.45, spectrum, sampleRate);
  const threshold = passband - 3;
  for (let hz = nyquist * 0.9; hz > 30; hz /= 1.03) {
    if (dbAt(hz, spectrum, sampleRate) < threshold && dbAt(hz / 1.2, spectrum, sampleRate) < threshold) {
      return hz * 1.03;
    }
  }
  return null;
}

// Find the peak (boosted band) frequency - used for EQUALIZER, calibrated with a forced
// strong boost so the peak is unambiguous against broadband noise.
function estimatePeakHz(spectrum, sampleRate, loHz = 60, hiHz = 12000) {
  let bestHz = null, bestDb = -Infinity;
  for (let hz = loHz; hz <= hiHz; hz *= 1.01) {
    const db = dbAt(hz, spectrum, sampleRate);
    if (db > bestDb) { bestDb = db; bestHz = hz; }
  }
  return bestHz;
}

// Even coverage across the 0-1 range, denser near the ends where curves usually bend most.
export const DEFAULT_TEST_VALUES = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.98];

// Estimate the measured frequency from one captured spectrum, for manual/offline analysis
// (e.g. a spectrum captured by hand while physically switching device presets, rather than
// through the live-serial automated sweep).
//
// A sharp/high-Q filter turns its cutoff/center into a clear resonant peak for all three
// types (LOWPASS and HIGHPASS resonate right at cutoff, same as EQUALIZER's boosted band) -
// peak-finding locates that precisely. The manual capture test presets (calibration-*.json)
// are deliberately built with high Q for exactly this reason. Falls back to a -3dB threshold
// scan only if no meaningful peak stands out (e.g. a low-Q filter was used instead).
export function estimateFreqForType(effectType, spectrum, sampleRate) {
  const peak = estimatePeakHz(spectrum, sampleRate);
  const peakDb = peak ? dbAt(peak, spectrum, sampleRate) : -Infinity;
  const floorDb = avgDb(60, 12000, spectrum, sampleRate);
  const hasSharpPeak = peak && (peakDb - floorDb) > 4; // meaningfully above the average level
  if (hasSharpPeak) return peak;

  if (effectType === 'LOWPASS') return estimateLowpassCutoffHz(spectrum, sampleRate);
  if (effectType === 'HIGHPASS') return estimateHighpassCutoffHz(spectrum, sampleRate);
  return peak;
}

// Sweep one filter/EQ row's `cutoff` across DEFAULT_TEST_VALUES on the real, connected
// hardware, measuring the actual resulting frequency from a captured audio input each time.
// Requires: tingUSB connected, a continuous broadband (white/pink noise) signal already
// reaching the TING's mic, and audioEngine's hardware spectrum source already connected.
export async function runCutoffCalibration({ tingUSB, slot, row, effectType, testValues = DEFAULT_TEST_VALUES, onProgress }) {
  const sampleRate = Tone.getContext().sampleRate;
  const results = [];

  await tingUSB.selectSlot(slot);
  await sleep(200);

  // A sharp/high-Q filter turns cutoff into a clear resonant peak (LOWPASS/HIGHPASS) or an
  // unambiguous boosted band (EQUALIZER) - much easier to locate precisely than a gentle
  // -3dB knee. Force that regardless of whatever Q the scratch preset started with.
  await tingUSB.setParam(slot, row, 'Q', effectType === 'EQUALIZER' ? 0.6 : 0.85);
  await sleep(150);
  if (effectType === 'EQUALIZER') {
    await tingUSB.setParam(slot, row, 'gain', 1.0);
    await sleep(150);
  }

  for (let i = 0; i < testValues.length; i++) {
    const cutoff = testValues[i];
    onProgress?.({ step: i, total: testValues.length, cutoff, phase: 'setting' });
    await tingUSB.setParam(slot, row, 'cutoff', cutoff);
    await sleep(700); // let the filter settle before measuring

    onProgress?.({ step: i, total: testValues.length, cutoff, phase: 'measuring' });
    const spectrum = await captureAveragedSpectrum(10, 40);
    if (!spectrum) {
      results.push({ cutoff, freq: null });
      continue;
    }

    const freq = estimateFreqForType(effectType, spectrum, sampleRate);

    results.push({ cutoff, freq });
    onProgress?.({ step: i, total: testValues.length, cutoff, freq, phase: 'done' });
  }

  return results;
}

// Build a minimal single-effect test preset: [effectType, SAMPLE]. Isolates the filter
// under test from reverb tails, delay repeats, pitch shifting etc. that would otherwise
// pollute the measured spectrum. SAMPLE is a required marker and runs parallel to the
// mic path, so it doesn't affect the measurement.
function buildScratchPreset(effectType) {
  const row = { effect: effectType, cutoff: 0.5, Q: 0.5 };
  if (effectType === 'EQUALIZER') row.gain = 0;
  return { name: `CAL ${effectType}`, list: [row, { effect: 'SAMPLE', speed: 1.0, level: 0.8 }] };
}

// Return a deep-cloned config with `preset` installed at `pos`, replacing whatever was
// there (handle/shake/lfo/trigger deliberately omitted so nothing modulates mid-sweep).
function withSlotPreset(config, pos, preset) {
  const next = JSON.parse(JSON.stringify(config || { presets: [] }));
  next.presets = (next.presets || []).filter(p => p.pos !== pos);
  next.presets.push({ ...preset, pos });
  return next;
}

// Fully automated calibration: reads the device's current config.json, temporarily
// replaces one slot with a minimal test preset per effect type, sweeps and measures each,
// then restores the original config exactly as it was - regardless of what was on that
// slot beforehand. No manual preset prep required.
//
// `slot` is used purely as scratch space for the duration of the run; it is always
// restored in a `finally` block, including if a step throws or the sweep is interrupted.
export async function runAllCalibrations({
  tingUSB,
  slot,
  effectTypes = ['LOWPASS', 'HIGHPASS', 'EQUALIZER'],
  testValues = DEFAULT_TEST_VALUES,
  onProgress
}) {
  onProgress?.({ phase: 'backup' });
  const originalConfig = await tingUSB.readConfigJson();
  const resultsByType = {};

  try {
    for (const effectType of effectTypes) {
      onProgress?.({ phase: 'uploading', effectType });
      const testConfig = withSlotPreset(originalConfig, slot, buildScratchPreset(effectType));
      await tingUSB.writeConfigJson(testConfig, (current, total, status) =>
        onProgress?.({ phase: 'uploading', effectType, current, total, status }));

      resultsByType[effectType] = await runCutoffCalibration({
        tingUSB, slot, row: 0, effectType, testValues,
        onProgress: p => onProgress?.({ ...p, effectType })
      });
    }
  } finally {
    onProgress?.({ phase: 'restoring' });
    await tingUSB.writeConfigJson(originalConfig, (current, total, status) =>
      onProgress?.({ phase: 'restoring', current, total, status }));
    await tingUSB.selectSlot(slot);
  }

  return resultsByType;
}
