/* ==========================================================
   FIFA 26 Mini — расширенная реалистичная версия
   Файл: game.js
   ========================================================== */

(function () {
  'use strict';

  console.log('[FIFA] Запуск');

  // ---------- Canvas ----------
  var canvas = document.getElementById('game');
  if (!canvas) { console.error('[FIFA] Нет canvas'); return; }
  var ctx = canvas.getContext('2d');
  if (!ctx) { console.error('[FIFA] Нет 2D'); return; }

  var W = canvas.width;   // 960
  var H = canvas.height;  // 600

  // ---------- Геометрия поля ----------
  var FIELD = { left: 40, right: W - 40, top: 40, bottom: H - 40 };
  var FW = FIELD.right - FIELD.left;
  var FH = FIELD.bottom - FIELD.top;
  var CX = W / 2;
  var CY = H / 2;

  var GOAL_H = 150;
  var GOAL_TOP = CY - GOAL_H / 2;
  var GOAL_BOTTOM = CY + GOAL_H / 2;
  var GOAL_DEPTH = 24;

  var BALL_R = 8;
  var PLAYER_R = 14;
  var KICK_RANGE = BALL_R + PLAYER_R + 22;

  var MATCH_TIME = 120;
  var ACCEL = 2100;
  var FRICTION = 7.5;
  var SPD_PLAYER = 272;
  var SPD_AI = 252;
  var SPD_GK = 238;
  var BALL_FRICTION = 1.5;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

  function makeRand(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // ---------- Состояние ----------
  var state = {
    phase: 'idle',
    timeLeft: MATCH_TIME,
    score: { blue: 0, red: 0 },
    ball: { x: CX, y: CY, vx: 0, vy: 0, angle: 0, spin: 0 },
    players: [],
    controlled: null,
    charging: false,
    power: 0,
    message: '',
    msgTimer: 0,
    phaseTimer: 0,
    sprinting: false,
    shake: 0,
    lastWhistle: false
  };

  var keys = {};
  var effects = [];
  var particles = [];
  var ballTrail = [];
  var goalFlash = 0;
  var uid = 0;

  // ---------- Аудио (Web Audio API) ----------
  var audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) { console.warn('[FIFA] Audio недоступен'); }
    return audioCtx;
  }
  function playTone(freq, dur, type, vol, sweepTo) {
    var ac = ensureAudio();
    if (!ac) return;
    if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    try {
      var now = ac.currentTime;
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, now);
      if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, now + dur);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    } catch (e) {}
  }
  function sfxKick(power) {
    playTone(180 + power * 260, 0.14, 'triangle', 0.14, 70);
  }
  function sfxWhistle() {
    playTone(2400, 0.35, 'sine', 0.09);
    setTimeout(function () { playTone(2200, 0.25, 'sine', 0.07); }, 180);
  }
  function sfxGoal() {
    playTone(523.25, 0.35, 'sine', 0.13);
    setTimeout(function () { playTone(659.25, 0.35, 'sine', 0.13); }, 80);
    setTimeout(function () { playTone(783.99, 0.6, 'sine', 0.14); }, 160);
  }
  function sfxLoss() {
    playTone(220, 0.5, 'sawtooth', 0.08, 110);
  }

  // ---------- Пред-рендер газона ----------
  var pitchCanvas = null;
  function buildPitch() {
    pitchCanvas = document.createElement('canvas');
    pitchCanvas.width = W;
    pitchCanvas.height = H;
    var pc = pitchCanvas.getContext('2d');

    // фон вне поля (тёмная земля)
    pc.fillStyle = '#0a0f18';
    pc.fillRect(0, 0, W, H);

    // Много полос травы
    var STRIPES = 18;
    var sw = FW / STRIPES;
    for (var i = 0; i < STRIPES; i++) {
      var g = pc.createLinearGradient(0, FIELD.top, 0, FIELD.bottom);
      if (i % 2 === 0) {
        g.addColorStop(0, '#2e8338');
        g.addColorStop(0.5, '#2a7a33');
        g.addColorStop(1, '#256c2e');
      } else {
        g.addColorStop(0, '#276f30');
        g.addColorStop(0.5, '#23662b');
        g.addColorStop(1, '#1f5d27');
      }
      pc.fillStyle = g;
      pc.fillRect(FIELD.left + i * sw, FIELD.top, sw + 1, FH);
    }

    // Тонкая текстура травы
    var rand = makeRand(0xC0FFEE);
    for (var k = 0; k < 14000; k++) {
      var x = FIELD.left + rand() * FW;
      var y = FIELD.top + rand() * FH;
      var a = rand() * 0.08;
      pc.fillStyle = rand() > 0.5
        ? 'rgba(255,255,255,' + a.toFixed(3) + ')'
        : 'rgba(0,0,0,' + a.toFixed(3) + ')';
      pc.fillRect(x, y, 1.1, 1.8);
    }

    // Мягкое освещение сверху-слева
    var light = pc.createRadialGradient(
      FIELD.left + FW * 0.3, FIELD.top + FH * 0.22, 40,
      CX, CY, FW * 0.85
    );
    light.addColorStop(0, 'rgba(255,255,255,0.14)');
    light.addColorStop(0.5, 'rgba(255,255,255,0.03)');
    light.addColorStop(1, 'rgba(0,0,0,0.22)');
    pc.fillStyle = light;
    pc.fillRect(FIELD.left, FIELD.top, FW, FH);

    // Затемнение по краям
    var edge = pc.createRadialGradient(CX, CY, FW * 0.3, CX, CY, FW * 0.78);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.55)');
    pc.fillStyle = edge;
    pc.fillRect(0, 0, W, H);

    // Разметка
    pc.strokeStyle = 'rgba(255,255,255,0.94)';
    pc.lineWidth = 2.4;
    pc.shadowColor = 'rgba(0,0,0,0.4)';
    pc.shadowBlur = 2;
    pc.shadowOffsetY = 1;

    pc.strokeRect(FIELD.left, FIELD.top, FW, FH);

    pc.beginPath();
    pc.moveTo(CX, FIELD.top);
    pc.lineTo(CX, FIELD.bottom);
    pc.stroke();

    pc.beginPath();
    pc.arc(CX, CY, 70, 0, Math.PI * 2);
    pc.stroke();

    pc.beginPath();
    pc.arc(CX, CY, 4, 0, Math.PI * 2);
    pc.fillStyle = 'rgba(255,255,255,0.94)';
    pc.fill();

    // Штрафные
    var pbW = 130, pbH = 300;
    pc.strokeRect(FIELD.left, CY - pbH / 2, pbW, pbH);
    pc.strokeRect(FIELD.right - pbW, CY - pbH / 2, pbW, pbH);

    // Вратарские
    var gaW = 55, gaH = 180;
    pc.strokeRect(FIELD.left, CY - gaH / 2, gaW, gaH);
    pc.strokeRect(FIELD.right - gaW, CY - gaH / 2, gaW, gaH);

    // Точки пенальти
    pc.beginPath();
    pc.arc(FIELD.left + 95, CY, 3, 0, Math.PI * 2);
    pc.fill();
    pc.beginPath();
    pc.arc(FIELD.right - 95, CY, 3, 0, Math.PI * 2);
    pc.fill();

    // Углы
    var corners = [
      [FIELD.left, FIELD.top, 0, Math.PI / 2],
      [FIELD.right, FIELD.top, Math.PI / 2, Math.PI],
      [FIELD.right, FIELD.bottom, Math.PI, Math.PI * 1.5],
      [FIELD.left, FIELD.bottom, Math.PI * 1.5, Math.PI * 2]
    ];
    for (var c = 0; c < corners.length; c++) {
      pc.beginPath();
      pc.arc(corners[c][0], corners[c][1], 16, corners[c][2], corners[c][3]);
      pc.stroke();
    }

    pc.shadowColor = 'transparent';
    pc.shadowBlur = 0;
    pc.shadowOffsetY = 0;

    // Ворота
    drawGoalNetPre(pc, FIELD.left - GOAL_DEPTH, GOAL_TOP, GOAL_DEPTH, GOAL_H, 'left');
    drawGoalNetPre(pc, FIELD.right, GOAL_TOP, GOAL_DEPTH, GOAL_H, 'right');

    // Финальная виньетка
    var vg = pc.createRadialGradient(CX, CY, 260, CX, CY, 720);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    pc.fillStyle = vg;
    pc.fillRect(0, 0, W, H);

    console.log('[FIFA] Газон готов');
  }

  function drawGoalNetPre(pc, x, y, w, h, side) {
    pc.save();
    var g = pc.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, 'rgba(220,235,255,0.10)');
    g.addColorStop(1, 'rgba(180,210,255,0.18)');
    pc.fillStyle = g;
    pc.fillRect(x, y, w, h);

    pc.strokeStyle = 'rgba(230,240,255,0.35)';
    pc.lineWidth = 0.8;
    pc.beginPath();
    for (var i = x; i <= x + w; i += 7) { pc.moveTo(i, y); pc.lineTo(i, y + h); }
    for (var j = y; j <= y + h; j += 7) { pc.moveTo(x, j); pc.lineTo(x + w, j); }
    pc.stroke();

    var depthShadow = pc.createLinearGradient(
      side === 'left' ? x : x + w, 0,
      side === 'left' ? x + w : x, 0
    );
    depthShadow.addColorStop(0, 'rgba(0,0,0,0.55)');
    depthShadow.addColorStop(1, 'rgba(0,0,0,0)');
    pc.fillStyle = depthShadow;
    pc.fillRect(x, y, w, h);

    pc.strokeStyle = 'rgba(255,255,255,0.96)';
    pc.lineWidth = 4;
    pc.lineCap = 'round';
    pc.beginPath();
    if (side === 'left') {
      pc.moveTo(x + w, y); pc.lineTo(x, y); pc.lineTo(x, y + h); pc.lineTo(x + w, y + h);
    } else {
      pc.moveTo(x, y); pc.lineTo(x + w, y); pc.lineTo(x + w, y + h); pc.lineTo(x, y + h);
    }
    pc.stroke();
    pc.restore();
  }

  // ---------- Пред-рендер трибун и рекламных щитов ----------
  var crowdCanvas = null;
  function buildCrowd() {
    crowdCanvas = document.createElement('canvas');
    crowdCanvas.width = W;
    crowdCanvas.height = H;
    var cc = crowdCanvas.getContext('2d');

    // базовый тёмный фон
    var bgGrad = cc.createRadialGradient(CX, CY, 100, CX, CY, 750);
    bgGrad.addColorStop(0, '#0a1524');
    bgGrad.addColorStop(1, '#02060c');
    cc.fillStyle = bgGrad;
    cc.fillRect(0, 0, W, H);

    var rand = makeRand(0xBEEF);
    var skinTones = ['#f5c89a', '#e0a878', '#c88a5c', '#a06a42', '#7a4a2a'];
    var jersey = ['#e63946', '#2f6df6', '#f7b801', '#06d6a0', '#8e44ad', '#ff6f3c', '#ffffff', '#222a3a', '#4ade80'];

    var ringW = 22;

    // ---- трибуны: точки-болельщики ----
    for (var y = 0; y < H; y += 3) {
      for (var x = 0; x < W; x += 3) {
        var inRing = (y < ringW) || (y > H - ringW) || (x < ringW) || (x > W - ringW);
        if (!inRing) continue;

        var r = rand();
        var col;
        if (r < 0.5) {
          col = skinTones[Math.floor(rand() * skinTones.length)];
        } else {
          col = jersey[Math.floor(rand() * jersey.length)];
        }
        cc.fillStyle = col;
        cc.globalAlpha = 0.55 + rand() * 0.45;
        cc.fillRect(x + (rand() - 0.5) * 1.6, y + (rand() - 0.5) * 1.6, 1.8, 2.4);
      }
    }
    cc.globalAlpha = 1;

    // затемнение трибун
    var dt1 = cc.createLinearGradient(0, 0, 0, ringW + 6);
    dt1.addColorStop(0, 'rgba(0,0,0,0.55)');
    dt1.addColorStop(1, 'rgba(0,0,0,0)');
    cc.fillStyle = dt1;
    cc.fillRect(0, 0, W, ringW + 6);

    var dt2 = cc.createLinearGradient(0, H, 0, H - ringW - 6);
    dt2.addColorStop(0, 'rgba(0,0,0,0.55)');
    dt2.addColorStop(1, 'rgba(0,0,0,0)');
    cc.fillStyle = dt2;
    cc.fillRect(0, H - ringW - 6, W, ringW + 6);

    // ---- Рекламные щиты между трибунами и полем ----
    var adTop = ringW;
    var adBottom = FIELD.top;
    var adLeft = ringW;
    var adRight = FIELD.left;

    // верхний щит
    var adGradT = cc.createLinearGradient(0, adTop, 0, adBottom);
    adGradT.addColorStop(0, '#101a2c');
    adGradT.addColorStop(1, '#1c2c46');
    cc.fillStyle = adGradT;
    cc.fillRect(0, adTop, W, adBottom - adTop);

    // нижний
    var adGradB = cc.createLinearGradient(0, H - adBottom + adTop, 0, H - adTop);
    cc.fillStyle = adGradB;
    cc.fillStyle = '#101a2c';
    cc.fillRect(0, H - adBottom, W, adBottom - adTop);

    // левый
    cc.fillStyle = '#101a2c';
    cc.fillRect(adLeft, FIELD.top - adBottom + adTop, adBottom - adTop, FH);
    // правый
    cc.fillRect(W - adBottom, FIELD.top - adBottom + adTop, adBottom - adTop, FH);

    // Полосы рекламы
    var adColors = ['#e63946', '#f7b801', '#2f6df6', '#06d6a0', '#8e44ad', '#ff6f3c'];
    var rand2 = makeRand(0xFACE);
    for (var i2 = 0; i2 < 20; i2++) {
      var c2 = adColors[Math.floor(rand2() * adColors.length)];
      cc.fillStyle = c2;
      cc.globalAlpha = 0.65;
      cc.fillRect(30 + i2 * 50, adTop + 4, 30, adBottom - adTop - 8);
      cc.fillRect(30 + i2 * 50, H - adBottom + 4, 30, adBottom - adTop - 8);
      cc.globalAlpha = 1;
    }
    for (var i3 = 0; i3 < 10; i3++) {
      var c3 = adColors[Math.floor(rand2() * adColors.length)];
      cc.fillStyle = c3;
      cc.globalAlpha = 0.55;
      cc.fillRect(adLeft + 3, FIELD.top + 30 + i3 * 55, adBottom - adTop - 6, 26);
      cc.fillRect(W - adBottom + 3, FIELD.top + 30 + i3 * 55, adBottom - adTop - 6, 26);
      cc.globalAlpha = 1;
    }

    // тени от щитов на газон
    var sh1 = cc.createLinearGradient(0, adBottom, 0, adBottom + 8);
    sh1.addColorStop(0, 'rgba(0,0,0,0.55)');
    sh1.addColorStop(1, 'rgba(0,0,0,0)');
    cc.fillStyle = sh1;
    cc.fillRect(0, adBottom, W, 8);

    var sh2 = cc.createLinearGradient(0, H - adBottom, 0, H - adBottom - 8);
    sh2.addColorStop(0, 'rgba(0,0,0,0.55)');
    sh2.addColorStop(1, 'rgba(0,0,0,0)');
    cc.fillStyle = sh2;
    cc.fillRect(0, H - adBottom - 8, W, 8);

    console.log('[FIFA] Трибуны готовы');
  }

  // ---------- Игроки ----------
  var SKIN = ['#f5c89a', '#e0a878', '#c88a5c', '#a06a42', '#7a4a2a'];
  var HAIR = ['#1a0e08', '#3a1e0a', '#8a5a2a', '#d4a574', '#0a0a0a', '#5a3a1a'];

  function createPlayer(team, role, hx, hy, num) {
    return {
      id: ++uid,
      team: team,
      role: role,
      homeX: hx,
      homeY: hy,
      x: hx,
      y: hy,
      vx: 0,
      vy: 0,
      angle: team === 'blue' ? 0 : Math.PI,
      num: num,
      kickCd: 0,
      stride: 0,
      skin: SKIN[Math.floor(Math.random() * SKIN.length)],
      hair: HAIR[Math.floor(Math.random() * HAIR.length)]
    };
  }

  function createTeams() {
    state.players = [
      createPlayer('blue', 'gk', FIELD.left + 36, CY, 1),
      createPlayer('blue', 'fw', FIELD.left + FW * 0.28, CY - 115, 4),
      createPlayer('blue', 'fw', FIELD.left + FW * 0.28, CY + 115, 5),
      createPlayer('blue', 'fw', FIELD.left + FW * 0.46, CY, 9),

      createPlayer('red', 'gk', FIELD.right - 36, CY, 1),
      createPlayer('red', 'fw', FIELD.right - FW * 0.28, CY - 115, 4),
      createPlayer('red', 'fw', FIELD.right - FW * 0.28, CY + 115, 5),
      createPlayer('red', 'fw', FIELD.right - FW * 0.46, CY, 9)
    ];
  }

  function resetPositions() {
    var b = state.ball;
    b.x = CX; b.y = CY; b.vx = 0; b.vy = 0; b.angle = 0;
    ballTrail.length = 0;
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      p.x = p.homeX;
      p.y = p.homeY;
      p.vx = 0; p.vy = 0;
      p.kickCd = 0;
      p.angle = p.team === 'blue' ? 0 : Math.PI;
    }
    effects.length = 0;
    particles.length = 0;
  }

  // ---------- Ввод ----------
  var BLOCK_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

  window.addEventListener('keydown', function (e) {
    if (BLOCK_KEYS.indexOf(e.code) !== -1) e.preventDefault();
    ensureAudio();
    if (e.repeat) return;
    keys[e.code] = true;

    if (e.code === 'Space') {
      if (state.phase === 'play' || state.phase === 'kickoff') {
        state.charging = true;
        state.power = 0;
      }
    }
  });

  window.addEventListener('keyup', function (e) {
    keys[e.code] = false;
    if (e.code === 'Space' && state.charging) releaseShot();
  });

  window.addEventListener('blur', function () {
    keys = {};
    state.charging = false;
    state.power = 0;
  });

  function getMaxSpeed(p) {
    if (p.role === 'gk') return SPD_GK;
    if (p === state.controlled) return state.sprinting ? SPD_PLAYER * 1.12 : SPD_PLAYER;
    return SPD_AI;
  }

  function updateControlledInput(dt) {
    var best = null, bestD = Infinity;
    var b = state.ball;
    for (var i = 0; i < state.players.length; i++) {
      var pl = state.players[i];
      if (pl.team !== 'blue' || pl.role === 'gk') continue;
      var d = dist(pl.x, pl.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = pl; }
    }
    if (best && best !== state.controlled && !state.charging) {
      state.controlled = best;
    }
    var p = state.controlled;
    if (!p) return;

    var ax = 0, ay = 0;
    if (keys['ArrowLeft'] || keys['KeyA']) ax -= 1;
    if (keys['ArrowRight'] || keys['KeyD']) ax += 1;
    if (keys['ArrowUp'] || keys['KeyW']) ay -= 1;
    if (keys['ArrowDown'] || keys['KeyS']) ay += 1;

    state.sprinting = !!(keys['ShiftLeft'] || keys['ShiftRight']);

    var len = Math.sqrt(ax * ax + ay * ay);
    if (len > 0) {
      ax /= len; ay /= len;
      var mul = state.sprinting ? 1.12 : 1;
      p.vx += ax * ACCEL * mul * dt;
      p.vy += ay * ACCEL * mul * dt;
    }
  }

  function releaseShot() {
    state.charging = false;
    var power = state.power;
    state.power = 0;

    if (state.phase !== 'play' && state.phase !== 'kickoff') return;
    var p = state.controlled;
    if (!p) return;

    var b = state.ball;
    if (dist(b.x, b.y, p.x, p.y) > KICK_RANGE + 8) return;

    var aimY = CY;
    if (keys['ArrowUp'] || keys['KeyW']) aimY = GOAL_TOP + 24;
    else if (keys['ArrowDown'] || keys['KeyS']) aimY = GOAL_BOTTOM - 24;

    var dx = FIELD.right - b.x;
    var dy = aimY - b.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var speed = 520 + power * 520;

    b.vx = (dx / len) * speed;
    b.vy = (dy / len) * speed;
    b.x += (dx / len) * 2.5;
    b.y += (dy / len) * 2.5;

    spawnKickEffect(b.x, b.y);
    sfxKick(power);
  }

  function updateCharge(dt) {
    if (state.charging) state.power = Math.min(1, state.power + dt * 1.35);
  }

  // ---------- ИИ ----------
  function closestFieldPlayer(team) {
    var best = null, bestD = Infinity;
    var b = state.ball;
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      if (p.team !== team || p.role === 'gk') continue;
      var d = dist(p.x, p.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function moveTo(p, tx, ty, dt) {
    var dx = tx - p.x, dy = ty - p.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 3) return;
    var nx = dx / d, ny = dy / d;
    var scale = Math.min(1, d / 50);
    p.vx += nx * ACCEL * scale * dt;
    p.vy += ny * ACCEL * scale * dt;
  }

  function kickToward(p, tx, ty, speed) {
    var b = state.ball;
    var dx = tx - b.x, dy = ty - b.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    b.vx = (dx / len) * speed;
    b.vy = (dy / len) * speed;
    spawnKickEffect(b.x, b.y);
  }

  function updateAI(dt) {
    var closestBlue = closestFieldPlayer('blue');
    var closestRed = closestFieldPlayer('red');

    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      if (p.role === 'gk') { updateGoalkeeper(p, dt); continue; }
      if (p === state.controlled) continue;

      var isClosest = (p.team === 'blue' ? closestBlue : closestRed) === p;
      var dir = p.team === 'blue' ? 1 : -1;
      var tx, ty;

      if (isClosest) {
        tx = state.ball.x - dir * 16;
        ty = state.ball.y;
      } else {
        tx = p.homeX + (state.ball.x - CX) * 0.35;
        ty = p.homeY + (state.ball.y - CY) * 0.35;
        tx = clamp(tx, FIELD.left + 30, FIELD.right - 30);
        ty = clamp(ty, FIELD.top + 30, FIELD.bottom - 30);
      }

      moveTo(p, tx, ty, dt);
      aiKick(p);
    }
  }

  function aiKick(p) {
    if (p.kickCd > 0) return;
    var b = state.ball;
    if (dist(b.x, b.y, p.x, p.y) > KICK_RANGE) return;

    var goalX = p.team === 'blue' ? FIELD.right : FIELD.left;
    var distToGoal = Math.abs(b.x - goalX);

    if (distToGoal < 330) {
      var gy = CY + (Math.random() - 0.5) * (GOAL_H - 34);
      kickToward(p, goalX, gy, 620 + Math.random() * 200);
      p.kickCd = 0.9;
    } else {
      var dir = p.team === 'blue' ? 1 : -1;
      var tx = b.x + dir * 230;
      var ty = CY + (Math.random() - 0.5) * 250;
      kickToward(p, tx, ty, 400);
      p.kickCd = 0.7;
    }
  }

  function updateGoalkeeper(p, dt) {
    var b = state.ball;
    var isBlue = p.team === 'blue';
    var lineX = isBlue ? FIELD.left + 34 : FIELD.right - 34;

    var ty = clamp(b.y, GOAL_TOP - 5, GOAL_BOTTOM + 5);
    var distToLine = isBlue ? b.x - FIELD.left : FIELD.right - b.x;
    var tx = lineX;
    if (distToLine < 170 && distToLine > -30) {
      var out = (1 - clamp(distToLine, 0, 170) / 170) * 55;
      tx = isBlue ? lineX + out : lineX - out;
    }

    moveTo(p, tx, ty, dt);

    if (p.kickCd > 0) p.kickCd -= dt;
    if (p.kickCd <= 0) {
      if (dist(b.x, b.y, p.x, p.y) < KICK_RANGE + 12) {
        var dir = isBlue ? 1 : -1;
        kickToward(p, b.x + dir * 420, CY + (Math.random() - 0.5) * 220, 560);
        p.kickCd = 0.9;
      }
    }
  }

  // ---------- Физика ----------
  function integrateAll(dt) {
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      p.vx -= p.vx * FRICTION * dt;
      p.vy -= p.vy * FRICTION * dt;

      var max = getMaxSpeed(p);
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > max) { p.vx = (p.vx / sp) * max; p.vy = (p.vy / sp) * max; }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      var minX = FIELD.left + PLAYER_R, maxX = FIELD.right - PLAYER_R;
      var minY = FIELD.top + PLAYER_R, maxY = FIELD.bottom - PLAYER_R;

      if (p.x < minX) { p.x = minX; if (p.vx < 0) p.vx = 0; }
      if (p.x > maxX) { p.x = maxX; if (p.vx > 0) p.vx = 0; }
      if (p.y < minY) { p.y = minY; if (p.vy < 0) p.vy = 0; }
      if (p.y > maxY) { p.y = maxY; if (p.vy > 0) p.vy = 0; }

      if (p.kickCd > 0) p.kickCd -= dt;

      var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (speed > 12) {
        p.angle = Math.atan2(p.vy, p.vx);
        p.stride += dt * (6 + speed * 0.06);
      } else {
        p.stride += dt * 1.2;
      }
    }

    // расталкивание игроков
    for (var a = 0; a < state.players.length; a++) {
      for (var b2 = a + 1; b2 < state.players.length; b2++) {
        var pa = state.players[a], pb = state.players[b2];
        var dx = pb.x - pa.x, dy = pb.y - pa.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var minD = PLAYER_R * 2;
        if (d < minD && d > 0.001) {
          var nx = dx / d, ny = dy / d;
          var push = (minD - d) / 2;
          pa.x -= nx * push; pa.y -= ny * push;
          pb.x += nx * push; pb.y += ny * push;
        }
      }
    }
  }

  function updateBallPhysics(dt) {
    var b = state.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    var speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > 6) {
      b.angle += speed * dt * 0.08;
      ballTrail.push({ x: b.x, y: b.y, life: 0.35, max: 0.35 });
    }
    for (var i = ballTrail.length - 1; i >= 0; i--) {
      ballTrail[i].life -= dt;
      if (ballTrail[i].life <= 0) ballTrail.splice(i, 1);
    }
    if (ballTrail.length > 28) ballTrail.splice(0, ballTrail.length - 28);

    var f = Math.exp(-BALL_FRICTION * dt);
    b.vx *= f; b.vy *= f;
    if (Math.abs(b.vx) < 3) b.vx = 0;
    if (Math.abs(b.vy) < 3) b.vy = 0;

    if (b.y - BALL_R < FIELD.top) { b.y = FIELD.top + BALL_R; b.vy = Math.abs(b.vy) * 0.75; }
    if (b.y + BALL_R > FIELD.bottom) { b.y = FIELD.bottom - BALL_R; b.vy = -Math.abs(b.vy) * 0.75; }

    if (b.x - BALL_R < FIELD.left) {
      var inMouthL = b.y > GOAL_TOP && b.y < GOAL_BOTTOM;
      if (inMouthL) {
        if (b.x - BALL_R < FIELD.left - GOAL_DEPTH) {
          b.x = FIELD.left - GOAL_DEPTH + BALL_R;
          b.vx = Math.abs(b.vx) * 0.25;
        }
      } else {
        b.x = FIELD.left + BALL_R;
        b.vx = Math.abs(b.vx) * 0.75;
      }
    }

    if (b.x + BALL_R > FIELD.right) {
      var inMouthR = b.y > GOAL_TOP && b.y < GOAL_BOTTOM;
      if (inMouthR) {
        if (b.x + BALL_R > FIELD.right + GOAL_DEPTH) {
          b.x = FIELD.right + GOAL_DEPTH - BALL_R;
          b.vx = -Math.abs(b.vx) * 0.25;
        }
      } else {
        b.x = FIELD.right - BALL_R;
        b.vx = -Math.abs(b.vx) * 0.75;
      }
    }
  }

  function handleBallPlayerCollisions() {
    var b = state.ball;
    for (var i = 0; i < state.players.length; i++) {
      var p = state.players[i];
      var dx = b.x - p.x, dy = b.y - p.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var minD = BALL_R + PLAYER_R;

      if (d < minD && d > 0.001) {
        var nx = dx / d, ny = dy / d;
        b.x = p.x + nx * minD;
        b.y = p.y + ny * minD;
        var pv = p.vx * nx + p.vy * ny;
        var speed = Math.max(pv * 1.05 + 15, 45);
        b.vx = nx * speed + p.vx * 0.35;
        b.vy = ny * speed + p.vy * 0.35;
      }
    }
  }

  function checkGoal() {
    if (state.phase !== 'play') return;
    var b = state.ball;
    var inMouth = b.y > GOAL_TOP && b.y < GOAL_BOTTOM;
    if (inMouth && b.x - BALL_R <= FIELD.left) scoreGoal('red');
    else if (inMouth && b.x + BALL_R >= FIELD.right) scoreGoal('blue');
  }

  // ---------- Эффекты и частицы ----------
  function spawnKickEffect(x, y) {
    effects.push({ x: x, y: y, r: 8, life: 0.3, max: 0.3 });
    // искорки
    for (var i = 0; i < 6; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 60 + Math.random() * 120;
      particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4, max: 0.4,
        color: 'rgba(255,255,255,'
      });
    }
  }

  function spawnGoalParticles(x, y, isBlue) {
    var baseCol = isBlue ? '90,160,255,' : '255,90,110,';
    for (var i = 0; i < 80; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 80 + Math.random() * 340;
      particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1.2 + Math.random() * 0.8,
        max: 2,
        color: 'rgba(' + baseCol,
        size: 2 + Math.random() * 3
      });
    }
    // золотые искры
    for (var j = 0; j < 40; j++) {
      var a2 = Math.random() * Math.PI * 2;
      var sp2 = 100 + Math.random() * 400;
      particles.push({
        x: x, y: y,
        vx: Math.cos(a2) * sp2,
        vy: Math.sin(a2) * sp2,
        life: 1 + Math.random() * 0.8,
        max: 1.8,
        color: 'rgba(255,214,10,',
        size: 2 + Math.random() * 2.5
      });
    }
  }

  function updateEffects(dt) {
    for (var i = effects.length - 1; i >= 0; i--) {
      effects[i].life -= dt;
      effects[i].r += 130 * dt;
      if (effects[i].life <= 0) effects.splice(i, 1);
    }
    for (var j = particles.length - 1; j >= 0; j--) {
      var p = particles[j];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= dt;
      if (p.life <= 0) particles.splice(j, 1);
    }
    if (state.shake > 0.2) state.shake *= 0.88;
    else state.shake = 0;
    if (goalFlash > 0) goalFlash -= dt;
  }

  // ---------- Матч ----------
  function scoreGoal(team) {
    if (state.phase !== 'play') return;

    if (team === 'blue') {
      state.score.blue++;
      state.message = 'ГОЛ! ⚽';
      sfxGoal();
      spawnGoalParticles(state.ball.x, state.ball.y, true);
    } else {
      state.score.red++;
      state.message = 'ПРОПУЩЕН ГОЛ';
      sfxLoss();
      spawnGoalParticles(state.ball.x, state.ball.y, false);
    }

    state.shake = 14;
    goalFlash = 0.5;
    state.phase = 'goal';
    state.phaseTimer = 2.4;
    state.msgTimer = 2.4;
    state.charging = false;
    state.power = 0;
    updateHUD();
  }

  function finishMatch() {
    state.phase = 'ended';
    state.charging = false;
    state.power = 0;

    var gf = state.score.blue, ga = state.score.red;
    var result = 'draw';
    if (gf > ga) result = 'win';
    else if (gf < ga) result = 'loss';

    saveMatchResult(result, gf, ga);
    showOverlay(result, gf, ga);
  }

  function startMatch() {
    ensureAudio();
    state.score.blue = 0;
    state.score.red = 0;
    state.timeLeft = MATCH_TIME;
    state.phase = 'kickoff';
    state.phaseTimer = 1.5;
    state.message = '';
    state.msgTimer = 0;
    state.charging = false;
    state.power = 0;
    state.controlled = null;
    state.lastWhistle = false;

    resetPositions();
    hideOverlay();
    updateHUD();
  }

  // ---------- Рекорды ----------
  var STORAGE_KEY = 'fifa26_records_v2';

  function defaultRecords() {
    return {
      matches: 0, wins: 0, draws: 0, losses: 0,
      goalsFor: 0, goalsAgainst: 0,
      bestMargin: 0, bestResult: '—',
      mostGoals: 0, cleanSheets: 0,
      winStreak: 0, bestWinStreak: 0
    };
  }

  function loadRecords() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultRecords();
      return Object.assign(defaultRecords(), JSON.parse(raw));
    } catch (e) {
      console.warn('[FIFA] localStorage недоступен');
      return defaultRecords();
    }
  }
  function saveRecords() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch (e) {}
  }

  var records = loadRecords();

  function saveMatchResult(result, gf, ga) {
    records.matches++;
    records.goalsFor += gf;
    records.goalsAgainst += ga;

    if (result === 'win') {
      records.wins++; records.winStreak++;
      if (records.winStreak > records.bestWinStreak) records.bestWinStreak = records.winStreak;
    } else if (result === 'draw') {
      records.draws++; records.winStreak = 0;
    } else {
      records.losses++; records.winStreak = 0;
    }

    if (ga === 0) records.cleanSheets++;
    if (gf > records.mostGoals) records.mostGoals = gf;

    var margin = gf - ga;
    if (margin > records.bestMargin) {
      records.bestMargin = margin;
      records.bestResult = gf + ':' + ga;
    }

    saveRecords();
    renderRecords();
  }

  function renderRecords() {
    var r = records;
    var wr = r.matches ? Math.round((r.wins / r.matches) * 100) : 0;
    var grid = document.getElementById('recordsGrid');
    if (!grid) return;
    grid.innerHTML =
      '<div class="rec"><span>Матчей</span><b>' + r.matches + '</b></div>' +
      '<div class="rec"><span>Побед</span><b>' + r.wins + '</b></div>' +
      '<div class="rec"><span>Ничьих</span><b>' + r.draws + '</b></div>' +
      '<div class="rec"><span>Поражений</span><b>' + r.losses + '</b></div>' +
      '<div class="rec"><span>% побед</span><b>' + wr + '%</b></div>' +
      '<div class="rec"><span>Забито</span><b>' + r.goalsFor + '</b></div>' +
      '<div class="rec"><span>Пропущено</span><b>' + r.goalsAgainst + '</b></div>' +
      '<div class="rec"><span>Лучший счёт</span><b>' + r.bestResult + '</b></div>' +
      '<div class="rec"><span>Голов за матч</span><b>' + r.mostGoals + '</b></div>' +
      '<div class="rec"><span>Сухих матчей</span><b>' + r.cleanSheets + '</b></div>' +
      '<div class="rec"><span>Серия побед</span><b>' + r.bestWinStreak + '</b></div>';
  }

  // ---------- UI ----------
  var scoreBlueEl = document.getElementById('scoreBlue');
  var scoreRedEl = document.getElementById('scoreRed');
  var timerEl = document.getElementById('timer');
  var overlayEl = document.getElementById('overlay');
  var overlayTitleEl = document.getElementById('overlayTitle');
  var overlayTextEl = document.getElementById('overlayText');
  var restartBtn = document.getElementById('restartBtn');
  var resetBtn = document.getElementById('resetRecords');

  var hudCache = { blue: -1, red: -1, time: -1 };

  function updateHUD() {
    if (hudCache.blue !== state.score.blue) {
      hudCache.blue = state.score.blue;
      if (scoreBlueEl) scoreBlueEl.textContent = state.score.blue;
    }
    if (hudCache.red !== state.score.red) {
      hudCache.red = state.score.red;
      if (scoreRedEl) scoreRedEl.textContent = state.score.red;
    }
    var t = Math.max(0, Math.ceil(state.timeLeft));
    if (hudCache.time !== t) {
      hudCache.time = t;
      var m = Math.floor(t / 60), s = t % 60;
      if (timerEl) timerEl.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
  }

  function showOverlay(result, gf, ga) {
    var titles = { win: '🏆 ПОБЕДА!', draw: '🤝 НИЧЬЯ', loss: '😞 ПОРАЖЕНИЕ' };
    if (overlayTitleEl) overlayTitleEl.textContent = titles[result] || 'Матч завершён';
    if (overlayTextEl) overlayTextEl.textContent = 'Итоговый счёт: ' + gf + ' : ' + ga;
    if (restartBtn) restartBtn.textContent = 'Играть снова';
    if (overlayEl) overlayEl.classList.add('show');
  }
  function hideOverlay() {
    if (overlayEl) overlayEl.classList.remove('show');
  }

  if (restartBtn) restartBtn.addEventListener('click', startMatch);
  if (resetBtn) resetBtn.addEventListener('click', function () {
    if (confirm('Сбросить все рекорды?')) {
      records = defaultRecords();
      saveRecords();
      renderRecords();
    }
  });

  // ---------- Отрисовка игрока ----------
  function drawPlayerShadow(p) {
    var grd = ctx.createRadialGradient(p.x + 3, p.y + 7, 1, p.x + 3, p.y + 7, PLAYER_R * 1.5);
    grd.addColorStop(0, 'rgba(0,0,0,0.5)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(p.x + 3, p.y + 7, PLAYER_R * 1.4, PLAYER_R * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayerBody(p) {
    var isBlue = p.team === 'blue';
    var isControlled = p === state.controlled;

    var kitMain = isBlue ? '#2f6df6' : '#e63946';
    var kitDark = isBlue ? '#0f2e8f' : '#8a101f';
    var kitLight = isBlue ? '#6f9bff' : '#ff8090';
    var shortsCol = isBlue ? '#0f2f6e' : '#5c0f19';

    ctx.save();
    ctx.translate(p.x, p.y);

    var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    var legOff = speed > 20 ? Math.sin(p.stride) * 3.5 : Math.sin(p.stride * 0.5) * 0.6;

    ctx.rotate(p.angle + Math.PI / 2);

    // ---- ноги ----
    ctx.fillStyle = p.skin;
    ctx.beginPath();
    ctx.ellipse(-4.5, 9 + legOff, 3, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(4.5, 9 - legOff, 3, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Бутсы
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.ellipse(-4.5, 14 + legOff, 3, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(4.5, 14 - legOff, 3, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();

    // ---- шорты ----
    ctx.fillStyle = shortsCol;
    ctx.beginPath();
    ctx.ellipse(0, 3, 10.5, 8.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // ---- корпус (футболка) ----
    var bodyGrad = ctx.createLinearGradient(-10, -8, 10, 8);
    bodyGrad.addColorStop(0, kitLight);
    bodyGrad.addColorStop(0.4, kitMain);
    bodyGrad.addColorStop(1, kitDark);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(0, -3, 12, 13, 0, 0, Math.PI * 2);
    ctx.fill();

    // полоса на футболке
    ctx.strokeStyle = kitLight;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-1.5, -13);
    ctx.lineTo(-1.5, 8);
    ctx.moveTo(1.5, -13);
    ctx.lineTo(1.5, 8);
    ctx.stroke();

    // номер
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.num), 0, -1);

    // ---- руки ----
    ctx.fillStyle = p.skin;
    ctx.beginPath();
    ctx.ellipse(-12, -5 + legOff * 0.6, 3, 6, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(12, -5 - legOff * 0.6, 3, 6, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // ---- голова ----
    // шея
    ctx.fillStyle = p.skin;
    ctx.beginPath();
    ctx.arc(0, -8, 6.6, 0, Math.PI * 2);
    ctx.fill();

    // волосы
    ctx.fillStyle = p.hair;
    ctx.beginPath();
    ctx.arc(0, -8, 6.6, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
    // вихор
    ctx.beginPath();
    ctx.arc(0, -9.5, 6.2, Math.PI * 1.15, Math.PI * 1.85);
    ctx.fill();

    // блик
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.arc(-2, -9.5, 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // ---- индикатор управления ----
    if (isControlled) {
      var pulse = 0.6 + Math.sin(Date.now() * 0.008) * 0.4;
      ctx.save();
      ctx.shadowColor = '#ffd60a';
      ctx.shadowBlur = 14 * pulse;
      ctx.strokeStyle = 'rgba(255,214,10,' + (0.65 + pulse * 0.35).toFixed(2) + ')';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_R + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // треугольник сверху
      ctx.fillStyle = '#ffd60a';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - PLAYER_R - 8);
      ctx.lineTo(p.x - 7, p.y - PLAYER_R - 19);
      ctx.lineTo(p.x + 7, p.y - PLAYER_R - 19);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawBallShadow() {
    var b = state.ball;
    var grd = ctx.createRadialGradient(b.x + 4, b.y + 6, 1, b.x + 4, b.y + 6, BALL_R * 2);
    grd.addColorStop(0, 'rgba(0,0,0,0.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(b.x + 4, b.y + 6, BALL_R * 1.7, BALL_R * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBall() {
    var b = state.ball;

    // шлейф
    for (var i = 0; i < ballTrail.length; i++) {
      var t = ballTrail[i];
      var a = (t.life / t.max) * 0.22 * (i / ballTrail.length);
      ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_R * (0.4 + i / ballTrail.length * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }

    // тело мяча
    var g = ctx.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, BALL_R);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.55, '#f6f6f6');
    g.addColorStop(0.9, '#d0d0d0');
    g.addColorStop(1, '#8f8f8f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    // паттерн (вращается)
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    ctx.fillStyle = '#111';
    // центральный пятиугольник (упрощённый круг)
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
    ctx.fill();
    // 5 маленьких пятен
    for (var j = 0; j < 5; j++) {
      var ang = (j / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * 4.8, Math.sin(ang) * 4.8, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // обводка
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.stroke();

    // блик
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(b.x - 2.6, b.y - 3, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawEffects() {
    // круги от ударов
    for (var i = 0; i < effects.length; i++) {
      var e = effects[i];
      var a = e.life / e.max;
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,' + (a * 0.7).toFixed(2) + ')';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,' + (a * 0.85).toFixed(3) + ')';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      ctx.restore();
    }
    // частицы
    for (var j = 0; j < particles.length; j++) {
      var p = particles[j];
      var ap = Math.min(1, p.life / p.max);
      var sz = (p.size || 2.2) * ap;
      ctx.fillStyle = p.color + ap.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPowerBar() {
    if (!state.charging || !state.controlled) return;
    var p = state.controlled;
    var w = 54, h = 8;
    var x = p.x - w / 2;
    var y = p.y - PLAYER_R - 30;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

    var grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#3ddc84');
    grad.addColorStop(0.5, '#ffd60a');
    grad.addColorStop(1, '#ff3b30');

    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(255,255,255,0.7)';
    ctx.shadowBlur = 10;
    ctx.fillRect(x, y, w * state.power, h);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  }

  function drawMessages() {
    if (state.msgTimer > 0 && state.message) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, state.msgTimer * 2);
      ctx.font = 'bold 70px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = 22;
      ctx.strokeText(state.message, CX, CY - 70);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(state.message, CX, CY - 70);
      ctx.restore();
    }

    if (state.phase === 'kickoff' && state.phaseTimer > 0) {
      ctx.save();
      ctx.font = 'bold 22px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 8;
      ctx.fillText('Приготовиться...', CX, CY + 100);
      ctx.restore();
    }
  }

  function drawGoalFlash() {
    if (goalFlash <= 0) return;
    var a = goalFlash / 0.5;
    ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.35).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }

  // ---------- Рендер ----------
  function render() {
    ctx.save();

    // тряска экрана
    if (state.shake > 0.3) {
      var sx = (Math.random() - 0.5) * state.shake;
      var sy = (Math.random() - 0.5) * state.shake;
      ctx.translate(sx, sy);
    }

    // фон
    ctx.fillStyle = '#05080f';
    ctx.fillRect(-20, -20, W + 40, H + 40);

    // трибуны и щиты
    if (crowdCanvas) ctx.drawImage(crowdCanvas, 0, 0);

    // газон
    if (pitchCanvas) ctx.drawImage(pitchCanvas, 0, 0);

    // эффекты под игроками
    drawEffects();

    // тени
    for (var i = 0; i < state.players.length; i++) drawPlayerShadow(state.players[i]);
    drawBallShadow();

    // игроки
    for (var j = 0; j < state.players.length; j++) drawPlayerBody(state.players[j]);

    // мяч
    drawBall();

    // сила удара
    drawPowerBar();

    // сообщения
    drawMessages();

    // вспышка при голе
    drawGoalFlash();

    ctx.restore();
  }

  // ---------- Update ----------
  function update(dt) {
    updateEffects(dt);
    if (state.msgTimer > 0) state.msgTimer -= dt;

    if (state.phase === 'idle' || state.phase === 'ended') return;

    if (state.phase === 'goal') {
      state.phaseTimer -= dt;
      updateBallPhysics(dt);
      if (state.phaseTimer <= 0) {
        if (state.timeLeft <= 0) finishMatch();
        else {
          resetPositions();
          state.phase = 'kickoff';
          state.phaseTimer = 1.2;
        }
      }
      return;
    }

    if (state.phase === 'kickoff') {
      if (!state.lastWhistle) { sfxWhistle(); state.lastWhistle = true; }
      state.phaseTimer -= dt;
      if (state.phaseTimer <= 0) {
        state.phase = 'play';
      }
    }

    if (state.phase === 'play') {
      state.timeLeft -= dt;
      if (state.timeLeft <= 0) {
        state.timeLeft = 0;
        updateHUD();
        finishMatch();
        return;
      }
    }

    updateControlledInput(dt);
    updateAI(dt);
    integrateAll(dt);

    if (state.phase === 'play') {
      updateBallPhysics(dt);
      handleBallPlayerCollisions();
      checkGoal();
    } else {
      state.ball.x = CX;
      state.ball.y = CY;
      state.ball.vx = 0;
      state.ball.vy = 0;
    }

    updateCharge(dt);
  }

  // ---------- Цикл ----------
  var lastTime = 0;
  function loop(now) {
    if (!lastTime) lastTime = now;
    var dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;

    try {
      update(dt);
      render();
      updateHUD();
    } catch (err) {
      console.error('[FIFA] Ошибка цикла:', err);
    }

    requestAnimationFrame(loop);
  }

  // ---------- Инициализация ----------
  function init() {
    try {
      buildCrowd();
      buildPitch();
      createTeams();
      resetPositions();
      renderRecords();
      updateHUD();
      console.log('[FIFA] Готово');
      requestAnimationFrame(loop);
    } catch (err) {
      console.error('[FIFA] Ошибка инициализации:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();