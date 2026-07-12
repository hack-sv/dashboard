import { useEffect, useRef } from 'react'

/**
 * Full-viewport dithered flower background.
 *
 * This is the same two-pass WebGL2 flower field that renders on the hack.sv
 * 2026 marketing site (a low-res scene pass -> ordered Bayer dither). It is
 * duplicated here rather than imported because the two live in separate
 * deployments; the shader source and the CPU placement math below must stay
 * byte-for-byte equivalent to 2026/src/components/FlowerBackground.astro, or
 * the seamless handoff (see the seed/clock helpers) won't line up.
 *
 * Seamlessness: the field is a pure function of (seed, time, aspect). The seed
 * is persisted in localStorage and the clock is anchored to a shared epoch (see
 * flowerSeed()/flowerEpochMs()), both keyed on the hack.sv origin — which /2026
 * and /dashboard share — so navigating between them continues the exact same
 * animation mid-drift instead of restarting it.
 */

// --- shared deterministic seed + clock (see file header) -------------------
const SEED_KEY = 'hacksv:flower-seed'
const EPOCH_KEY = 'hacksv:flower-epoch'
// Last rendered frame, handed between /2026 and /dashboard so the incoming page
// can paint it instantly (as the page background) while its own WebGL canvas
// boots — zero visual gap across the cross-Worker navigation. See the inline
// restore script in index.html and captureFrame()/the reveal logic below.
const FRAME_KEY = 'hacksv:flower-frame'
// Re-anchor the clock if the stored epoch is implausibly old, so the time value
// fed to the shader stays small enough for float32 precision. Only a tab left
// open (or a localStorage entry) older than this re-anchors, causing a one-time
// drift discontinuity — rare and harmless.
const MAX_EPOCH_AGE_MS = 6 * 60 * 60 * 1000 // 6h

function readNum(key: string): number | null {
  try {
    const v = localStorage.getItem(key)
    if (v == null) return null
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  } catch {
    return null // localStorage can throw (private mode, blocked cookies)
  }
}

function writeNum(key: string, n: number) {
  try {
    localStorage.setItem(key, String(n))
  } catch {
    /* ignore — falls back to an ephemeral value for this page load */
  }
}

/** Seed shared across /2026 and /dashboard so both draw the identical field. */
function flowerSeed(): number {
  const existing = readNum(SEED_KEY)
  if (existing != null) return existing
  const seed = Math.random() * 1000
  writeNum(SEED_KEY, seed)
  return seed
}

/** Shared wall-clock anchor (ms) so the animation phase is continuous across a
 *  navigation. Both pages read the same stored epoch and derive time from
 *  Date.now(), so they agree on the current frame at any instant. */
function flowerEpochMs(): number {
  const now = Date.now()
  const existing = readNum(EPOCH_KEY)
  if (existing != null && now - existing >= 0 && now - existing < MAX_EPOCH_AGE_MS) {
    return existing
  }
  writeNum(EPOCH_KEY, now)
  return now
}

export default function FlowerBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      alpha: false,
    })

    const fail = (msg: string) => {
      console.error('[FlowerBackground]', msg)
      canvas.style.opacity = '1' // ensure the fallback fill is visible
      const ctx = canvas.getContext('2d')
      if (ctx) {
        canvas.width = window.innerWidth
        canvas.height = window.innerHeight
        ctx.fillStyle = '#05060e'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }

    if (!gl) {
      fail('WebGL2 unavailable')
      return
    }

    const vertSrc = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

    const sceneFragSrc = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uSeed;

// Per-cluster placement precomputed on the CPU once per rendered frame (these
// values are identical for every pixel in a frame, so evaluating them per-pixel
// wasted hundreds of sin() per fragment).
uniform vec2 uCenters[15];
uniform float uRadii[15];
uniform float uRot[15];

const float PI = 3.14159265359;
const int CLUSTERS = 15;
const int PETAL_PATCHES = 4;

float hash11(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash11(dot(i, vec2(1.0, 57.0)));
  float b = hash11(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)));
  float c = hash11(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)));
  float d = hash11(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  // B2: 2 octaves instead of 3 — the finest octave is largely hidden by the
  // reduced-resolution scene pass and the Bayer dither, so dropping it is
  // nearly invisible while cutting every per-pixel fbm by about a third.
  for (int i = 0; i < 2; i++) {
    v += a * valueNoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

vec2 rotate2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c) * p;
}

vec4 poppyCluster(vec2 p, vec2 center, float radius, float rot, float seed, float t, float depth01) {
  vec2 d = rotate2(p - center, rot);

  float squash = mix(0.72, 1.22, hash11(seed + 2.0));
  d.x *= mix(0.82, 1.18, hash11(seed + 3.0));
  d.y *= squash;
  d.x += d.y * mix(-0.22, 0.22, hash11(seed + 4.0));

  float r = length(d);
  if (r > radius * 1.65) return vec4(0.0);

  float a = atan(d.y, d.x);
  float flowerPhase = hash11(seed + 5.0) * 2.0 * PI;
  float lobes = 4.0;
  float edgeNoise =
    0.21 * cos(lobes * a + flowerPhase) +
    0.07 * cos(8.0 * a + hash11(seed + 7.0) * 2.0 * PI) +
    0.08 * (fbm(vec2(cos(a), sin(a)) * 2.8 + vec2(seed)) - 0.5);

  float edge = radius * (1.0 + edgeNoise);
  float flex = sin(t * 0.55 + center.x * 2.2 + center.y * 1.7 + seed) * 0.035;
  edge += radius * flex * cos(a - 0.4);

  float soft = radius * mix(0.055, 0.095, 1.0 - depth01);
  float mask = 1.0 - smoothstep(edge - soft, edge + soft, r);

  float rn = r / max(radius, 0.001);
  float petalBand = 0.5 + 0.5 * cos(lobes * a + flowerPhase + rn * 1.7);
  float patchMask = 0.0;
  float patchShade = 0.0;
  float seamMask = 0.0;
  for (int n = 0; n < PETAL_PATCHES; n++) {
    float fn = float(n);
    float ps = seed + fn * 23.17;
    float pa = flowerPhase / lobes + (fn / float(PETAL_PATCHES)) * 2.0 * PI + (hash11(ps + 1.0) - 0.5) * 0.32;
    float reach = radius * mix(0.22, 0.42, hash11(ps + 2.0));
    vec2 offset = vec2(cos(pa), sin(pa)) * reach;
    vec2 q = rotate2(d - offset, -pa + mix(-0.24, 0.24, hash11(ps + 3.0)));
    vec2 petalScale = radius * vec2(
      mix(0.44, 0.68, hash11(ps + 4.0)),
      mix(0.24, 0.38, hash11(ps + 5.0))
    );
    float ell = length(q / max(petalScale, vec2(0.001)));
    float petalPatch = 1.0 - smoothstep(0.76, 1.02, ell);
    petalPatch *= mix(0.78, 1.0, hash11(ps + 6.0));
    patchMask = max(patchMask, petalPatch);
    patchShade += petalPatch * mix(0.35, 0.95, hash11(ps + 7.0));
    seamMask = max(seamMask, (1.0 - smoothstep(0.025, 0.105, abs(q.y / max(radius, 0.001)))) * smoothstep(0.18, 0.88, ell) * petalPatch);
  }
  patchShade /= max(patchMask * 2.4, 1.0);
  mask = clamp(mask * 0.72 + patchMask * 0.88, 0.0, 1.0);
  petalBand = mix(petalBand, patchShade, 0.72);
  float folds = fbm(d / radius * 3.0 + vec2(seed, seed * 0.37));
  float cup = 1.0 - smoothstep(0.05, 0.34, rn);
  float core = 1.0 - smoothstep(0.035, 0.16, rn);
  float rim = smoothstep(0.36, 1.02, rn);
  float missing = smoothstep(0.48, 0.70, fbm(d / radius * 2.0 + vec2(seed * 2.1)));
  float torn = smoothstep(0.40, 0.82, fbm(d / radius * 4.6 + vec2(-seed * 0.31, seed * 0.83))) *
    smoothstep(0.22, 0.96, rn);

  float bite =
    smoothstep(0.50, 0.82, fbm(d / radius * 2.4 + vec2(seed * 1.7, -seed))) *
    smoothstep(0.18, 0.85, rn);
  mask *= mix(1.0, 0.60, bite * 0.68);
  mask *= mix(1.0, 0.72, missing * smoothstep(0.28, 1.05, rn) * 0.58);
  mask *= mix(1.0, 0.76, torn * 0.38);

  float shadow = clamp(
    0.50 * cup +
    0.42 * (1.0 - petalBand) * (1.0 - rn * 0.45) +
    0.34 * seamMask +
    0.38 * core +
    0.30 * bite +
    0.18 * (1.0 - folds) +
    0.18 * missing +
    0.16 * torn,
    0.0,
    1.0
  );

  float shade = clamp(
    0.34 +
    0.50 * rim +
    0.22 * petalBand +
    0.17 * folds +
    0.12 * patchShade -
    0.54 * shadow,
    0.0,
    1.0
  );

  float outer = 1.0 - smoothstep(edge + soft * 0.4, edge + soft * 2.4, r);
  float halo = clamp(outer - mask, 0.0, 1.0);
  return vec4(clamp(mask, 0.0, 1.0), shade, shadow, halo);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 res = uResolution.x > 0.5 ? uResolution : vec2(1280.0, 720.0);
  vec2 uv = frag / res;
  float aspect = res.x / res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  float t = uTime;

  vec3 bgDark = vec3(0.008, 0.014, 0.035);
  vec3 bgBlue = vec3(0.018, 0.060, 0.120);
  vec3 petalDeep = vec3(0.018, 0.025, 0.070);
  vec3 petalDark = vec3(0.020, 0.110, 0.230);
  vec3 petalMid = vec3(0.090, 0.360, 0.720);
  vec3 petalSoft = vec3(0.340, 0.610, 0.960);
  vec3 petalHi = vec3(0.670, 0.820, 1.000);
  vec3 leafMute = vec3(0.150, 0.270, 0.260);

  float bgWash = fbm(p * 1.15 + vec2(t * 0.018, -t * 0.012));
  vec3 col = mix(bgDark, bgBlue, smoothstep(0.18, 0.92, bgWash) * 0.55);
  col += (fbm(p * 3.0 - vec2(t * 0.012, t * 0.008)) - 0.5) * vec3(0.014, 0.024, 0.045);

  float haze = fbm(p * 1.1 + vec2(t * 0.025, -t * 0.015));
  col += vec3(0.015, 0.040, 0.075) * smoothstep(0.35, 0.95, haze) * 0.55;

  for (int i = 0; i < CLUSTERS; i++) {
    float fi = float(i);
    float depth01 = fi / float(CLUSTERS - 1);
    float s = uSeed + fi * 17.31;

    // Placement (grid center + wind drift), radius, and rotation are the same
    // for every pixel in a frame, so they are precomputed on the CPU and
    // uploaded as uniform arrays (see computePlacements in the JS driver).
    vec2 center = uCenters[i];
    float radius = uRadii[i];
    float rot = uRot[i];

    vec4 fm = poppyCluster(p, center, radius, rot, s, t, depth01);
    float smearMask = (fm.w * 0.18 + fm.x * 0.035) * mix(0.42, 0.85, depth01);
    vec3 smearCol = mix(petalDeep, petalMid, 0.28) * mix(0.42, 0.72, depth01);
    col = mix(col, smearCol, smearMask);

    if (fm.x > 0.001) {
      vec2 local = (p - center) / max(radius, 0.001);
      float localR = length(local);
      float contactShadow = smoothstep(0.44, 0.88, fbm(local * 1.75 + vec2(s * 0.15, -s * 0.22))) *
        smoothstep(0.18, 0.96, localR) *
        mix(0.55, 1.0, depth01);
      float shade = fm.y;
      float shadow = clamp(fm.z + contactShadow * 0.55, 0.0, 1.0);
      vec3 petalCol = mix(petalDark, petalMid, smoothstep(0.18, 0.68, shade));
      petalCol = mix(petalCol, petalSoft, smoothstep(0.58, 0.90, shade));
      petalCol = mix(petalCol, petalHi, smoothstep(0.84, 1.00, shade) * 0.75);
      petalCol = mix(petalCol, petalDeep, shadow * 0.55);

      if (hash11(s + 20.0) > 0.58) {
        petalCol = mix(petalCol, leafMute, contactShadow * 0.18);
      }

      float dim = mix(0.62, 1.08, depth01);
      float alpha = fm.x * mix(0.72, 1.0, depth01);
      col = mix(col, petalCol * dim, alpha);
    }

    if (fm.w > 0.001) {
      vec3 haloCol = mix(bgBlue, petalSoft, 0.32) * mix(0.28, 0.55, depth01);
      col = mix(col, haloCol, fm.w * 0.16);
    }
  }

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

    const displayFragSrc = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform sampler2D uScene;
uniform vec2 uResolution;
uniform vec2 uSceneResolution;
uniform float uTime;
uniform float uSeed;
uniform float uDither;

const float BAYER[64] = float[64](
   0.0/64.0, 32.0/64.0,  8.0/64.0, 40.0/64.0,  2.0/64.0, 34.0/64.0, 10.0/64.0, 42.0/64.0,
  48.0/64.0, 16.0/64.0, 56.0/64.0, 24.0/64.0, 50.0/64.0, 18.0/64.0, 58.0/64.0, 26.0/64.0,
  12.0/64.0, 44.0/64.0,  4.0/64.0, 36.0/64.0, 14.0/64.0, 46.0/64.0,  6.0/64.0, 38.0/64.0,
  60.0/64.0, 28.0/64.0, 52.0/64.0, 20.0/64.0, 62.0/64.0, 30.0/64.0, 54.0/64.0, 22.0/64.0,
   3.0/64.0, 35.0/64.0, 11.0/64.0, 43.0/64.0,  1.0/64.0, 33.0/64.0,  9.0/64.0, 41.0/64.0,
  51.0/64.0, 19.0/64.0, 59.0/64.0, 27.0/64.0, 49.0/64.0, 17.0/64.0, 57.0/64.0, 25.0/64.0,
  15.0/64.0, 47.0/64.0,  7.0/64.0, 39.0/64.0, 13.0/64.0, 45.0/64.0,  5.0/64.0, 37.0/64.0,
  63.0/64.0, 31.0/64.0, 55.0/64.0, 23.0/64.0, 61.0/64.0, 29.0/64.0, 53.0/64.0, 21.0/64.0
);

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 res = uResolution.x > 0.5 ? uResolution : vec2(1280.0, 720.0);
  vec2 uv = frag / res;
  vec2 texel = 1.0 / max(uSceneResolution, vec2(1.0));
  vec3 col = texture(uScene, clamp(uv, texel * 0.5, 1.0 - texel * 0.5)).rgb;

  // Tonal remap (floor lift / ceiling pull), shared by the dithered path and
  // the dither-off easter egg below.
  vec3 floorCol = vec3(0.0);
  vec3 ceilCol = vec3(1.04);

  // Easter egg: window.removeDither() in the console flips uDither to 0 and
  // reveals the raw low-res flower field with the Bayer dithering stripped.
  if (uDither < 0.5) {
    outColor = vec4(clamp(floorCol + (ceilCol - floorCol) * col, 0.0, 1.0), 1.0);
    return;
  }

  vec2 ditherFrag = floor(frag / 1.0);
  int bx = int(mod(ditherFrag.x, 8.0));
  int by = int(mod(ditherFrag.y, 8.0));
  float threshold = BAYER[by * 8 + bx];

  vec3 gammaCol = pow(max(col, vec3(0.0)), vec3(0.82));
  float lum = dot(gammaCol, vec3(0.299, 0.587, 0.114));

  float bands = mix(4.0, 7.0, smoothstep(0.18, 0.72, lum));
  float q = floor(lum * bands + threshold * 0.95) / bands;
  gammaCol *= q / max(lum, 0.0015);

  gammaCol.r = floor(gammaCol.r * 8.0 + threshold * 0.65) / 8.0;
  gammaCol.g = floor(gammaCol.g * 10.0 + threshold * 0.70) / 10.0;
  gammaCol.b = floor(gammaCol.b * 12.0 + threshold * 0.75) / 12.0;

  col = pow(max(gammaCol, vec3(0.0)), vec3(1.0 / 0.82));
  // Remap the final tonal range: lift the floor off pitch-black and pull the
  // ceiling down a touch (highlights ran hot). floorCol/ceilCol are declared
  // at the top of main() so the dither-off path shares them.
  col = floorCol + (ceilCol - floorCol) * col;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('[FlowerBackground] shader compile error:\n', gl.getShaderInfoLog(sh), '\nsource:\n', src)
        gl.deleteShader(sh)
        return null
      }
      return sh
    }

    const createProgram = (fragSrc: string, label: string): WebGLProgram | null => {
      const vs = compile(gl.VERTEX_SHADER, vertSrc)
      const fs = compile(gl.FRAGMENT_SHADER, fragSrc)
      if (!vs || !fs) return null

      const prog = gl.createProgram()
      if (!prog) return null

      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(`[FlowerBackground] ${label} link error:`, gl.getProgramInfoLog(prog))
        gl.deleteProgram(prog)
        return null
      }

      return prog
    }

    const sceneProg = createProgram(sceneFragSrc, 'scene')
    const displayProg = createProgram(displayFragSrc, 'display')
    const vao = gl.createVertexArray()
    const buf = gl.createBuffer()
    const sceneTexture = gl.createTexture()
    const sceneFramebuffer = gl.createFramebuffer()

    if (!sceneProg || !displayProg || !vao || !buf || !sceneTexture || !sceneFramebuffer) {
      fail('WebGL setup failed')
      return
    }

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const sceneUResolution = gl.getUniformLocation(sceneProg, 'uResolution')
    const sceneUTime = gl.getUniformLocation(sceneProg, 'uTime')
    const sceneUSeed = gl.getUniformLocation(sceneProg, 'uSeed')
    const sceneUCenters = gl.getUniformLocation(sceneProg, 'uCenters')
    const sceneURadii = gl.getUniformLocation(sceneProg, 'uRadii')
    const sceneURot = gl.getUniformLocation(sceneProg, 'uRot')
    const displayUScene = gl.getUniformLocation(displayProg, 'uScene')
    const displayUResolution = gl.getUniformLocation(displayProg, 'uResolution')
    const displayUSceneResolution = gl.getUniformLocation(displayProg, 'uSceneResolution')
    const displayUTime = gl.getUniformLocation(displayProg, 'uTime')
    const displayUSeed = gl.getUniformLocation(displayProg, 'uSeed')
    const displayUDither = gl.getUniformLocation(displayProg, 'uDither')

    // Deterministic + shared across /2026 and /dashboard (see file header).
    const seed = flowerSeed()
    const epoch = flowerEpochMs()
    const CLUSTERS = 15

    // --- CPU port of the scene shader's per-cluster placement math. ---
    // Replicates the GLSL helpers (hash11/valueNoise/fbm/windField/clusterCenter/
    // clusterRadius/movedCenter + sizeScale + rot) exactly so centers/radii/rot
    // are computed once per frame and uploaded as uniform arrays instead of
    // recomputed per pixel. GLSL semantics: fract(x)=x-floor(x),
    // mix(a,b,t)=a+(b-a)*t, sin in radians. Must stay in lockstep with the 2026
    // copy — the seamless handoff depends on identical output.
    const PI_JS = 3.14159265359
    const fract = (x: number) => x - Math.floor(x)
    const mix = (a: number, b: number, t: number) => a + (b - a) * t
    const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)
    const hash11 = (n: number) => fract(Math.sin(n * 12.9898) * 43758.5453)

    const valueNoise = (px: number, py: number) => {
      const ix = Math.floor(px)
      const iy = Math.floor(py)
      const fx = px - ix
      const fy = py - iy
      const ux = fx * fx * (3.0 - 2.0 * fx)
      const uy = fy * fy * (3.0 - 2.0 * fy)
      const a = hash11(ix * 1.0 + iy * 57.0)
      const b = hash11((ix + 1.0) * 1.0 + iy * 57.0)
      const c = hash11(ix * 1.0 + (iy + 1.0) * 57.0)
      const d = hash11((ix + 1.0) * 1.0 + (iy + 1.0) * 57.0)
      return mix(mix(a, b, ux), mix(c, d, ux), uy)
    }

    const fbm = (px: number, py: number) => {
      let v = 0.0
      let a = 0.5
      for (let i = 0; i < 3; i++) {
        v += a * valueNoise(px, py)
        px *= 2.02
        py *= 2.02
        a *= 0.5
      }
      return v
    }

    // windField(pos, t) -> vec2
    const windField = (posx: number, posy: number, t: number): [number, number] => {
      const wave = fbm(posx * 0.72 + t * 0.055, posy * 0.72 + -t * 0.025)
      const gust = fbm(posx * 1.35 + -t * 0.040, posy * 1.35 + t * 0.030)
      const strength = wave * 0.75 + gust * 0.25 - 0.5
      return [0.055 * strength, -0.018 * strength]
    }

    // Reused typed arrays uploaded to the scene shader each frame.
    const centersArr = new Float32Array(CLUSTERS * 2)
    const radiiArr = new Float32Array(CLUSTERS)
    const rotArr = new Float32Array(CLUSTERS)

    const computePlacements = (aspect: number, t: number) => {
      const regionAspect = (aspect + 0.36) / 1.36
      const gridCols = clamp(Math.floor(Math.sqrt(CLUSTERS * regionAspect) + 0.5), 3.0, 9.0)
      const gridRows = clamp(Math.floor(CLUSTERS / gridCols + 0.5), 2.0, 4.0)
      const sizeScale = 3.0 / gridRows

      const COLS = Math.trunc(clamp(Math.floor(Math.sqrt(CLUSTERS * regionAspect) + 0.5), 3.0, 9.0))
      const ROWS = Math.trunc(clamp(Math.floor(CLUSTERS / COLS + 0.5), 2.0, 4.0))
      const cells = COLS * ROWS
      const cellW = (aspect + 0.36) / COLS
      const cellH = 1.36 / ROWS

      for (let id = 0; id < CLUSTERS; id++) {
        const fi = id
        const depth01 = fi / (CLUSTERS - 1)
        const s = seed + fi * 17.31

        const cell = (((id + Math.trunc(hash11(seed) * cells)) % cells) + cells) % cells
        const col = cell % COLS
        const row = Math.trunc(cell / COLS)
        const hn = seed + fi * 17.31
        const rndX = fract(Math.sin(hn) * 43758.5453)
        const rndY = fract(Math.sin(hn + 1.7) * 22578.1459)
        let cx = (col + 0.5 + (rndX - 0.5) * 0.85) * cellW + -0.18
        let cy = (row + 0.5 + (rndY - 0.5) * 0.85) * cellH + -0.18

        let radius = mix(0.28, 0.44, depth01) * (0.88 + 0.28 * hash11(s + 3.1))
        if (id < 6) radius *= 1.08
        if (id === 10 || id === 12) radius *= 1.18
        radius *= sizeScale

        const rot = hash11(s + 5.7) * 2.0 * PI_JS

        const motionScale = mix(0.35, 1.0, depth01)
        const lag = mix(0.65, 1.25, hash11(s + 12.0))
        const w0 = windField(cx, cy, t)
        cx += w0[0] * motionScale
        cy += w0[1] * motionScale
        const w1 = windField(cx, cy, t - lag)
        cx += w1[0] * motionScale * 0.28
        cy += w1[1] * motionScale * 0.28

        centersArr[id * 2] = cx
        centersArr[id * 2 + 1] = cy
        radiiArr[id] = radius
        rotArr[id] = rot
      }
    }

    const STEP_FPS = 15
    // B3: 15fps instead of 18 — imperceptible on this slow drift, ~17% fewer
    // scene renders.
    // Motion speed, independent of the frame rate: <1 slows the animation
    // itself without changing how many distinct frames per second are drawn.
    const TIME_SCALE = 0.75
    const TARGET_PIXEL_SIZE = 3
    // B1: the flower scene renders at 1/SCENE_DOWNSCALE of the display res.
    const SCENE_DOWNSCALE = 2
    const MAX_RENDER_PIXELS = 1_050_000
    const start = performance.now()
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    let sceneWidth = 0
    let sceneHeight = 0
    let needsScene = true
    let needsDisplay = true
    let lastFrame = -1
    let rafId = 0
    let timeoutId = 0
    let running = !document.hidden
    // Easter-egg toggle: window.removeDither()/restoreDither() flip this.
    let dither = 1.0
    // The canvas starts hidden (opacity 0 in JSX) so the handed-over last-frame
    // bridge shows through until we have a real frame; flipped on first draw.
    let revealed = false

    const onContextLost = (event: Event) => {
      event.preventDefault()
      running = false
    }
    const onContextRestored = () => {
      window.location.reload()
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)

    const allocateSceneTarget = (w: number, h: number) => {
      gl.bindTexture(gl.TEXTURE_2D, sceneTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      // LINEAR so the reduced-resolution scene (B1) upsamples smoothly into the
      // full-res dither pass; NEAREST would reintroduce visible blockiness.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTexture, 0)

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        fail('scene framebuffer incomplete')
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    const resize = () => {
      const cssW = Math.max(1, window.innerWidth)
      const cssH = Math.max(1, window.innerHeight)
      let pixelSize = TARGET_PIXEL_SIZE
      let w = Math.max(1, Math.ceil(cssW / pixelSize))
      let h = Math.max(1, Math.ceil(cssH / pixelSize))

      while (w * h > MAX_RENDER_PIXELS) {
        pixelSize += 1
        w = Math.max(1, Math.ceil(cssW / pixelSize))
        h = Math.max(1, Math.ceil(cssH / pixelSize))
      }

      if (canvas.width === w && canvas.height === h) return

      canvas.width = w
      canvas.height = h
      // B1: render the flower scene at a fraction of the display resolution
      // (the dither pass still runs at full display res). The scene is smooth
      // gradients + soft flowers, so downsampling it is nearly invisible once
      // dithered, but cuts the scene shader's pixel count by ~SCENE_DOWNSCALE^2.
      sceneWidth = Math.max(1, Math.ceil(w / SCENE_DOWNSCALE))
      sceneHeight = Math.max(1, Math.ceil(h / SCENE_DOWNSCALE))
      allocateSceneTarget(sceneWidth, sceneHeight)
      needsScene = true
      needsDisplay = true
      lastFrame = -1
    }

    const renderSceneTexture = (animTime: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer)
      gl.viewport(0, 0, sceneWidth, sceneHeight)
      gl.clearColor(0.02, 0.024, 0.055, 1.0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(sceneProg)
      gl.bindVertexArray(vao)
      gl.uniform2f(sceneUResolution, sceneWidth, sceneHeight)
      gl.uniform1f(sceneUTime, animTime)
      gl.uniform1f(sceneUSeed, seed)
      computePlacements(sceneWidth / sceneHeight, animTime)
      gl.uniform2fv(sceneUCenters, centersArr)
      gl.uniform1fv(sceneURadii, radiiArr)
      gl.uniform1fv(sceneURot, rotArr)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    const renderDisplayFrame = (animTime: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0.02, 0.024, 0.055, 1.0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(displayProg)
      gl.bindVertexArray(vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, sceneTexture)
      gl.uniform1i(displayUScene, 0)
      gl.uniform2f(displayUResolution, canvas.width, canvas.height)
      gl.uniform2f(displayUSceneResolution, sceneWidth, sceneHeight)
      gl.uniform1f(displayUTime, animTime)
      gl.uniform1f(displayUSeed, seed)
      gl.uniform1f(displayUDither, dither)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    // Prompt (one-shot) scheduling: fire on the next vsync. Used for resize,
    // visibility-resume and reduced-motion redraws so they aren't delayed a
    // whole frame. Guards on both rafId and timeoutId so it can't
    // double-schedule when the throttled loop already has a tick pending.
    const scheduleRender = () => {
      if (rafId === 0 && timeoutId === 0 && running) {
        rafId = requestAnimationFrame(render)
      }
    }

    // Throttled scheduling for the animation loop: wait until the next STEP_FPS
    // frame boundary (computed from the wall clock so timing stays accurate),
    // then a single rAF for vsync alignment. Wakes the main thread ~STEP_FPS/s
    // instead of ~60/s.
    const scheduleNextFrame = () => {
      if (rafId === 0 && timeoutId === 0 && running) {
        const frameMs = 1000 / STEP_FPS
        const elapsed = performance.now() - start
        const delay = Math.max(0, frameMs - (elapsed % frameMs))
        timeoutId = window.setTimeout(() => {
          timeoutId = 0
          if (rafId === 0 && running) {
            rafId = requestAnimationFrame(render)
          }
        }, delay)
      }
    }

    const render = () => {
      rafId = 0
      if (!running) return

      // Time is derived from the shared epoch (not per-load performance.now())
      // so the animation phase is continuous across a /2026 -> /dashboard
      // navigation. Both pages agree on `frame` at any wall-clock instant.
      const elapsed = prefersReducedMotion.matches ? 0 : (Date.now() - epoch) / 1000
      const frame = Math.floor(elapsed * STEP_FPS)
      const tQuantized = frame / STEP_FPS
      // Motion speed is decoupled from the frame rate: TIME_SCALE slows the
      // animation itself; STEP_FPS only sets how many distinct frames/sec are
      // drawn. Slower motion, same smoothness.
      const animTime = tQuantized * TIME_SCALE

      if (needsScene || frame !== lastFrame) {
        renderSceneTexture(animTime)
        needsScene = false
        needsDisplay = false
        lastFrame = frame
        renderDisplayFrame(animTime)
      } else if (needsDisplay) {
        needsDisplay = false
        renderDisplayFrame(animTime)
      }

      if (!revealed) {
        // First live frame is on screen — reveal the canvas and drop the
        // handed-over last-frame bridge painted as the page background.
        revealed = true
        canvas.style.opacity = '1'
        try {
          const rootStyle = document.documentElement.style
          rootStyle.backgroundImage = ''
          rootStyle.imageRendering = ''
        } catch {
          /* ignore */
        }
      }

      if (!prefersReducedMotion.matches) {
        scheduleNextFrame()
      }
    }

    // On navigating away, snapshot the current frame so the next page (marketing
    // or dashboard — same origin) can paint it instantly and bridge its own
    // WebGL boot with zero visible gap. Drawing then reading back within one
    // synchronous task means no preserveDrawingBuffer is required.
    const captureFrame = () => {
      try {
        const elapsed = prefersReducedMotion.matches ? 0 : (Date.now() - epoch) / 1000
        const frame = Math.floor(elapsed * STEP_FPS)
        const animTime = (frame / STEP_FPS) * TIME_SCALE
        renderSceneTexture(animTime)
        renderDisplayFrame(animTime)
        sessionStorage.setItem(FRAME_KEY, canvas.toDataURL('image/jpeg', 0.92))
      } catch {
        /* ignore — the next page just falls back to the navy background */
      }
    }

    const onResize = () => {
      resize()
      scheduleRender()
    }
    const onVisibility = () => {
      running = !document.hidden
      if (running) {
        needsDisplay = true
        lastFrame = -1
        scheduleRender()
      } else if (timeoutId !== 0) {
        // Tab hidden: cancel the pending throttle timer so no tick fires while
        // paused (no leaked timers).
        clearTimeout(timeoutId)
        timeoutId = 0
      }
    }
    const onReducedMotionChange = () => {
      needsDisplay = true
      lastFrame = -1
      scheduleRender()
    }

    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    prefersReducedMotion.addEventListener('change', onReducedMotionChange)
    window.addEventListener('pagehide', captureFrame)

    // Console easter egg: strip the dither to reveal the raw low-res flower
    // field. Call removeDither() (restoreDither() to undo) in the devtools console.
    const applyDither = (on: boolean) => {
      dither = on ? 1.0 : 0.0
      needsDisplay = true
      lastFrame = -1
      scheduleRender()
    }
    ;(window as unknown as Record<string, unknown>).removeDither = () => applyDither(false)
    ;(window as unknown as Record<string, unknown>).restoreDither = () => applyDither(true)

    // Force a full allocation on mount. Under React StrictMode the effect runs
    // twice; the second run gets fresh GL objects but the canvas still carries
    // the first run's dimensions, so without this reset resize() would
    // early-return and never attach the scene texture to the new framebuffer
    // (incomplete framebuffer -> black screen until a real resize fixes it).
    canvas.width = 0
    canvas.height = 0
    resize()
    scheduleRender()

    return () => {
      running = false
      if (rafId !== 0) cancelAnimationFrame(rafId)
      if (timeoutId !== 0) clearTimeout(timeoutId)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      prefersReducedMotion.removeEventListener('change', onReducedMotionChange)
      window.removeEventListener('pagehide', captureFrame)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      gl.deleteProgram(sceneProg)
      gl.deleteProgram(displayProg)
      gl.deleteBuffer(buf)
      gl.deleteVertexArray(vao)
      gl.deleteTexture(sceneTexture)
      gl.deleteFramebuffer(sceneFramebuffer)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        display: 'block',
        imageRendering: 'pixelated',
        pointerEvents: 'none',
        zIndex: -1,
        opacity: 0,
      }}
    />
  )
}
