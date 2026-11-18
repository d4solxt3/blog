/**
 * loop.exe's visualiser, drawn on a small canvas in the player's screen:
 *  - a spectrum of 2px pixel cells, ordered-dithered (4×4 Bayer) so each bar is
 *    solid at the base and breaks into 1-bit noise towards its tip, like the
 *    banner's dither-horizon sky
 *  - the bars stand on a horizon line and reflect beneath it, sparser
 *  - falling peak ticks and a pixel oscilloscope trace in the scope colour
 *  - idle: a flat horizon with a "NO SIGNAL" tag
 * Real audio data (Web Audio AnalyserNode), started on the first play (a click,
 * so browsers allow it). Reduced motion: a single still frame, no animation.
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const CELL = 2; // css px per pixel cell
const STEP = 3; // cells per column (2 bar + 1 gap)

export function createVisualiser(canvas: HTMLCanvasElement, audio: HTMLAudioElement, hzEl: HTMLElement | null, signal: AbortSignal) {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return { start() {}, stop() {}, setVolume: (v: number) => void (audio.volume = v) };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let ac: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let gain: GainNode | null = null;
  let volume = audio.volume;
  let freq = new Uint8Array(0);
  let wave = new Uint8Array(0);
  let levels: number[] = [];
  let peaks: number[] = [];
  let raf = 0;
  let last = 0;
  let running = false;
  let dpr = 1;
  let cols = 0;
  let rows = 0;

  const colours = () => {
    const cs = getComputedStyle(canvas);
    return { bar: cs.getPropertyValue('--vz-bar').trim() || '#fff', dim: cs.getPropertyValue('--vz-dim').trim() || 'rgba(255,255,255,.35)', scope: cs.getPropertyValue('--vz-scope').trim() || '#fff' };
  };

  function size() {
    dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const w = Math.max(40, Math.floor(canvas.clientWidth));
    const h = Math.max(20, Math.floor(canvas.clientHeight));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    cols = Math.floor(w / (CELL * STEP));
    rows = Math.floor(h / CELL);
    levels = Array.from({ length: cols }, (_, i) => levels[i] ?? 0);
    peaks = Array.from({ length: cols }, (_, i) => peaks[i] ?? 0);
  }

  function ensureAudio() {
    if (ac || !('AudioContext' in window)) return;
    try {
      ac = new AudioContext();
      const src = ac.createMediaElementSource(audio);
      analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      // A wide loudness window so mastered (loud) tracks still move instead of pinning.
      analyser.minDecibels = -92;
      analyser.maxDecibels = -8;
      // Volume lives after the analyser, so the picture doesn't shrink when it's turned down.
      gain = ac.createGain();
      gain.gain.value = volume;
      audio.volume = 1;
      src.connect(analyser);
      analyser.connect(gain);
      gain.connect(ac.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
      wave = new Uint8Array(analyser.fftSize);
    } catch {
      ac = null;
      analyser = null;
    }
  }

  /** Spread the bins over the columns on a log scale (more room for the lows). */
  function sample() {
    if (!analyser || !ac) return;
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(wave);
    const n = freq.length;
    const lo = Math.log(2);
    const hi = Math.log(n * 0.72);
    let loudest = 0;
    let loudBin = 0;
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(Math.exp(lo + ((hi - lo) * c) / cols));
      const b = Math.max(a + 1, Math.floor(Math.exp(lo + ((hi - lo) * (c + 1)) / cols)));
      let sum = 0;
      for (let k = a; k < b; k++) {
        sum += freq[k];
        if (freq[k] > loudest) ((loudest = freq[k]), (loudBin = k));
      }
      const v = Math.pow(sum / (b - a) / 255, 1.8);
      levels[c] = Math.max(v, levels[c] * 0.86);
      peaks[c] = Math.max(levels[c], peaks[c] - 0.018);
    }
    if (hzEl) hzEl.textContent = loudest > 24 ? `${Math.round((loudBin * ac.sampleRate) / analyser.fftSize)} hz` : '-- hz';
  }

  function decay() {
    let any = false;
    for (let c = 0; c < cols; c++) {
      levels[c] *= 0.8;
      peaks[c] = Math.max(0, peaks[c] - 0.03);
      if (levels[c] > 0.01 || peaks[c] > 0.01) any = true;
    }
    if (hzEl) hzEl.textContent = '-- hz';
    return any;
  }

  function draw(idle: boolean) {
    const g = ctx2d!;
    const { bar, dim, scope } = colours();
    const px = CELL * dpr;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const horizon = Math.round(rows * 0.68); // in cells
    const upRows = horizon - 1;
    const downRows = rows - horizon - 1;

    // Bars: dense at the base, dithering out towards the tip.
    g.fillStyle = bar;
    for (let c = 0; c < cols; c++) {
      const h = Math.round(levels[c] * upRows);
      for (let r = 0; r < h; r++) {
        const t = r / Math.max(1, upRows);
        const density = r === h - 1 ? 1 : 1 - t * 0.85;
        for (let k = 0; k < STEP - 1; k++) {
          const x = c * STEP + k;
          const y = horizon - 1 - r;
          if (BAYER[(y % 4) * 4 + (x % 4)] < density) g.fillRect(x * px, y * px, px, px);
        }
      }
    }
    // Reflection beneath the horizon: a sparse, shorter echo.
    g.fillStyle = dim;
    for (let c = 0; c < cols; c++) {
      const h = Math.round(levels[c] * downRows * 0.9);
      for (let r = 0; r < h; r++) {
        const density = 0.55 - (r / Math.max(1, downRows)) * 0.45;
        for (let k = 0; k < STEP - 1; k++) {
          const x = c * STEP + k;
          const y = horizon + 1 + r;
          if (BAYER[(y % 4) * 4 + (x % 4)] < density) g.fillRect(x * px, y * px, px, px);
        }
      }
    }
    // Horizon: a dotted line, like the banner's.
    g.fillStyle = dim;
    for (let x = 0; x < cols * STEP; x += 2) g.fillRect(x * px, horizon * px, px, px);

    // Peak ticks.
    g.fillStyle = scope;
    for (let c = 0; c < cols; c++) {
      if (peaks[c] < 0.04) continue;
      const y = horizon - 1 - Math.round(peaks[c] * upRows);
      g.fillRect(c * STEP * px, Math.max(0, y) * px, (STEP - 1) * px, Math.max(1, dpr));
    }

    // Oscilloscope trace across the top half, one pixel cell per column step.
    if (!idle && wave.length) {
      g.fillStyle = scope;
      g.globalAlpha = 0.85;
      const mid = Math.round(upRows * 0.45);
      const amp = upRows * 0.42;
      const total = cols * STEP;
      for (let x = 0; x < total; x++) {
        const v = (wave[Math.floor((x / total) * wave.length)] - 128) / 128;
        g.fillRect(x * px, Math.round(mid - v * amp) * px, px, Math.max(1, dpr));
      }
      g.globalAlpha = 1;
    }

    if (idle) {
      g.fillStyle = dim;
      g.font = `${8 * dpr}px ui-monospace, monospace`;
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillText('NO SIGNAL', canvas.width - 2 * dpr, 2 * dpr);
    }
  }

  function frame(now: number) {
    raf = 0;
    if (now - last < 33) {
      raf = requestAnimationFrame(frame);
      return;
    }
    last = now;
    if (running) {
      sample();
      draw(false);
      raf = requestAnimationFrame(frame);
    } else if (decay()) {
      draw(false);
      raf = requestAnimationFrame(frame);
    } else draw(true);
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  size();
  draw(true);
  const ro = new ResizeObserver(() => {
    size();
    draw(!running);
  });
  ro.observe(canvas);
  // Theme switch: repaint in the new inks.
  const mo = new MutationObserver(() => draw(!running));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  signal.addEventListener('abort', () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    mo.disconnect();
    void ac?.close().catch(() => {});
  });

  return {
    /** 0–1; goes to the gain node once audio is routed through Web Audio. */
    setVolume(v: number) {
      volume = v;
      if (gain) gain.gain.value = v;
      else audio.volume = v;
    },
    start() {
      ensureAudio();
      void ac?.resume().catch(() => {});
      running = true;
      if (reduced.matches) {
        // One still frame of the music, no animation.
        setTimeout(() => {
          sample();
          draw(false);
        }, 250);
        return;
      }
      kick();
    },
    stop() {
      running = false;
      if (reduced.matches) return draw(true);
      kick();
    },
  };
}
