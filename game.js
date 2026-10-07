(() => {
  'use strict';

  const W = 360;
  const H = 640;
  const STEP = H * 0.023;
  const PLAYER_R = 11;
  const ONI = { x: W / 2, y: 72, r: 21 };
  const START = { x: W / 2, y: 586 };
  const GOAL_TOUCH = ONI.r + PLAYER_R + 3;
  const STORAGE = {
    best: 'otg003_best_time',
    closest: 'otg003_closest_meters'
  };

  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const gameShell = document.getElementById('gameShell');
  const muteButton = document.getElementById('muteButton');
  const timeLabel = document.getElementById('timeLabel');
  const speechBubble = document.getElementById('speechBubble');
  const warningMark = document.getElementById('warningMark');
  const countdownEl = document.getElementById('countdown');
  const titleScreen = document.getElementById('titleScreen');
  const resultScreen = document.getElementById('resultScreen');
  const startButton = document.getElementById('startButton');
  const retryButton = document.getElementById('retryButton');
  const resultTitle = document.getElementById('resultTitle');
  const resultEyebrow = document.getElementById('resultEyebrow');
  const resultDetails = document.getElementById('resultDetails');

  let muted = true;
  let audioCtx = null;
  let gameState = 'title'; // title | countdown | playing | result
  let oniState = 'back'; // back | warning | look | feint
  let phaseStart = 0;
  let phaseDuration = 0;
  let backTotalDuration = 0;
  let warningStarted = false;
  let currentFeint = false;
  let lastWasFeint = false;
  let firstCycle = true;
  let obstacles = [];
  let player = { x: START.x, y: START.y };
  let safeNow = false;
  let discovery = 0;
  let discoveryDuration = 1.0;
  let gameStartTime = 0;
  let finalTime = 0;
  let tapFlash = [];
  let particles = [];
  let shakeUntil = 0;
  let raf = 0;
  let lastFrame = performance.now();
  let bestTime = readNumber(STORAGE.best);
  let closestMeters = readNumber(STORAGE.closest);
  let testMode = false;

  function readNumber(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function rand(min, max) { return min + Math.random() * (max - min); }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  function setMuted(next) {
    muted = next;
    muteButton.textContent = muted ? '🔇' : '🔊';
    muteButton.setAttribute('aria-label', muted ? 'ミュート解除' : 'ミュートする');
    if (!muted) ensureAudio();
  }

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  function tone(freq, duration = 0.05, type = 'sine', gain = 0.035, when = 0) {
    if (muted) return;
    ensureAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime + when;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  const sfx = {
    tap() { tone(320, 0.035, 'sine', 0.025); },
    start() { tone(440, .07, 'triangle', .045); tone(660, .09, 'triangle', .04, .08); },
    warn() { tone(880, .07, 'square', .025); tone(690, .07, 'square', .022, .09); },
    danger() { tone(760, .04, 'sine', .018); },
    fail() { tone(220, .18, 'sawtooth', .04); tone(130, .26, 'sawtooth', .035, .11); },
    success() { tone(523, .08, 'triangle', .04); tone(659, .08, 'triangle', .04, .09); tone(784, .16, 'triangle', .045, .18); }
  };

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function makeShadowPolygon(ob) {
    const ox = ONI.x, oy = ONI.y;
    const cx = ob.x, cy = ob.y, r = ob.r;
    const dx = cx - ox, dy = cy - oy;
    const d = Math.hypot(dx, dy);
    if (d <= r + 2) return [];
    const base = Math.atan2(dy, dx);
    const alpha = Math.asin(clamp(r / d, -0.98, 0.98));
    const a1 = base - alpha;
    const a2 = base + alpha;
    const tangentDist = Math.sqrt(d * d - r * r);
    const t1 = { x: ox + Math.cos(a1) * tangentDist, y: oy + Math.sin(a1) * tangentDist };
    const t2 = { x: ox + Math.cos(a2) * tangentDist, y: oy + Math.sin(a2) * tangentDist };
    const extendToBottom = (a) => {
      const sy = Math.sin(a);
      if (sy <= 0.03) return { x: ox, y: oy };
      const k = (H + 30 - oy) / sy;
      return { x: ox + Math.cos(a) * k, y: H + 30 };
    };
    const f1 = extendToBottom(a1);
    const f2 = extendToBottom(a2);
    return [t1, t2, f2, f1];
  }

  function isSafeAt(x, y) {
    return obstacles.some(ob => pointInPolygon(x, y, ob.shadow));
  }

  function collidesAt(x, y, obs = obstacles) {
    return obs.some(ob => dist(x, y, ob.x, ob.y) < PLAYER_R + ob.r + 1.2);
  }

  function resolveMove(pos, vx, vy, obs = obstacles) {
    const original = { x: pos.x, y: pos.y };
    let nx = clamp(pos.x + vx, PLAYER_R + 5, W - PLAYER_R - 5);
    let ny = clamp(pos.y + vy, 105, START.y + 4);
    if (!collidesAt(nx, ny, obs)) return { x: nx, y: ny };

    const hit = obs.find(ob => dist(nx, ny, ob.x, ob.y) < PLAYER_R + ob.r + 1.2);
    if (!hit) return original;

    let rx = original.x - hit.x;
    let ry = original.y - hit.y;
    let rl = Math.hypot(rx, ry);
    if (rl < 0.001) { rx = 1; ry = 0; rl = 1; }
    const n = { x: rx / rl, y: ry / rl };
    const dot = vx * n.x + vy * n.y;
    let sx = vx, sy = vy;
    if (dot < 0) {
      sx = vx - n.x * dot;
      sy = vy - n.y * dot;
    }

    if (Math.hypot(sx, sy) < STEP * 0.18) {
      const side = Math.abs(original.x - hit.x) < 1 ? (vx <= 0 ? -1 : 1) : Math.sign(original.x - hit.x);
      sx = side * STEP * 0.52;
      sy = Math.min(-STEP * 0.16, vy * 0.16);
    }

    sy = Math.min(0, sy);
    const sl = Math.hypot(sx, sy);
    if (sl > STEP) { sx *= STEP / sl; sy *= STEP / sl; }
    nx = clamp(original.x + sx, PLAYER_R + 5, W - PLAYER_R - 5);
    ny = clamp(original.y + sy, 105, START.y + 4);

    if (collidesAt(nx, ny, obs)) {
      const side = Math.sign(original.x - hit.x) || (vx < 0 ? -1 : 1);
      for (const factor of [0.46, 0.34, 0.22]) {
        const tx = clamp(original.x + side * STEP * factor, PLAYER_R + 5, W - PLAYER_R - 5);
        const ty = clamp(original.y - STEP * factor * 0.24, 105, START.y + 4);
        if (!collidesAt(tx, ty, obs)) return { x: tx, y: ty };
      }
      return original;
    }
    return { x: nx, y: ny };
  }

  function progressFor(y = player.y) {
    return clamp((START.y - y) / (START.y - (ONI.y + GOAL_TOUCH)), 0, 1);
  }

  function remainingMetersAt(x = player.x, y = player.y) {
    const raw = Math.max(0, dist(x, y, ONI.x, ONI.y) - GOAL_TOUCH);
    const total = dist(START.x, START.y, ONI.x, ONI.y) - GOAL_TOUCH;
    return clamp((raw / total) * 10, 0, 10);
  }

  function obstacleCandidate(type, x, y, r) {
    const ob = { type, x, y, r, shadow: [] };
    ob.shadow = makeShadowPolygon(ob);
    return ob;
  }

  function generateStage() {
    const types = ['tree', 'rock', 'box'];
    for (let attempt = 0; attempt < 80; attempt++) {
      const count = Math.floor(rand(5, 8));
      const obs = [];
      const bands = [468, 390, 310, 235, 175];
      const firstSide = Math.random() < .5 ? -1 : 1;
      const firstX = W / 2 + firstSide * rand(48, 74);
      obs.push(obstacleCandidate(types[Math.floor(Math.random()*types.length)], firstX, rand(455, 485), rand(21, 25)));

      const requiredBands = Math.min(4, count - 1);
      for (let i = 1; i <= requiredBands; i++) {
        let placed = false;
        for (let tries = 0; tries < 40 && !placed; tries++) {
          const bandY = bands[i] + rand(-18, 18);
          const xBias = (i % 2 === 0 ? -firstSide : firstSide) * rand(18, 55);
          const x = clamp(W/2 + xBias + rand(-65, 65), 42, W - 42);
          const r = rand(19, 27);
          const candidate = obstacleCandidate(types[Math.floor(Math.random()*types.length)], x, bandY, r);
          if (obs.every(o => dist(o.x,o.y,x,bandY) > o.r + r + 28)) {
            obs.push(candidate); placed = true;
          }
        }
      }

      while (obs.length < count) {
        let placed = false;
        for (let tries = 0; tries < 70 && !placed; tries++) {
          const y = rand(165, 500);
          const x = rand(38, W - 38);
          const r = rand(18, 26);
          const candidate = obstacleCandidate(types[Math.floor(Math.random()*types.length)], x, y, r);
          if (dist(x,y,ONI.x,ONI.y) < 90) continue;
          if (obs.every(o => dist(o.x,o.y,x,y) > o.r + r + 27)) {
            obs.push(candidate); placed = true;
          }
        }
        if (!placed) break;
      }

      if (obs.length !== count) continue;
      if (isPointSafeWithObs(START.x, START.y, obs)) continue;
      if (!validateFirstShelter(obs)) continue;
      if (!validateReachability(obs)) continue;
      return obs;
    }
    return fallbackStage();
  }

  function isPointSafeWithObs(x, y, obs) {
    return obs.some(ob => pointInPolygon(x, y, ob.shadow));
  }

  function stateKey(p) { return `${Math.round(p.x / 5)}:${Math.round(p.y / 5)}`; }

  function validateFirstShelter(obs) {
    let states = [{ x: START.x, y: START.y }];
    const dirs = [-1, 0, 1];
    for (let step = 0; step < 14; step++) {
      const next = [];
      const seen = new Set();
      for (const p of states) {
        for (const dir of dirs) {
          const vx = dir * STEP * 0.5;
          const vy = -STEP * (dir === 0 ? 1 : Math.cos(Math.PI / 6));
          const q = resolveMove(p, vx, vy, obs);
          if (isPointSafeWithObs(q.x, q.y, obs)) return true;
          const key = stateKey(q);
          if (!seen.has(key)) { seen.add(key); next.push(q); }
        }
      }
      states = next.slice(0, 1400);
    }
    return false;
  }

  function validateReachability(obs) {
    let states = [{ x: START.x, y: START.y }];
    const dirs = [-1, 0, 1];
    for (let step = 0; step < 58; step++) {
      const next = [];
      const seen = new Set();
      for (const p of states) {
        for (const dir of dirs) {
          const vx = dir * STEP * 0.5;
          const vy = -STEP * (dir === 0 ? 1 : Math.cos(Math.PI / 6));
          const q = resolveMove(p, vx, vy, obs);
          if (dist(q.x, q.y, ONI.x, ONI.y) <= GOAL_TOUCH) return true;
          const key = stateKey(q);
          if (!seen.has(key)) { seen.add(key); next.push(q); }
        }
      }
      states = next.slice(0, 2500);
      if (!states.length) return false;
    }
    return false;
  }

  function fallbackStage() {
    const raw = [
      ['tree', 120, 470, 23],
      ['rock', 236, 400, 23],
      ['box', 110, 330, 22],
      ['tree', 244, 260, 23],
      ['rock', 128, 188, 21],
      ['box', 265, 170, 20]
    ];
    return raw.map(v => obstacleCandidate(v[0], v[1], v[2], v[3]));
  }

  function prepareNewGame() {
    obstacles = generateStage();
    player = { x: START.x, y: START.y };
    safeNow = false;
    discovery = 0;
    firstCycle = true;
    lastWasFeint = false;
    currentFeint = false;
    oniState = 'back';
    warningStarted = false;
    finalTime = 0;
    tapFlash = [];
    particles = [];
    speechBubble.classList.add('hidden');
    warningMark.classList.add('hidden');
    timeLabel.textContent = 'TIME --.--';
  }

  async function beginCountdown() {
    if (gameState === 'countdown') return;
    resultScreen.classList.remove('active');
    titleScreen.classList.remove('active');
    prepareNewGame();
    gameState = 'countdown';
    gameShell.classList.remove('playing');
    countdownEl.classList.remove('hidden');
    for (const label of ['3','2','1','START!']) {
      countdownEl.textContent = label;
      if (label === 'START!') sfx.start(); else tone(420 + (3 - Number(label || 0)) * 80, .05, 'triangle', .03);
      await wait(label === 'START!' ? 520 : 650);
      if (gameState !== 'countdown') return;
    }
    countdownEl.classList.add('hidden');
    startPlaying();
  }

  function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function startPlaying() {
    gameState = 'playing';
    gameShell.classList.add('playing');
    gameStartTime = performance.now();
    startBackCycle(true);
  }

  function startBackCycle(isFirst = false) {
    oniState = 'back';
    discovery = 0;
    warningStarted = false;
    warningMark.classList.add('hidden');
    currentFeint = !isFirst && !lastWasFeint && Math.random() < 0.175;
    if (isFirst) {
      backTotalDuration = rand(5.0, 6.0);
    } else {
      const p = progressFor();
      const center = lerp(4.65, 2.35, p);
      const spread = lerp(.42, .26, p);
      backTotalDuration = clamp(center + rand(-spread, spread), 2.05, 4.95);
    }
    phaseStart = performance.now();
    phaseDuration = backTotalDuration;
    updateSpeech(0);
  }

  function enterWarning() {
    oniState = 'warning';
    warningStarted = true;
    warningMark.classList.remove('hidden');
    speechBubble.textContent = '……！';
    speechBubble.classList.remove('hidden');
    sfx.warn();
  }

  function resolveWarning() {
    warningMark.classList.add('hidden');
    if (currentFeint) {
      oniState = 'feint';
      phaseStart = performance.now();
      phaseDuration = rand(.42, .58);
      speechBubble.textContent = 'だ……？';
      lastWasFeint = true;
    } else {
      oniState = 'look';
      phaseStart = performance.now();
      phaseDuration = rand(1.0, 2.0);
      discoveryDuration = rand(.8, 1.2);
      discovery = 0;
      speechBubble.textContent = 'じーっ';
      lastWasFeint = false;
    }
  }

  function updateSpeech(elapsed) {
    const t = clamp(elapsed / Math.max(.001, backTotalDuration), 0, 1);
    let text;
    if (t < .38) text = 'だーるーまーさんが……';
    else if (t < .72) text = 'ころん……';
    else text = 'だ！';
    speechBubble.textContent = text;
    speechBubble.classList.remove('hidden');
  }

  function tryMove(direction) {
    if (gameState !== 'playing') return;
    if (oniState === 'look') {
      gameOver('move');
      return;
    }
    const vx = direction * STEP * 0.5;
    const vy = -STEP * (direction === 0 ? 1 : Math.cos(Math.PI / 6));
    const before = { x: player.x, y: player.y };
    player = resolveMove(player, vx, vy);
    if (dist(before.x, before.y, player.x, player.y) > .1) {
      sfx.tap();
      tapFlash.push({ x: player.x, y: player.y + 13, born: performance.now() });
    }
    safeNow = isSafeAt(player.x, player.y);
    if (dist(player.x, player.y, ONI.x, ONI.y) <= GOAL_TOUCH) {
      if (oniState === 'look') gameOver('move');
      else clearGame();
    }
  }

  function clearGame() {
    if (gameState !== 'playing') return;
    finalTime = (performance.now() - gameStartTime) / 1000;
    gameState = 'result';
    gameShell.classList.remove('playing');
    speechBubble.classList.add('hidden');
    warningMark.classList.add('hidden');
    discovery = 0;
    let newRecord = bestTime === null || finalTime < bestTime;
    if (newRecord) {
      bestTime = finalTime;
      localStorage.setItem(STORAGE.best, bestTime.toFixed(3));
    }
    resultEyebrow.textContent = newRecord ? 'NEW RECORD!' : '';
    resultTitle.textContent = 'タッチ成功！';
    resultDetails.innerHTML = `TIME ${finalTime.toFixed(2)}<br><span class="best">BEST ${bestTime.toFixed(2)}</span>`;
    resultScreen.classList.add('active');
    spawnConfetti();
    sfx.success();
  }

  function gameOver(reason) {
    if (gameState !== 'playing') return;
    finalTime = (performance.now() - gameStartTime) / 1000;
    gameState = 'result';
    gameShell.classList.remove('playing');
    speechBubble.classList.add('hidden');
    warningMark.classList.add('hidden');
    const meters = remainingMetersAt();
    let closestImproved = closestMeters === null || meters < closestMeters;
    if (closestImproved) {
      closestMeters = meters;
      localStorage.setItem(STORAGE.closest, meters.toFixed(3));
    }
    resultEyebrow.textContent = reason === 'move' ? '動いた！' : '見つかった！';
    resultTitle.textContent = 'みつかった！';
    const bestText = bestTime === null ? 'BEST --.--' : `BEST ${bestTime.toFixed(2)}`;
    const closeText = closestMeters === null ? '' : `<span class="sub">いちばん近い記録：鬼まであと${closestMeters.toFixed(1)}m</span>`;
    resultDetails.innerHTML = `鬼まであと${meters.toFixed(1)}m！<br>${bestText}${closeText}`;
    shakeUntil = performance.now() + 380;
    sfx.fail();
    setTimeout(() => { if (gameState === 'result') resultScreen.classList.add('active'); }, 280);
  }

  function spawnConfetti() {
    const now = performance.now();
    for (let i = 0; i < 50; i++) {
      particles.push({ x: ONI.x + rand(-18,18), y: ONI.y + 28, vx: rand(-2.4,2.4), vy: rand(-4.8,-1.2), g: rand(.08,.15), life: rand(700,1300), born: now, rot: rand(0,6.2), vr: rand(-.2,.2) });
    }
  }

  function update(now, dt) {
    if (gameState === 'playing') {
      const elapsedGame = (now - gameStartTime) / 1000;
      timeLabel.textContent = `TIME ${elapsedGame.toFixed(2)}`;
      safeNow = isSafeAt(player.x, player.y);

      if (oniState === 'back' || oniState === 'warning') {
        const elapsed = (now - phaseStart) / 1000;
        const warningAt = Math.max(0, backTotalDuration - .8);
        if (!warningStarted && elapsed >= warningAt) enterWarning();
        if (oniState === 'back') updateSpeech(elapsed);
        if (elapsed >= backTotalDuration) resolveWarning();
      } else if (oniState === 'look') {
        if (!safeNow) {
          discovery += dt / 1000 / discoveryDuration;
          if (discovery >= 1) {
            discovery = 1;
            gameOver('seen');
          } else if (Math.floor(discovery * 6) !== Math.floor((discovery - dt / 1000 / discoveryDuration) * 6)) {
            sfx.danger();
          }
        } else {
          discovery = 0;
        }
        if (gameState === 'playing' && (now - phaseStart) / 1000 >= phaseDuration) {
          discovery = 0;
          startBackCycle(false);
        }
      } else if (oniState === 'feint') {
        if ((now - phaseStart) / 1000 >= phaseDuration) {
          startBackCycle(false);
        }
      }
    }

    tapFlash = tapFlash.filter(f => now - f.born < 240);
    particles = particles.filter(p => now - p.born < p.life);
    for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.vr; }
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    let shakeX = 0, shakeY = 0;
    if (now < shakeUntil) { shakeX = rand(-3,3); shakeY = rand(-2,2); }
    ctx.save();
    ctx.translate(shakeX, shakeY);

    drawGround();
    for (const ob of obstacles) drawShadow(ob);
    drawGoalPath();
    for (const ob of obstacles) drawObstacle(ob);
    drawOni(now);
    drawPlayer(now);
    drawTapFlashes(now);
    drawParticles(now);
    ctx.restore();
  }

  function drawGround() {
    ctx.fillStyle = '#bfe6a8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    for (let y = 18; y < H; y += 40) {
      for (let x = (Math.floor(y/40)%2)*20 + 10; x < W; x += 42) {
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI*2); ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(255,246,180,.26)';
    ctx.fillRect(0, 0, W, 142);
    ctx.strokeStyle = 'rgba(81,119,74,.16)';
    ctx.setLineDash([4,8]);
    ctx.beginPath(); ctx.moveTo(0, 142); ctx.lineTo(W, 142); ctx.stroke(); ctx.setLineDash([]);
  }

  function drawGoalPath() {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3,9]);
    ctx.beginPath(); ctx.moveTo(W/2, 120); ctx.lineTo(W/2, H - 30); ctx.stroke();
    ctx.restore();
  }

  function drawShadow(ob) {
    if (!ob.shadow.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ob.shadow[0].x, ob.shadow[0].y);
    for (let i=1;i<ob.shadow.length;i++) ctx.lineTo(ob.shadow[i].x, ob.shadow[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74, 195, 111, .14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(46, 150, 82, .28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4,5]);
    ctx.stroke();
    ctx.restore();
  }

  function drawObstacle(ob) {
    ctx.save();
    ctx.translate(ob.x, ob.y);
    ctx.fillStyle = 'rgba(48,76,49,.16)';
    ctx.beginPath(); ctx.ellipse(2, ob.r*.8, ob.r*.95, ob.r*.34, 0, 0, Math.PI*2); ctx.fill();
    if (ob.type === 'tree') {
      ctx.fillStyle = '#8d653c'; ctx.fillRect(-5, 2, 10, ob.r*.95);
      ctx.fillStyle = '#4aa956';
      for (const [x,y,s] of [[0,-8,.86],[-10,0,.68],[10,0,.68],[0,6,.72]]) {
        ctx.beginPath(); ctx.arc(x,y,ob.r*s,0,Math.PI*2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(-8,-12,ob.r*.28,0,Math.PI*2); ctx.fill();
    } else if (ob.type === 'rock') {
      ctx.fillStyle = '#8b9da3';
      ctx.beginPath();
      ctx.moveTo(-ob.r*.88, ob.r*.48); ctx.lineTo(-ob.r*.68,-ob.r*.38); ctx.lineTo(-ob.r*.18,-ob.r*.82); ctx.lineTo(ob.r*.58,-ob.r*.55); ctx.lineTo(ob.r*.90,ob.r*.2); ctx.lineTo(ob.r*.54,ob.r*.72); ctx.lineTo(-ob.r*.42,ob.r*.76); ctx.closePath(); ctx.fill();
      ctx.fillStyle='rgba(255,255,255,.22)'; ctx.beginPath(); ctx.ellipse(-ob.r*.2,-ob.r*.35,ob.r*.34,ob.r*.17,-.2,0,Math.PI*2); ctx.fill();
    } else {
      const s = ob.r*1.58;
      ctx.fillStyle = '#b97a43'; ctx.fillRect(-s/2,-s/2,s,s);
      ctx.strokeStyle='#7e4e2c'; ctx.lineWidth=3; ctx.strokeRect(-s/2,-s/2,s,s);
      ctx.beginPath(); ctx.moveTo(-s/2,-s/2); ctx.lineTo(s/2,s/2); ctx.moveTo(s/2,-s/2); ctx.lineTo(-s/2,s/2); ctx.stroke();
      ctx.fillStyle='rgba(255,255,255,.18)'; ctx.fillRect(-s*.36,-s*.36,s*.24,s*.11);
    }
    ctx.restore();
  }

  function drawOni(now) {
    ctx.save();
    let x = ONI.x, y = ONI.y;
    let rot = 0;
    let front = oniState === 'look';
    if (oniState === 'warning') rot = Math.sin(now * .045) * .08;
    if (oniState === 'feint') rot = .20 + Math.sin(now*.03)*.03;
    ctx.translate(x,y); ctx.rotate(rot);
    ctx.fillStyle='rgba(80,55,45,.16)'; ctx.beginPath(); ctx.ellipse(0,27,28,8,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f66b5b'; ctx.beginPath(); ctx.arc(0,0,21,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f4dc8b';
    ctx.beginPath(); ctx.moveTo(-13,-16); ctx.lineTo(-7,-31); ctx.lineTo(-2,-17); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(13,-16); ctx.lineTo(7,-31); ctx.lineTo(2,-17); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#5d7fc9'; ctx.beginPath(); ctx.roundRect(-15,18,30,23,10); ctx.fill();
    if (front) {
      ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(-7,-2,6,0,Math.PI*2); ctx.arc(7,-2,6,0,Math.PI*2); ctx.fill();
      ctx.fillStyle='#27343a'; ctx.beginPath(); ctx.arc(-6,-1,2.8,0,Math.PI*2); ctx.arc(6,-1,2.8,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='#7c2e28'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(-7,9); ctx.quadraticCurveTo(0,13,7,9); ctx.stroke();
    } else {
      ctx.fillStyle='#d95247'; ctx.beginPath(); ctx.arc(0,-2,13,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='#a93a32'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(0,-2,8,.2,Math.PI-.2); ctx.stroke();
      if (oniState === 'feint') {
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.ellipse(13,0,3.8,5.2,-.2,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#27343a'; ctx.beginPath(); ctx.arc(14,0,1.7,0,Math.PI*2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawPlayer(now) {
    ctx.save(); ctx.translate(player.x,player.y);
    ctx.fillStyle='rgba(52,80,49,.15)'; ctx.beginPath(); ctx.ellipse(0,15,14,5,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3c7bd9'; ctx.beginPath(); ctx.roundRect(-9,0,18,21,8); ctx.fill();
    ctx.fillStyle='#ffd29b'; ctx.beginPath(); ctx.arc(0,-7,10,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#69482f'; ctx.beginPath(); ctx.arc(0,-10,10,Math.PI,Math.PI*2); ctx.fill();
    ctx.fillStyle='#27343a'; ctx.beginPath(); ctx.arc(-3,-6,1.2,0,Math.PI*2); ctx.arc(3,-6,1.2,0,Math.PI*2); ctx.fill();
    if (safeNow && gameState === 'playing') {
      ctx.fillStyle='rgba(38,152,75,.9)'; ctx.font='900 12px system-ui'; ctx.textAlign='center'; ctx.fillText('SAFE',0,-24);
    }
    if (gameState === 'playing' && oniState === 'look' && !safeNow) drawDiscoveryGauge();
    ctx.restore();
  }

  function drawDiscoveryGauge() {
    const w=36,h=6,x=-18,y=-31;
    ctx.fillStyle='rgba(255,255,255,.9)'; ctx.beginPath(); ctx.roundRect(x-2,y-2,w+4,h+4,5); ctx.fill();
    ctx.fillStyle='#d7dfd5'; ctx.beginPath(); ctx.roundRect(x,y,w,h,4); ctx.fill();
    const fill = w*clamp(discovery,0,1);
    if (fill>0) { ctx.fillStyle = discovery < .66 ? '#ffb43d' : '#f34d43'; ctx.beginPath(); ctx.roundRect(x,y,fill,h,4); ctx.fill(); }
    ctx.fillStyle='#f34d43'; ctx.font='1000 16px system-ui'; ctx.textAlign='center'; ctx.fillText('!',0,y-5);
  }

  function drawTapFlashes(now) {
    ctx.save();
    for (const f of tapFlash) {
      const t=(now-f.born)/240;
      ctx.globalAlpha=1-t;
      ctx.strokeStyle='#fff'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(f.x,f.y,4+t*10,0,Math.PI*2); ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles(now) {
    ctx.save();
    for (let i=0;i<particles.length;i++) {
      const p=particles[i]; const t=(now-p.born)/p.life;
      ctx.globalAlpha=1-t; ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.fillStyle=['#ff765f','#ffd65c','#67c983','#66a8e8','#cc79d8'][i%5];
      ctx.fillRect(-3,-3,6,6); ctx.restore();
    }
    ctx.restore(); ctx.globalAlpha=1;
  }

  function frame(now) {
    const dt = Math.min(40, now - lastFrame);
    lastFrame = now;
    update(now, dt);
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function canvasDirectionFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width / 3) return -1;
    if (x < rect.width * 2 / 3) return 0;
    return 1;
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (gameState !== 'playing') return;
    tryMove(canvasDirectionFromEvent(e));
  }, { passive: false });

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive:false });
  document.addEventListener('dblclick', e => e.preventDefault(), { passive:false });

  muteButton.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); setMuted(!muted); }, { passive:false });
  startButton.addEventListener('click', e => { e.stopPropagation(); beginCountdown(); });
  retryButton.addEventListener('click', e => { e.stopPropagation(); beginCountdown(); });

  window.addEventListener('blur', () => {
    // ブラウザ外へ出た間の入力残りを作らない。時間は継続する。
  });

  // 開発・動作確認用。通常プレイには影響しない読み取り中心のフック。
  window.__OTG003 = {
    version: '1.0.0',
    getState: () => ({ gameState, oniState, muted, player: {...player}, safeNow, discovery, obstacleCount: obstacles.length, remainingMeters: remainingMetersAt() }),
    validateManyStages: (n=100) => {
      let fallback=0, invalid=0, firstShelterFail=0;
      for (let i=0;i<n;i++) {
        const st=generateStage();
        if (!validateReachability(st)) invalid++;
        if (!validateFirstShelter(st)) firstShelterFail++;
        if (st.length===6 && st[0].x===120 && st[0].y===470) fallback++;
      }
      return {n, invalid, firstShelterFail, fallback};
    },
    forcePlaying: () => { prepareNewGame(); gameState='playing'; gameShell.classList.add('playing'); titleScreen.classList.remove('active'); resultScreen.classList.remove('active'); gameStartTime=performance.now(); startBackCycle(true); },
    forceLook: () => { oniState='look'; phaseStart=performance.now(); phaseDuration=2; discoveryDuration=1; discovery=0; },
    forceBack: () => startBackCycle(false),
    forcePlayer: (x,y) => { player={x,y}; safeNow=isSafeAt(x,y); },
    move: d => tryMove(d),
    getObstacles: () => obstacles.map(o => ({type:o.type,x:o.x,y:o.y,r:o.r,shadow:o.shadow.map(p=>({...p}))})),
    clearStorage: () => { localStorage.removeItem(STORAGE.best); localStorage.removeItem(STORAGE.closest); bestTime=null; closestMeters=null; }
  };

  setMuted(true);
  prepareNewGame();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
})();
