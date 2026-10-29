'use strict';

// 背景(Canvas): 中心のユーザーに向かう奥行きのある線。ごく一部の線だけが、ゆっくり淡く光る。
// マップの表示位置は main.js の window.urlMapView() から受け取り、パンやズームで視差がつく。
(() => {
  const cv = document.getElementById('bg');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (a, b) => a + Math.random() * (b - a);
  let dpr = 1;

  const rails = [];
  const layers = [];
  const rings = [];
  for (let i = 0; i < 110; i++) {
    const horiz = Math.random() < 0.7;
    const th = horiz ? (Math.random() < 0.5 ? 0 : Math.PI) + rnd(-0.6, 0.6) : rnd(0, Math.PI * 2);
    rails.push({ th, r1: rnd(70, 130), a: rnd(0.08, 0.26), w: rnd(0.5, 1.1), gl: i < 8, per: rnd(16, 30), ph: Math.random() });
  }
  for (let i = 0; i < 16; i++) layers.push({ y: rnd(-700, 700), z: rnd(1.4, 5), a: rnd(0.06, 0.17), d: rnd(3, 9), g: rnd(4, 14), s: rnd(25, 70) });
  for (let i = 0; i < 46; i++) rings.push({ x: rnd(-1100, 1100), y: rnd(-800, 800), z: rnd(1.5, 5.5), r: rnd(3, 9), dx: rnd(-4, 4) });

  const getView = () => (window.urlMapView && window.urlMapView()) || { cx: 0, cy: 0, k: 1 };

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    render(0);
  }

  function render(t) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const view = getView();
    const k = view.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const vx = w / 2 - view.cx * k;
    const vy = h / 2 - view.cy * k;
    const far = Math.hypot(w, h) * 1.3;

    // 奥行きの違う横の流れ線
    ctx.lineWidth = 1;
    for (const l of layers) {
      const sy = h / 2 + (l.y - view.cy) * k / l.z;
      if (sy < -5 || sy > h + 5) continue;
      ctx.strokeStyle = `rgba(160,230,255,${l.a})`;
      ctx.setLineDash([l.d * 6 / l.z, l.g * 6 / l.z]);
      ctx.lineDashOffset = -t * l.s / l.z;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ユーザー(中心)に向かう線。ごく一部は、短い時間だけ線そのものが淡く明るくなる
    for (const r of rails) {
      const c = Math.cos(r.th);
      const s = Math.sin(r.th);
      const x1 = vx + c * r.r1;
      const y1 = vy + s * r.r1;
      const x2 = vx + c * far;
      const y2 = vy + s * far;
      let gl = 0;
      if (r.gl && !reduce) {
        const sv = Math.sin(Math.PI * 2 * (t / r.per + r.ph));
        gl = sv > 0 ? Math.pow(sv, 8) : 0;
      }
      const grad = (m) => {
        const g = ctx.createLinearGradient(x1, y1, x2, y2);
        g.addColorStop(0, 'rgba(170,235,255,0)');
        g.addColorStop(0.2, `rgba(170,235,255,${r.a * m})`);
        g.addColorStop(1, `rgba(170,235,255,${r.a * m * 0.45})`);
        return g;
      };
      if (gl > 0.02) {
        ctx.strokeStyle = grad(1.1 * gl);
        ctx.lineWidth = r.w * 5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.strokeStyle = grad(1 + gl * 0.9);
      ctx.lineWidth = r.w;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // 遠近で大きさと明るさの違う小さなリング
    const m1 = w + 160;
    const m2 = h + 160;
    for (const q of rings) {
      const px = (q.x - view.cx) * k / q.z + q.dx * t + w / 2;
      const py = (q.y - view.cy) * k / q.z + h / 2;
      const sx = (((px + 80) % m1) + m1) % m1 - 80;
      const sy = (((py + 80) % m2) + m2) % m2 - 80;
      const a = 0.55 / Math.pow(q.z, 0.7);
      const rr = q.r * 1.6 / q.z + 2;
      ctx.strokeStyle = `rgba(228,248,255,${a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, 6.283);
      ctx.stroke();
      ctx.strokeStyle = `rgba(228,248,255,${a * 0.5})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(sx, sy, rr * 1.7, 0, 6.283);
      ctx.stroke();
      ctx.fillStyle = `rgba(228,248,255,${a})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.4, 0, 6.283);
      ctx.fill();
    }
  }

  const loop = (ts) => { render(ts / 1000); requestAnimationFrame(loop); };
  window.addEventListener('resize', size);
  window.addEventListener('urlmap:view', () => { if (reduce) render(0); });
  size();
  if (!reduce) requestAnimationFrame(loop);
})();
