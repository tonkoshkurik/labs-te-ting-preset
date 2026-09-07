// Effects that can only be added once per preset
export const SINGLE_INSTANCE_EFFECTS = ['SSB', 'REVERB', 'HARMONY', 'DELAY'];

// Effect definitions with parameter ranges and defaults
export const EFFECTS = {
  BALANCE: {
    params: { balance: { min: 0, max: 1, default: 0.5 } }
  },
  LOWPASS: {
    params: {
      cutoff: { min: 0, max: 1, default: 0.5 },
      Q: { min: 0, max: 1, default: 0.5 }
    }
  },
  HIGHPASS: {
    params: {
      cutoff: { min: 0, max: 1, default: 0.5 },
      Q: { min: 0, max: 1, default: 0.5 }
    }
  },
  EQUALIZER: {
    params: {
      cutoff: { min: 0, max: 1, default: 0.5 },
      Q: { min: 0, max: 1, default: 0.5 },
      gain: { min: -1, max: 1, default: 0 }
    }
  },
  DIST: {
    params: {
      amount: { min: 0, max: 40, default: 10 },
      mix: { min: 0, max: 1, default: 0.5 },
      'lowpass-cutoff': { min: 0, max: 1, default: 1 },
      'highpass-cutoff': { min: 0, max: 1, default: 0 }
    }
  },
  DELAY: {
    params: {
      time: { min: 0, max: 1.1, default: 0.5 },
      echo: { min: 0, max: 1, default: 0.5 },
      'wet-level': { min: 0, max: 1, default: 0.5 },
      'dry-level': { min: 0, max: 1, default: 1 },
      'lowpass-cutoff': { min: 0, max: 1, default: 1 },
      'highpass-cutoff': { min: 0, max: 1, default: 0 },
      'cross-feed': { min: 0, max: 1, default: 0 },
      balance: { min: 0, max: 1, default: 0.5 }
    }
  },
  REVERB: {
    params: {
      time: { min: 0, max: 1, default: 0.5 },
      'wet-level': { min: 0, max: 1, default: 0.5 },
      'dry-level': { min: 0, max: 1, default: 1 },
      'spring-mix': { min: 0, max: 1, default: 0 },
      'highpass-cutoff': { min: 0, max: 1, default: 0 }
    }
  },
  RING: {
    params: {
      frequency: { min: 0, max: 20000, default: 400 },
      mix: { min: 0, max: 1, default: 0.5 }
    }
  },
  HARMONY: {
    params: {
      pitch: { min: 0.5, max: 2, default: 1 },
      'dry-level': { min: 0, max: 1, default: 0 }
    }
  },
  SSB: {
    params: { frequency: { min: -20000, max: 20000, default: 0 } }
  },
  SAMPLE: {
    params: {
      speed: { min: 0, max: 4, default: 1 },
      pitch: { min: -24, max: 24, default: 0 },
      level: { min: 0, max: 1, default: 1 },
      balance: { min: 0, max: 1, default: 0.5 }
    }
  }
};

// Display name mapping
export function getEffectDisplayName(effectName) {
  return effectName;
}

// Map a firmware 0-1 "cutoff" knob to an approximate frequency (log, 20Hz-20kHz).
// NOTE: this curve is a common-sense guess, not reverse-engineered from the firmware -
// TE's own README documents the [0,1] range but never states the underlying Hz mapping.
// It can be replaced per-effect-type by real measurements - see the calibration wizard
// (js/calibration.js), which measures actual hardware behavior via a captured audio input.
function estimatedCutoffToFreq(cutoff) {
  const minFreq = 20;
  const maxFreq = 20000;
  return minFreq * Math.pow(maxFreq / minFreq, cutoff);
}

const CALIBRATION_STORAGE_KEY = 'ting-cutoff-calibration';
let calibration = {}; // { LOWPASS: [{cutoff, freq}, ...], HIGHPASS: [...], EQUALIZER: [...] }
try {
  calibration = JSON.parse(localStorage.getItem(CALIBRATION_STORAGE_KEY)) || {};
} catch {
  calibration = {};
}

function persistCalibration() {
  try {
    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    // ignore - calibration just won't survive a reload
  }
}

// Store a measured cutoff->Hz curve for one effect type. Points are sorted by cutoff and
// must have at least 2 entries with a valid `freq` to take effect.
export function setCutoffCalibration(effectType, points) {
  const valid = points.filter(p => typeof p.freq === 'number' && !isNaN(p.freq)).sort((a, b) => a.cutoff - b.cutoff);
  if (valid.length < 2) return false;
  calibration[effectType] = valid;
  persistCalibration();
  return true;
}

export function getCutoffCalibration(effectType) {
  return calibration[effectType] || null;
}

export function clearCutoffCalibration(effectType) {
  delete calibration[effectType];
  persistCalibration();
}

export function hasCutoffCalibration(effectType) {
  return !!calibration[effectType];
}

// cutoff -> Hz, using a measured calibration curve for this effect type when available
// (piecewise-log-linear interpolation between measured points), falling back to the
// estimated log(20Hz-20kHz) curve otherwise.
export function cutoffToFreq(cutoff, effectType) {
  const points = effectType && calibration[effectType];
  if (!points || points.length < 2) return estimatedCutoffToFreq(cutoff);

  if (cutoff <= points[0].cutoff) return points[0].freq;
  if (cutoff >= points[points.length - 1].cutoff) return points[points.length - 1].freq;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (cutoff >= a.cutoff && cutoff <= b.cutoff) {
      const t = (cutoff - a.cutoff) / (b.cutoff - a.cutoff);
      // interpolate in log-frequency space, matching the shape of the estimated curve
      const logFreq = Math.log(a.freq) + t * (Math.log(b.freq) - Math.log(a.freq));
      return Math.exp(logFreq);
    }
  }
  return estimatedCutoffToFreq(cutoff);
}

function formatHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}kHz` : `${Math.round(hz)}Hz`;
}

// A human-readable secondary readout for a param value, or null when the raw number
// (already firmware units) needs no translation. Purely cosmetic - never affects export.
export function formatParamHint(effectName, paramName, value) {
  if ((effectName === 'LOWPASS' || effectName === 'HIGHPASS' || effectName === 'EQUALIZER') && paramName === 'cutoff') {
    const prefix = hasCutoffCalibration(effectName) ? '' : '≈ ';
    return `${prefix}${formatHz(cutoffToFreq(value, effectName))}`;
  }
  // Other effects reuse the LOWPASS/HIGHPASS calibration for their own cutoff-shaped params
  // (same [0,1] convention in the firmware's param table - see fx_param_table_1.1.1.json)
  if (paramName === 'lowpass-cutoff') {
    const prefix = hasCutoffCalibration('LOWPASS') ? '' : '≈ ';
    return `${prefix}${formatHz(cutoffToFreq(value, 'LOWPASS'))}`;
  }
  if (paramName === 'highpass-cutoff') {
    const prefix = hasCutoffCalibration('HIGHPASS') ? '' : '≈ ';
    return `${prefix}${formatHz(cutoffToFreq(value, 'HIGHPASS'))}`;
  }
  if (effectName === 'DELAY' && paramName === 'time') {
    return `${Math.round(value * 1000)}ms`;
  }
  if ((effectName === 'SSB' || effectName === 'RING') && paramName === 'frequency') {
    return formatHz(Math.abs(value));
  }
  if (effectName === 'SAMPLE' && paramName === 'pitch') {
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}st`;
  }
  if (effectName === 'HARMONY' && paramName === 'pitch') {
    const semitones = Math.log2(value) * 12;
    return `${semitones > 0 ? '+' : ''}${semitones.toFixed(1)}st`;
  }
  return null;
}

// Create a default SAMPLE config
export function createDefaultSampleConfig() {
  const sampleDef = EFFECTS.SAMPLE;
  const config = { effect: 'SAMPLE' };
  Object.entries(sampleDef.params).forEach(([param, def]) => {
    config[param] = def.default;
  });
  return config;
}
