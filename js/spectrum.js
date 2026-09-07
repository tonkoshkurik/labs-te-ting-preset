import { audioEngine } from './audio-engine.js';

// Live FFT spectrum + filter response curves, drawn on a canvas.
// Frequencies are log-scaled 20Hz-20kHz (the audible range), matching how EQs are read on any DAW.

const MIN_FREQ = 20;
const MAX_FREQ = 20000;

// Response-curve dB scale (separate from the spectrum's own -100..0dB amplitude scale)
const RESPONSE_DB_MIN = -24;
const RESPONSE_DB_MAX = 18;

const MARKER_COLORS = {
  LOWPASS: '#5ec8ff',
  HIGHPASS: '#ff9d5e',
  EQUALIZER: '#fd5722'
};

function freqToX(freq, width) {
  const t = Math.log(freq / MIN_FREQ) / Math.log(MAX_FREQ / MIN_FREQ);
  return Math.max(0, Math.min(width, t * width));
}

function xToFreq(x, width) {
  const t = x / width;
  return MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);
}

function dbToY(db, height) {
  const t = (db - RESPONSE_DB_MIN) / (RESPONSE_DB_MAX - RESPONSE_DB_MIN);
  return height - Math.max(0, Math.min(1, t)) * height;
}

// RBJ Audio EQ Cookbook biquad coefficients - the same formulas the browser's native
// BiquadFilterNode uses, so this matches what Tone.Filter actually does to the signal.
function biquadCoeffs(type, freq0, sampleRate, Q, gainDb) {
  const w0 = 2 * Math.PI * freq0 / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Math.max(Q, 0.0001));

  if (type === 'peaking') {
    const A = Math.pow(10, gainDb / 40);
    return {
      b0: 1 + alpha * A, b1: -2 * cosW0, b2: 1 - alpha * A,
      a0: 1 + alpha / A, a1: -2 * cosW0, a2: 1 - alpha / A
    };
  }
  if (type === 'highpass') {
    return {
      b0: (1 + cosW0) / 2, b1: -(1 + cosW0), b2: (1 + cosW0) / 2,
      a0: 1 + alpha, a1: -2 * cosW0, a2: 1 - alpha
    };
  }
  // lowpass
  return {
    b0: (1 - cosW0) / 2, b1: 1 - cosW0, b2: (1 - cosW0) / 2,
    a0: 1 + alpha, a1: -2 * cosW0, a2: 1 - alpha
  };
}

// Magnitude response in dB at a given frequency for one biquad stage
function biquadResponseDb(type, freq0, sampleRate, Q, gainDb, freq) {
  const { b0, b1, b2, a0, a1, a2 } = biquadCoeffs(type, freq0, sampleRate, Q, gainDb);
  const w = 2 * Math.PI * freq / sampleRate;
  const cos1 = Math.cos(-w), sin1 = Math.sin(-w);
  const cos2 = Math.cos(-2 * w), sin2 = Math.sin(-2 * w);

  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = b1 * sin1 + b2 * sin2;
  const denRe = a0 + a1 * cos1 + a2 * cos2;
  const denIm = a1 * sin1 + a2 * sin2;

  const numMag = Math.sqrt(numRe * numRe + numIm * numIm);
  const denMag = Math.sqrt(denRe * denRe + denIm * denIm);
  return 20 * Math.log10(numMag / denMag);
}

const BIQUAD_TYPE = { LOWPASS: 'lowpass', HIGHPASS: 'highpass', EQUALIZER: 'peaking' };

let rafId = null;

export function startSpectrum() {
  const canvas = document.getElementById('spectrumCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const draw = () => {
    // Any uncaught throw in here previously killed the rAF chain permanently with zero
    // visible indication - the canvas would just silently stop updating. Guard so a bad
    // frame is skipped (logged) instead of ending the whole live view.
    try {
      drawFrame(canvas, ctx);
    } catch (err) {
      console.error('[spectrum] draw error:', err);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ff6b6b';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('spectrum error - see console', 8, 16);
    }
    rafId = requestAnimationFrame(draw);
  };

  if (rafId) cancelAnimationFrame(rafId);
  draw();
}

function drawFrame(canvas, ctx) {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

    // Octave gridlines for reference (100, 1k, 10k)
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px Inter, sans-serif';
    ctx.lineWidth = 1;
    [100, 1000, 10000].forEach(freq => {
      const x = freqToX(freq, width);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, x + 3, height - 4);
    });

    // Spectrum trace (actual audio, real dB scale -100..0)
    const spectrum = audioEngine.getSpectrum();
    const sampleRate = (typeof Tone !== 'undefined' && Tone.getContext) ? Tone.getContext().sampleRate : 44100;
    const isHardware = audioEngine.spectrumSource === 'hardware';
    const traceColor = isHardware ? '34, 197, 94' : '253, 87, 34'; // green for real hardware input, orange for emulation
    if (spectrum && spectrum.length) {
      const nyquist = sampleRate / 2;
      const binCount = spectrum.length;

      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x++) {
        const freq = xToFreq(x, width);
        const bin = Math.min(binCount - 1, Math.round((freq / nyquist) * binCount));
        const db = spectrum[bin]; // ~ -100 (silent) to 0 (full scale)
        const norm = Math.max(0, Math.min(1, (db + 100) / 100));
        ctx.lineTo(x, height - norm * height);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = `rgba(${traceColor}, 0.25)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${traceColor}, 0.8)`;
      ctx.stroke();
    }

    // Filter/EQ response curves - real biquad math, so Q shows up as bump width and
    // gain as bump height, matching what the filter actually does to the signal.
    const markers = audioEngine.getFilterMarkers();
    if (markers.length) {
      // 0dB reference line for the response scale
      const zeroY = dbToY(0, height);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(width, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      markers.forEach(({ type, freq, Q, gainDb }) => {
        const color = MARKER_COLORS[type] || '#ffffff';
        const biquadType = BIQUAD_TYPE[type];

        ctx.beginPath();
        for (let x = 0; x <= width; x++) {
          const f = xToFreq(x, width);
          const db = biquadResponseDb(biquadType, freq, sampleRate, Q, gainDb, f);
          const y = dbToY(db, height);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Label at the filter's own center/corner frequency
        const labelX = freqToX(freq, width);
        const labelDb = biquadResponseDb(biquadType, freq, sampleRate, Q, gainDb, freq);
        const labelY = dbToY(labelDb, height);
        ctx.fillStyle = color;
        const freqLabel = freq >= 1000 ? `${(freq / 1000).toFixed(1)}k` : `${Math.round(freq)}`;
        ctx.fillText(`${type} ${freqLabel}Hz Q${Q.toFixed(1)}`, Math.min(labelX + 3, width - 130), Math.max(10, labelY - 3));
      });
    }
}

export function stopSpectrum() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}
