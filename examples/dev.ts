/**
 * Development server: a dark-mode page counter with a circle-fairy canvas, wired
 * to a live Navi engine so the numbers on screen come from real requests.
 *
 *   bun run dev
 *
 * Serves the page at `/` and hands `/_navi/*` to the engine, then opens a
 * Chrome tab. Browser launch is best-effort: on a headless box it silently does
 * nothing and the URL is printed either way.
 */

import { spawn } from "node:child_process";
import { NaviServerless } from "../src/index.ts";
import { createBunFetch } from "../src/adapters.ts";

let pageViews = 1042;
let totalInteractions = 358;

const app = new NaviServerless()
  .registerAction({
    name: "getStats",
    // Public + cached: this is the action that shows off the tiers. Reload the
    // page and this answers from L1 for `ttl` seconds, then serves stale while
    // one refresh runs behind it.
    cache: { ttl: 2, swr: 5, scope: "public" },
    handler: () => ({
      views: pageViews,
      interactions: totalInteractions,
      serverTime: new Date().toISOString(),
    }),
  })
  .registerAction({
    // Mutations are never cached. A cached write would hand the same count to
    // every caller and quietly corrupt the demo.
    name: "recordVisit",
    handler: () => {
      pageViews++;
      return { views: pageViews, interactions: totalInteractions };
    },
  })
  .registerAction({
    name: "increment",
    handler: (_ctx, input: { amount?: number } | undefined) => {
      const step = typeof input?.amount === "number" && Number.isFinite(input.amount) ? input.amount : 1;
      totalInteractions += step;
      pageViews += step;
      return { views: pageViews, interactions: totalInteractions };
    },
  })
  .registerAction({
    name: "reset",
    handler: () => {
      pageViews = 0;
      totalInteractions = 0;
      return { views: 0, interactions: 0 };
    },
  });

const bunFetch = createBunFetch(app);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Navi • Fairy Page Counter</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(13, 17, 26, 0.72);
      --card-border: rgba(120, 119, 198, 0.16);
      --text: #f0f4fc;
      --text-muted: #828ba2;
      --primary: #8b5cf6;
      --primary-glow: #a78bfa;
      --cyan: #38bdf8;
      --cyan-glow: #7dd3fc;
      --emerald: #34d399;
      --pink: #f472b6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      background-color: var(--bg);
      background-image:
        radial-gradient(ellipse at 50% 10%, rgba(139, 92, 246, 0.15), transparent 50%),
        radial-gradient(ellipse at 80% 80%, rgba(56, 189, 248, 0.1), transparent 45%),
        radial-gradient(ellipse at 20% 70%, rgba(244, 114, 182, 0.08), transparent 45%);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow-x: hidden;
      position: relative;
    }

    #fairy-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
    }

    .container {
      position: relative;
      z-index: 10;
      width: 100%;
      max-width: 580px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
    }

    .fairy-orb-wrapper {
      position: relative;
      width: 170px;
      height: 170px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    .fairy-pulse-ring {
      position: absolute;
      border-radius: 50%;
      border: 1px solid rgba(139, 92, 246, 0.35);
      width: 100%;
      height: 100%;
      animation: pulseOrbit 4s ease-in-out infinite;
      box-shadow: 0 0 45px rgba(139, 92, 246, 0.25), inset 0 0 30px rgba(56, 189, 248, 0.2);
    }

    .fairy-pulse-ring:nth-of-type(2) {
      width: 80%;
      height: 80%;
      border-color: rgba(56, 189, 248, 0.4);
      animation: pulseOrbit 3s ease-in-out infinite reverse;
    }

    .fairy-core {
      position: relative;
      width: 54px;
      height: 54px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #ffffff 0%, #c4b5fd 40%, #8b5cf6 80%, #6366f1 100%);
      box-shadow:
        0 0 25px #ffffff,
        0 0 50px rgba(167, 139, 250, 0.8),
        0 0 80px rgba(56, 189, 248, 0.6);
      transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
      z-index: 2;
    }

    .fairy-orb-wrapper:hover .fairy-core {
      transform: scale(1.15);
    }

    .fairy-orb-wrapper:active .fairy-core {
      transform: scale(0.92);
    }

    .wing {
      position: absolute;
      top: 50%;
      width: 38px;
      height: 60px;
      border-radius: 50% 50% 10% 50% / 60% 60% 30% 40%;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.75), rgba(167, 139, 250, 0.35) 45%, rgba(56, 189, 248, 0.1) 100%);
      filter: blur(0.5px);
      box-shadow: 0 0 15px rgba(167, 139, 250, 0.6);
      transform-origin: bottom center;
      pointer-events: none;
      z-index: 2;
    }

    .wing.left {
      left: 14px;
      animation: flapLeft 0.22s ease-in-out infinite alternate;
    }

    .wing.right {
      right: 14px;
      animation: flapRight 0.22s ease-in-out infinite alternate;
    }

    @keyframes flapLeft {
      0% { transform: translateY(-80%) rotate(-45deg) scaleX(0.75); }
      100% { transform: translateY(-80%) rotate(-15deg) scaleX(1.15); }
    }

    @keyframes flapRight {
      0% { transform: translateY(-80%) rotate(45deg) scaleX(-0.75); }
      100% { transform: translateY(-80%) rotate(15deg) scaleX(-1.15); }
    }

    @keyframes pulseOrbit {
      0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.6; }
      50% { transform: scale(1.12) rotate(180deg); opacity: 1; }
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      background: rgba(139, 92, 246, 0.12);
      border: 1px solid rgba(139, 92, 246, 0.3);
      color: #c4b5fd;
      text-transform: uppercase;
    }

    .badge-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 8px var(--emerald);
      animation: blink 2s infinite ease-in-out;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .card {
      width: 100%;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 28px;
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      padding: 36px 32px;
      box-shadow:
        0 24px 60px -12px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255, 255, 255, 0.04),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 20%;
      right: 20%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(167, 139, 250, 0.8), transparent);
    }

    .card-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .counter-display {
      font-size: 76px;
      font-weight: 800;
      line-height: 1;
      letter-spacing: -0.04em;
      background: linear-gradient(180deg, #ffffff 30%, #a78bfa 85%, #60a5fa 100%);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      font-variant-numeric: tabular-nums;
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 4px;
      transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .counter-display.pop {
      transform: scale(1.08);
    }

    .stats-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      width: 100%;
      gap: 12px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 18px;
    }

    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
    }

    .stat-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 15px;
      font-weight: 600;
      color: #e2e8f0;
    }

    .button-group {
      display: flex;
      width: 100%;
      gap: 10px;
    }

    button {
      flex: 1;
      padding: 14px 20px;
      border-radius: 14px;
      border: none;
      font-family: inherit;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .btn-sparkle {
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      color: #ffffff;
      box-shadow: 0 4px 20px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2);
    }

    .btn-sparkle:hover {
      background: linear-gradient(135deg, #9d75f8, #7174f8);
      transform: translateY(-2px);
      box-shadow: 0 6px 26px rgba(139, 92, 246, 0.6);
    }

    .btn-sparkle:active { transform: translateY(1px); }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-2px);
    }

    .btn-secondary:active { transform: translateY(1px); }

    .meta-footer {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 16px;
      background: rgba(13, 17, 26, 0.5);
      padding: 10px 18px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .meta-val {
      color: var(--cyan);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <canvas id="fairy-canvas"></canvas>

  <div class="container">
    <div class="badge">
      <div class="badge-dot"></div>
      Navi Serverless Active
    </div>

    <div class="fairy-orb-wrapper" id="fairy" title="Click the fairy to flutter sparkles!">
      <div class="fairy-pulse-ring"></div>
      <div class="fairy-pulse-ring"></div>
      <div class="wing left"></div>
      <div class="wing right"></div>
      <div class="fairy-core"></div>
    </div>

    <div class="card">
      <div class="card-title">Live Page Counter</div>
      <div class="counter-display" id="count">0</div>

      <div class="stats-row">
        <div class="stat-item">
          <span class="stat-label">Total Touches</span>
          <span class="stat-value" id="interactions">0</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Cache Level</span>
          <span class="stat-value" style="color: var(--emerald);" id="cache-tier">—</span>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-sparkle" id="btn-inc">Flutter (+1)</button>
        <button class="btn-secondary" id="btn-burst">Stardust (+5)</button>
        <button class="btn-secondary" style="max-width: 90px;" id="btn-reset" title="Reset Counter">Reset</button>
      </div>
    </div>

    <div class="meta-footer">
      <div class="meta-item">
        <span>Avoided:</span>
        <span class="meta-val" id="avoided-val">0</span>
      </div>
      <div class="meta-item">
        <span>Latency:</span>
        <span class="meta-val" id="latency-val">—</span>
      </div>
      <div class="meta-item">
        <span>Cohesion:</span>
        <span class="meta-val" id="engine-tier">LIVE</span>
      </div>
    </div>
  </div>

  <script>
    const canvas = document.getElementById('fairy-canvas');
    const ctx = canvas.getContext('2d');
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    window.addEventListener('resize', () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    });

    const fairyEl = document.getElementById('fairy');
    const fairyPos = { x: width / 2, y: height / 2 - 130 };

    function updateFairyCenter() {
      const rect = fairyEl.getBoundingClientRect();
      fairyPos.x = rect.left + rect.width / 2;
      fairyPos.y = rect.top + rect.height / 2;
    }

    window.addEventListener('scroll', updateFairyCenter, { passive: true });
    window.addEventListener('resize', updateFairyCenter);
    requestAnimationFrame(updateFairyCenter);

    const particles = [];
    const NUM_ORBIT_PARTICLES = 36;

    class FairyParticle {
      constructor() {
        this.reset();
      }

      reset() {
        this.radiusX = 40 + Math.random() * 80;
        this.radiusY = 20 + Math.random() * 50;
        this.angle = Math.random() * Math.PI * 2;
        this.speed = (0.015 + Math.random() * 0.035) * (Math.random() > 0.5 ? 1 : -1);
        this.tilt = (Math.random() - 0.5) * 0.8;
        this.size = 1 + Math.random() * 2.8;
        this.alpha = 0.2 + Math.random() * 0.8;
        this.hue = Math.random() > 0.6 ? 265 : Math.random() > 0.3 ? 195 : 320;
      }

      update() {
        this.angle += this.speed;
      }

      draw() {
        const cos = Math.cos(this.angle);
        const sin = Math.sin(this.angle);
        const x = fairyPos.x + this.radiusX * cos;
        const y = fairyPos.y + (this.radiusY * sin * Math.cos(this.tilt) - this.radiusX * cos * Math.sin(this.tilt));

        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(' + this.hue + ', 90%, 75%, ' + this.alpha + ')';
        ctx.shadowColor = 'hsla(' + this.hue + ', 90%, 65%, 0.8)';
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.restore();
      }
    }

    for (let i = 0; i < NUM_ORBIT_PARTICLES; i++) {
      particles.push(new FairyParticle());
    }

    const bursts = [];
    function spawnBurst(x, y, count) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.5 + Math.random() * 6;
        bursts.push({
          x: x,
          y: y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 0.5,
          size: 1.5 + Math.random() * 3,
          alpha: 1,
          decay: 0.015 + Math.random() * 0.03,
          hue: 250 + Math.random() * 80,
        });
      }
    }

    function animate() {
      ctx.clearRect(0, 0, width, height);

      for (const p of particles) {
        p.update();
        p.draw();
      }

      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.x += b.vx;
        b.y += b.vy;
        b.vy += 0.05;
        b.alpha -= b.decay;

        if (b.alpha <= 0) {
          bursts.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(' + b.hue + ', 95%, 75%, ' + b.alpha + ')';
        ctx.shadowColor = 'hsla(' + b.hue + ', 100%, 70%, ' + b.alpha + ')';
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.restore();
      }

      requestAnimationFrame(animate);
    }
    animate();

    const countEl = document.getElementById('count');
    const interactionsEl = document.getElementById('interactions');
    const cacheTierEl = document.getElementById('cache-tier');
    const avoidedEl = document.getElementById('avoided-val');
    const latencyEl = document.getElementById('latency-val');
    const engineTierEl = document.getElementById('engine-tier');

    let avoidedCount = 0;

    // Only the cached probe reports a tier. Letting an uncached write overwrite
    // the labels pinned the display at NONE forever, which read as "caching is
    // broken" on a page whose whole point is caching.
    async function callAction(action, payload, reportTier) {
      const start = performance.now();
      try {
        const res = await fetch('/_navi/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action, payload: payload }),
        });
        latencyEl.textContent = Math.max(1, Math.round(performance.now() - start)) + 'ms';

        const json = await res.json();
        if (json._meta && reportTier) {
          if (json._meta.avoidedInvocation) {
            avoidedCount++;
            avoidedEl.textContent = String(avoidedCount);
          }
          if (json._meta.cacheHit) {
            cacheTierEl.textContent = json._meta.cacheHit;
            engineTierEl.textContent = json._meta.cacheHit;
          }
        }
        if (json.ok && json.data) return json.data;
      } catch (err) {
        console.error(err);
      }
      return null;
    }

    function bumpDisplay(views, interactions) {
      countEl.textContent = Number(views).toLocaleString();
      interactionsEl.textContent = Number(interactions).toLocaleString();
      countEl.classList.remove('pop');
      void countEl.offsetWidth;
      countEl.classList.add('pop');
    }

    (async () => {
      // Ask for the cached view first, purely to show a real tier in the
      // footer. It is deliberately NOT used for the displayed number: getStats
      // is cached with a 2s TTL and a 5s stale window, so right after a write
      // it can legitimately be behind recordVisit, and letting it paint the
      // counter would make the number jump backwards on every reload.
      await callAction('getStats', undefined, true);

      // The authoritative count comes from the uncached write.
      const data = await callAction('recordVisit', undefined, false);
      if (data) {
        bumpDisplay(data.views, data.interactions);
        spawnBurst(fairyPos.x, fairyPos.y, 20);
      }
    })();

    async function triggerIncrement(amount) {
      spawnBurst(fairyPos.x, fairyPos.y, amount > 1 ? 40 : 25);
      const data = await callAction('increment', { amount: amount }, false);
      if (data) bumpDisplay(data.views, data.interactions);
      // Re-probe the cached view so the footer shows a live tier, not a
      // snapshot from page load.
      await callAction('getStats', undefined, true);
    }

    document.getElementById('btn-inc').addEventListener('click', function () { triggerIncrement(1); });
    document.getElementById('btn-burst').addEventListener('click', function () { triggerIncrement(5); });
    document.getElementById('fairy').addEventListener('click', function () { triggerIncrement(1); });

    document.getElementById('btn-reset').addEventListener('click', async function () {
      spawnBurst(fairyPos.x, fairyPos.y, 35);
      const data = await callAction('reset', undefined, false);
      if (data) bumpDisplay(data.views, data.interactions);
      await callAction('getStats', undefined, true);
    });
  </script>
</body>
</html>`;

/**
 * Open a URL in Chrome, falling back to the system default handler.
 *
 * Every step is best-effort: a headless box has no Chrome and no display, and
 * that must never take the dev server down with it.
 */
function openChrome(url: string): void {
  const attempt = (command: string, args: string[], next?: () => void): void => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => {
        next?.();
      });
      child.unref();
    } catch {
      next?.();
    }
  };

  switch (process.platform) {
    case "darwin":
      attempt("open", ["-a", "Google Chrome", url], () => attempt("open", [url]));
      break;
    case "win32":
      attempt("cmd", ["/c", "start", "chrome", url], () => attempt("cmd", ["/c", "start", url]));
      break;
    default:
      attempt("xdg-open", [url], () =>
        attempt("google-chrome", [url], () => attempt("google-chrome-stable", [url])),
      );
      break;
  }
}

const port = Number(process.env["PORT"] ?? 3000);
const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/_navi")) return bunFetch(request);
    return new Response("Not found", { status: 404 });
  },
});

const url = `http://localhost:${server.port}`;
console.log(`\n\x1b[36m⚡ Navi Serverless dev server:\x1b[0m \x1b[1m${url}\x1b[0m`);

// Never pop a browser open in CI or on a headless box; the URL is printed
// either way. Override with NAVI_DEV_OPEN=1 to force it.
const shouldOpen =
  process.env["NAVI_DEV_OPEN"] === "1" ||
  (process.env["CI"] === undefined && process.env["NAVI_DEV_OPEN"] !== "0");

if (shouldOpen) {
  console.log(`\x1b[35m✨ Launching Chrome…\x1b[0m\n`);
  openChrome(url);
} else {
  console.log(`\x1b[2m   (browser launch skipped — set NAVI_DEV_OPEN=1 to force it)\x1b[0m\n`);
}
