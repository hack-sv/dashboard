import { useEffect, useRef } from 'react'

/**
 * Full-viewport dithered background.
 *
 * Ported from hack.sv 2026's FlowerBackground: a two-pass WebGL2 pipeline
 * (low-res scene render -> ordered Bayer dither) that gives the retro,
 * banded look. The flower scene shader has been replaced with slow-moving
 * ocean-style waves, but the palette and the dither pass are identical.
 */
export default function WaveBackground() {
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
      console.error('[WaveBackground]', msg)
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

    // --- scene pass: slow rolling waves ---------------------------------
    // Same navy->sky-blue palette as the 2026 flowers. Layers are drawn
    // back-to-front; only the crest band of each layer stays visible, so
    // the screen reads as overlapping wave ridges rolling past.
    const sceneFragSrc = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uSeed;

const float PI = 3.14159265359;

float hash11(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

vec2 hash21(float n) {
  return fract(sin(vec2(n, n + 1.7)) * vec2(43758.5453, 22578.1459));
}

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
  for (int i = 0; i < 3; i++) {
    v += a * valueNoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

// Domain warp: fold the plane through fbm twice, so iso-lines of the
// final field bend into smooth liquid sheets. Returns the scalar field
// plus the intermediate warp vectors (used for sheen + ribbons).
float flowField(vec2 p, float t, out vec2 q, out vec2 r) {
  q = vec2(
    fbm(p + vec2(0.0, 0.0) + t * 0.12),
    fbm(p + vec2(5.2, 1.3) - t * 0.10)
  );
  r = vec2(
    fbm(p + 1.3 * q + vec2(1.7, 9.2) - t * 0.09),
    fbm(p + 1.3 * q + vec2(8.3, 2.8) + t * 0.08)
  );
  return fbm(p + 1.7 * r + t * 0.05);
}

// A rounded-teardrop petal with fake volume shading, so it reads as a
// curled 3D petal, not a flat sprite. Returns coverage 0..1 and writes a
// 0 (shadow) .. 1 (lit) shade that follows the petal as it rotates.
float petal(vec2 pos, vec2 center, float size, float rot, float width, out float shade) {
  vec2 d = pos - center;
  float c = cos(rot), s = sin(rot);
  vec2 dl = mat2(c, -s, s, c) * d / max(size, 1e-4);

  // Teardrop: pinched to a narrow base at dl.y<0, rounded at the tip.
  float pinch = mix(0.32, 1.0, smoothstep(-1.0, 0.35, dl.y));
  vec2 e = vec2(dl.x / (width * pinch), dl.y);
  float r = length(e);

  // Fake surface normal: the petal bulges out of screen and curls at its
  // edges. Rotate that normal into world space and light it from the
  // upper-left, so the lit/shadow sides swing around as the petal turns.
  vec2 nLocal = vec2(e.x, dl.y * 0.5);
  vec2 nWorld = mat2(c, s, -s, c) * nLocal;
  float diff = 0.5 + 0.5 * dot(normalize(nWorld + vec2(1e-4)), vec2(-0.45, 0.62));
  float dome = sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0)));
  shade = clamp(0.26 + 0.58 * diff + 0.26 * dome, 0.0, 1.0);

  // Feathered edge with a solid body.
  return smoothstep(1.0, 0.40, r);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 res = uResolution.x > 0.5 ? uResolution : vec2(1280.0, 720.0);
  vec2 uv = frag / res;
  float aspect = res.x / res.y;

  // Slow, drifting flow. Two overlaid scales give parallax — a broad
  // backdrop sheet and a nearer one flowing past it.
  float t = uTime * 0.14;
  vec2 base = vec2(uv.x * aspect, uv.y);
  vec2 drift = vec2(t * 0.02, -t * 0.014);

  // Blue family, same hues as the 2026 flowers. The floor is a real
  // navy — the field never resolves to black.
  vec3 c1 = vec3(0.028, 0.115, 0.250);
  vec3 c2 = vec3(0.050, 0.210, 0.450);
  vec3 c3 = vec3(0.110, 0.350, 0.680);
  vec3 c4 = vec3(0.280, 0.520, 0.830);
  vec3 c5 = vec3(0.500, 0.680, 0.930);

  // One broad, soft warp sheet for the backdrop (cheap — the petals
  // carry the definition, so we don't pay for a second warp).
  vec2 qA, rA;
  float fA = flowField(base * 1.2 + drift + vec2(uSeed * 0.017), t, qA, rA);

  // A slow, large-scale glow so even the low regions keep a gentle
  // gradient — never a flat, dead navy field.
  float glow = smoothstep(0.25, 0.85, fbm(base * 0.6 + qA * 0.4 + drift));

  // Remap so the darkest regions still sit at a live navy (c1), not black.
  float f = smoothstep(0.18, 0.86, fA);
  f = mix(f, max(f, glow * 0.55), 0.6);
  f = 0.34 + 0.66 * f;

  vec3 col = c1;
  col = mix(col, c2, smoothstep(0.24, 0.50, f));
  col = mix(col, c3, smoothstep(0.46, 0.72, f));
  col = mix(col, c4, smoothstep(0.68, 0.88, f));
  col = mix(col, c5, smoothstep(0.87, 0.99, f));

  // Soft sheen where the warp folds — light glancing off silk.
  float sheen = length(rA - 0.5);
  col = mix(col, c4, smoothstep(0.42, 0.85, sheen) * 0.20);

  // Faint flowing ribbon creases, kept subtle.
  float ribbon = 0.5 + 0.5 * sin((rA.x * 2.4 + qA.y * 2.0 + f * 4.0 + t * 0.4) * PI * 2.0);
  ribbon = pow(ribbon, 6.0);
  col = mix(col, c5, ribbon * 0.16 * smoothstep(0.35, 0.9, f));

  // --- drifting petals: soft, abstract, flowery definition ----------
  // Each petal falls slowly while the wind pushes it side to side, so it
  // swirls and drifts around rather than dropping straight. Nearer petals
  // (higher depth) are larger, brighter and sway wider — parallax. They
  // blend translucently into the silk and wrap around the screen.
  // A few large 3D petals falling and drifting in the wind. They run on
  // their own clock (faster than the slow silk) so the fall reads clearly.
  const int PETALS = 18;
  float wrapW = aspect + 1.6;
  float pt = uTime;
  for (int i = 0; i < PETALS; i++) {
    float fi = float(i);
    vec2 h = hash21(fi * 3.17 + uSeed * 0.019);
    float depth = hash11(fi * 1.61 + 4.2);      // 0 back .. 1 front
    // All big: even the rear petals are large now, and the foreground
    // giants span well over half the screen.
    float size = mix(0.46, 0.70, depth) * mix(0.94, 1.08, hash11(fi + 13.0));
    float width = mix(0.52, 0.70, hash11(fi + 9.0));
    float phase = h.x * 6.2831 + fi;

    float fallSpeed = mix(0.040, 0.075, depth);           // gentle descent
    float swayAmp = mix(0.06, 0.14, depth);
    float swayFreq = mix(0.18, 0.36, hash11(fi + 2.0));
    float lateral = (hash11(fi + 5.0) - 0.5) * 0.03;      // slow net drift

    // Wind: two offset sines so the sideways path meanders and loops.
    float sway = sin(pt * swayFreq + phase) * 0.7 + sin(pt * swayFreq * 0.47 + phase * 1.7) * 0.3;

    // Seed initial positions on a low-discrepancy (golden-ratio)
    // sequence rather than the raw hash, so the petals are evenly
    // spread from the very first frame — no start-up clump, no gap.
    float vx = fract(fi * 0.7548776662 + h.x * 0.3);
    float vy = fract(fi * 0.6180339887 + h.y * 0.25);

    // Wide wrap margins so the large petals leave the frame fully
    // before reappearing on the far side (no popping).
    float px = mod(vx * wrapW + sway * swayAmp + pt * lateral, wrapW) - 0.8;
    float py = mod(vy * 2.6 - pt * fallSpeed, 2.6) - 0.8;   // falls, wraps to top
    vec2 center = vec2(px, py);

    // Gentle flutter: the petal tips with the wind as it sways.
    float rot = phase + sway * 0.7;
    float shade;
    float m = petal(base, center, size, rot, width, shade);
    if (m <= 0.003) continue;

    // Dark→light across the petal's 3D form; front petals a touch bolder.
    vec3 pc = mix(c2, c5, shade);
    float alpha = m * mix(0.55, 0.82, depth);
    col = mix(col, pc, alpha);
  }

  // Very gentle depth shaping.
  col *= mix(0.96, 1.05, smoothstep(0.1, 0.85, f));

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

    // --- display pass: ordered Bayer dither (unchanged from 2026) -------
    const displayFragSrc = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform sampler2D uScene;
uniform vec2 uResolution;
uniform vec2 uSceneResolution;
uniform float uTime;
uniform float uSeed;

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
  col *= 0.98;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('[WaveBackground] shader compile error:\n', gl.getShaderInfoLog(sh), '\nsource:\n', src)
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
        console.error(`[WaveBackground] ${label} link error:`, gl.getProgramInfoLog(prog))
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
    const displayUScene = gl.getUniformLocation(displayProg, 'uScene')
    const displayUResolution = gl.getUniformLocation(displayProg, 'uResolution')
    const displayUSceneResolution = gl.getUniformLocation(displayProg, 'uSceneResolution')
    const displayUTime = gl.getUniformLocation(displayProg, 'uTime')
    const displayUSeed = gl.getUniformLocation(displayProg, 'uSeed')

    const seed = Math.random() * 1000
    const STEP_FPS = 18
    const TARGET_PIXEL_SIZE = 3
    const MAX_RENDER_PIXELS = 1_050_000
    const start = performance.now()
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    let sceneWidth = 0
    let sceneHeight = 0
    let needsScene = true
    let needsDisplay = true
    let lastFrame = -1
    let rafId = 0
    let running = !document.hidden

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
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
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
      sceneWidth = w
      sceneHeight = h
      allocateSceneTarget(w, h)
      needsScene = true
      needsDisplay = true
      lastFrame = -1
    }

    const renderSceneTexture = (tQuantized: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer)
      gl.viewport(0, 0, sceneWidth, sceneHeight)
      gl.clearColor(0.02, 0.024, 0.055, 1.0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(sceneProg)
      gl.bindVertexArray(vao)
      gl.uniform2f(sceneUResolution, sceneWidth, sceneHeight)
      gl.uniform1f(sceneUTime, tQuantized)
      gl.uniform1f(sceneUSeed, seed)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }

    const renderDisplayFrame = (tQuantized: number) => {
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
      gl.uniform1f(displayUTime, tQuantized)
      gl.uniform1f(displayUSeed, seed)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const scheduleRender = () => {
      if (rafId === 0 && running) {
        rafId = requestAnimationFrame(render)
      }
    }

    const render = () => {
      rafId = 0
      if (!running) return

      const elapsed = prefersReducedMotion.matches ? 0 : (performance.now() - start) / 1000
      const frame = Math.floor(elapsed * STEP_FPS)
      const tQuantized = frame / STEP_FPS

      if (needsScene || frame !== lastFrame) {
        renderSceneTexture(tQuantized)
        needsScene = false
        needsDisplay = false
        lastFrame = frame
        renderDisplayFrame(tQuantized)
      } else if (needsDisplay) {
        needsDisplay = false
        renderDisplayFrame(tQuantized)
      }

      if (!prefersReducedMotion.matches) {
        scheduleRender()
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

    // Force a full allocation on mount. Under React StrictMode the effect
    // runs twice; the second run gets fresh GL objects but the canvas still
    // carries the first run's dimensions, so without this reset resize()
    // would early-return and never attach the scene texture to the new
    // framebuffer (incomplete framebuffer -> black screen until a real
    // resize event fixes it).
    canvas.width = 0
    canvas.height = 0
    resize()
    scheduleRender()

    return () => {
      running = false
      if (rafId !== 0) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      prefersReducedMotion.removeEventListener('change', onReducedMotionChange)
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
      }}
    />
  )
}
