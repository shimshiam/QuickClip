'use strict';

const DEFAULTS = Object.freeze({ syncText: true, syncImages: true, syncFiles: true,
  maxHistory: 50, maxTextBytes: 1024 * 1024, maxImageBytes: 20 * 1024 * 1024 });

function validateSettings(input = {}, current = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings');
  const result = { ...DEFAULTS, ...current };
  for (const key of ['syncText', 'syncImages', 'syncFiles']) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') throw new Error(`${key} must be true or false`);
    result[key] = input[key];
  }
  for (const [key, min, max] of [['maxHistory', 1, 200], ['maxTextBytes', 1, DEFAULTS.maxTextBytes],
    ['maxImageBytes', 1, DEFAULTS.maxImageBytes]]) {
    if (!(key in input)) continue;
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new Error(`Invalid ${key}`);
    result[key] = input[key];
  }
  return result;
}

function createPolicy(settings = {}) {
  let current = validateSettings(settings);
  let paused = false;
  return {
    get: () => ({ ...current, paused }),
    update: (input) => { current = validateSettings(input, current); },
    pause: (value) => { paused = Boolean(value); },
    allows: (type) => !paused && current[{ text: 'syncText', image: 'syncImages', file: 'syncFiles' }[type]] === true,
    assert(type) {
      if (paused) throw new Error('Sync is paused on Windows');
      if (!this.allows(type)) throw new Error(`${type} sync is disabled on Windows`);
    },
  };
}

module.exports = { DEFAULTS, validateSettings, createPolicy };
