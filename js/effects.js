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
// Use the live spectrum view (see spectrum.js) to see what a cutoff actually does to the signal.
export function cutoffToFreq(cutoff) {
  const minFreq = 20;
  const maxFreq = 20000;
  return minFreq * Math.pow(maxFreq / minFreq, cutoff);
}

function formatHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}kHz` : `${Math.round(hz)}Hz`;
}

// A human-readable secondary readout for a param value, or null when the raw number
// (already firmware units) needs no translation. Purely cosmetic - never affects export.
export function formatParamHint(effectName, paramName, value) {
  if ((effectName === 'LOWPASS' || effectName === 'HIGHPASS' || effectName === 'EQUALIZER') && paramName === 'cutoff') {
    return `≈ ${formatHz(cutoffToFreq(value))}`;
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
