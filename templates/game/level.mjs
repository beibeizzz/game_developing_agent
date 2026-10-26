// Bootstrap implementation is replaced by Level Coder after the approved level design.
export function generateLevel({ seed = 1024, difficulty = 'normal', width = 960, height = 600 }) {
  return { version: 'bootstrap', seed, difficulty, width, height, duration: 30, waves: [] };
}
export function validateLevel(level) {
  return { valid: level.width > 0 && level.height > 0, errors: [] };
}
