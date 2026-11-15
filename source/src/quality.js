// ============================================================================
// detail level, chosen before anything is built
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low. Lower levels thin out trees, shrubs, grass and people, use smaller shadow maps,
// drop anti-aliasing (Low) and start at a lower render resolution.
// localStorage.bwalk = level. bwalkLoad is set while the world is built: still set on the next visit means
// that load crashed the tab, so this one runs a level lower.
const mob = matchMedia('(pointer:coarse)').matches, mem = navigator.deviceMemory;
const keep = (k, v) => { try { localStorage[k] = v; } catch {} };
let LV, bad;
try { LV = localStorage.bwalk; bad = localStorage.bwalkLoad; } catch {}
LV = LV != null && LV !== '' ? +LV : mob ? (mem > 7 ? 1 : 2) : mem && mem <= 4 ? 2 : 0;
if (bad && LV < 2) keep('bwalk', ++LV);
const DENS = [1, 0.55, 0.3][LV];          // share of trees, bushes, people and beach life
const SHADOW = [2048, 2048, 1024][LV];    // shadow map size (per cascade)
const AA = LV > 1 ? 1 : 4;                // MSAA samples
let SCALE = [1, 0.85, 0.6][LV];           // render resolution (dynamic, see main.js)
