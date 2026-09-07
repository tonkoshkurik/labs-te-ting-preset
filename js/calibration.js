import { audioEngine } from './audio-engine.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Average several FFT frames (dB) from whichever spectrum source is active, to smooth
// out noise variance before measuring anything from it.
async function captureAveragedSpectrum(frames = 10, intervalMs = 40) {
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

// Sweep one filter/EQ row's `cutoff` across DEFAULT_TEST_VALUES on the real, connected
// hardware, measuring the actual resulting frequency from a captured audio input each time.
// Requires: tingUSB connected, a continuous broadband (white/pink noise) signal already
// reaching the TING's mic, and audioEngine's hardware spectrum source already connected.
export async function runCutoffCalibration({ tingUSB, slot, row, effectType, testValues = DEFAULT_TEST_VALUES, onProgress }) {
  const sampleRate = Tone.getContext().sampleRate;
  const results = [];

  await tingUSB.selectSlot(slot);
  await sleep(200);

  // EQUALIZER needs a strong, unambiguous boost to locate the peak against noise
  if (effectType === 'EQUALIZER') {
    await tingUSB.setParam(slot, row, 'Q', 0.6);
    await sleep(150);
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

    let freq;
    if (effectType === 'LOWPASS') freq = estimateLowpassCutoffHz(spectrum, sampleRate);
    else if (effectType === 'HIGHPASS') freq = estimateHighpassCutoffHz(spectrum, sampleRate);
    else freq = estimatePeakHz(spectrum, sampleRate);

    results.push({ cutoff, freq });
    onProgress?.({ step: i, total: testValues.length, cutoff, freq, phase: 'done' });
  }

  return results;
}
