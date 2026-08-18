/*!
 * game.js - ミニゲーム「シュートアウト」
 * 左右に動く狙いマーカーをタップで止めて、ゴーリーのいないコースに撃ち込む。全5本。
 */
(function (global) {
  'use strict';

  var W = 640, H = 440;
  var GOAL = { left: 176, right: 464, top: 74, bottom: 246 };
  var SHOTS_PER_GAME = 5;

  function LacrosseGame(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks || {};
    this.raf = null;
    this.state = 'idle';       // idle | aiming | flying | result | over
    this.shots = 0;
    this.goals = 0;
    this.t = 0;
    this.aimX = (GOAL.left + GOAL.right) / 2;
    this.aimDir = 1;
    this.goalieX = (GOAL.left + GOAL.right) / 2;
    this.goaliePhase = 0;
    this.ball = null;
    this.flash = null;
    this.particles = [];
    this._resize();

    var self = this;
    this._onTap = function (e) {
      e.preventDefault();
      self.tap();
    };
    canvas.addEventListener('pointerdown', this._onTap);
    canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
  }

  LacrosseGame.prototype._resize = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.aspectRatio = W + ' / ' + H;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  LacrosseGame.prototype.destroy = function () {
    this.stop();
    this.canvas.removeEventListener('pointerdown', this._onTap);
  };

  /** 画面を開いたときに呼ぶ。タイトル表示のまま待機し、タップでゲームが始まる。 */
  LacrosseGame.prototype.attach = function () {
    if (this.state !== 'aiming' && this.state !== 'flying' && this.state !== 'result') {
      this.state = 'idle';
    }
    if (!this.raf) this._loop();
  };

  LacrosseGame.prototype.start = function () {
    this.shots = 0;
    this.goals = 0;
    this.particles = [];
    this.flash = null;
    this._nextShot();
    this._emit();
    this._loop();
  };

  LacrosseGame.prototype.stop = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  };

  LacrosseGame.prototype._difficulty = function () {
    // ショットを重ねるほど狙いもゴーリーも速くなる
    return 1 + this.shots * 0.22;
  };

  LacrosseGame.prototype._nextShot = function () {
    this.state = 'aiming';
    this.ball = null;
    this.aimX = GOAL.left + 30;
    this.aimDir = 1;
    this.goaliePhase = Math.random() * Math.PI * 2;
  };

  LacrosseGame.prototype.tap = function () {
    if (this.state === 'idle' || this.state === 'over') {
      this.start();
      return;
    }
    if (this.state !== 'aiming') return;

    // 狙いを固定してシュート
    this.state = 'flying';
    var targetY = GOAL.top + 40 + Math.random() * (GOAL.bottom - GOAL.top - 90);
    this.ball = {
      x: W / 2, y: H - 62,
      x0: W / 2, y0: H - 62,
      tx: this.aimX, ty: targetY,
      p: 0,
      speed: 0.055 + this._difficulty() * 0.004
    };
  };

  LacrosseGame.prototype._judge = function () {
    var half = this._goalieHalfWidth();
    var hit = Math.abs(this.goalieX - this.ball.tx) < half + 12;
    // ゴール枠のギリギリ外は「枠外」扱い
    var inFrame = this.ball.tx > GOAL.left + 8 && this.ball.tx < GOAL.right - 8;

    this.shots++;
    if (!inFrame) {
      this.flash = { text: 'わく外…', color: '#ffd166', until: 1 };
    } else if (hit) {
      this.flash = { text: 'セーブ！', color: '#ff8f85', until: 1 };
    } else {
      this.goals++;
      this.flash = { text: 'ゴール！！', color: '#c9f24d', until: 1 };
      this._burst(this.ball.tx, this.ball.ty);
    }
    this.state = 'result';
    this.resultTimer = 0;
    this._emit();
  };

  LacrosseGame.prototype._burst = function (x, y) {
    for (var i = 0; i < 22; i++) {
      var a = Math.random() * Math.PI * 2;
      var s = 1.5 + Math.random() * 4;
      this.particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1 });
    }
  };

  LacrosseGame.prototype._goalieHalfWidth = function () { return 34; };

  LacrosseGame.prototype._emit = function () {
    if (this.hooks.onUpdate) this.hooks.onUpdate({ shots: this.shots, goals: this.goals });
  };

  LacrosseGame.prototype._loop = function () {
    var self = this;
    this.raf = requestAnimationFrame(function () { self._loop(); });
    this._update();
    this._draw();
  };

  LacrosseGame.prototype._update = function () {
    this.t += 1 / 60;
    var d = this._difficulty();

    // ゴーリーは往復（少しだけ揺らぎを入れる）
    this.goaliePhase += 0.026 * d;
    var span = (GOAL.right - GOAL.left) / 2 - this._goalieHalfWidth() - 6;
    var mid = (GOAL.left + GOAL.right) / 2;
    this.goalieX = mid + Math.sin(this.goaliePhase) * span + Math.sin(this.goaliePhase * 2.7) * 10;

    if (this.state === 'aiming') {
      this.aimX += this.aimDir * 4.2 * d;
      if (this.aimX > GOAL.right - 22) { this.aimX = GOAL.right - 22; this.aimDir = -1; }
      if (this.aimX < GOAL.left + 22) { this.aimX = GOAL.left + 22; this.aimDir = 1; }
    }

    if (this.state === 'flying' && this.ball) {
      this.ball.p += this.ball.speed;
      if (this.ball.p >= 1) { this.ball.p = 1; this._judge(); }
      else {
        this.ball.x = this.ball.x0 + (this.ball.tx - this.ball.x0) * this.ball.p;
        this.ball.y = this.ball.y0 + (this.ball.ty - this.ball.y0) * this.ball.p;
      }
    }

    if (this.state === 'result') {
      this.resultTimer += 1 / 60;
      if (this.resultTimer > 1.05) {
        if (this.shots >= SHOTS_PER_GAME) {
          this.state = 'over';
          if (this.hooks.onEnd) this.hooks.onEnd({ goals: this.goals, shots: this.shots });
        } else {
          this._nextShot();
        }
      }
    }

    if (this.flash) {
      this.flash.until -= 1 / 60;
      if (this.flash.until <= 0) this.flash = null;
    }

    for (var i = this.particles.length - 1; i >= 0; i--) {
      var p = this.particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.16; p.life -= 0.022;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  };

  /* ------------------------------- 描画 ------------------------------- */

  LacrosseGame.prototype._draw = function () {
    var c = this.ctx;
    c.clearRect(0, 0, W, H);

    this._drawField(c);
    this._drawGoal(c);
    this._drawGoalie(c);
    this._drawPlayer(c);

    if (this.state === 'aiming') this._drawAim(c);
    if (this.ball && this.state === 'flying') this._drawBall(c);

    this._drawParticles(c);
    this._drawOverlay(c);
  };

  LacrosseGame.prototype._drawField = function (c) {
    var g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0f3a20');
    g.addColorStop(1, '#1f6b38');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    // 芝のストライプ
    c.save();
    c.globalAlpha = 0.07;
    c.fillStyle = '#ffffff';
    for (var i = 0; i < 8; i++) {
      if (i % 2 === 0) c.fillRect(0, 60 + i * 48, W, 48);
    }
    c.restore();

    // クリース（ゴール前の円）
    c.strokeStyle = 'rgba(255,255,255,.45)';
    c.lineWidth = 3;
    c.beginPath();
    c.ellipse(W / 2, GOAL.bottom - 6, 150, 46, 0, 0, Math.PI);
    c.stroke();
  };

  LacrosseGame.prototype._drawGoal = function (c) {
    var l = GOAL.left, r = GOAL.right, t = GOAL.top, b = GOAL.bottom;

    // ネット
    c.save();
    c.beginPath();
    c.rect(l, t, r - l, b - t);
    c.clip();
    c.fillStyle = 'rgba(6,26,14,.55)';
    c.fillRect(l, t, r - l, b - t);
    c.strokeStyle = 'rgba(255,255,255,.28)';
    c.lineWidth = 1;
    for (var x = l; x <= r; x += 14) { c.beginPath(); c.moveTo(x, t); c.lineTo(x + 18, b); c.stroke(); }
    for (var x2 = l - 20; x2 <= r + 20; x2 += 14) { c.beginPath(); c.moveTo(x2, b); c.lineTo(x2 + 18, t); c.stroke(); }
    c.restore();

    // ゴールポスト
    c.strokeStyle = '#ffffff';
    c.lineWidth = 9;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(l, b); c.lineTo(l, t); c.lineTo(r, t); c.lineTo(r, b);
    c.stroke();
  };

  LacrosseGame.prototype._drawGoalie = function (c) {
    var x = this.goalieX;
    var y = GOAL.bottom - 16;
    var hw = this._goalieHalfWidth();

    c.save();
    // 影
    c.fillStyle = 'rgba(0,0,0,.28)';
    c.beginPath(); c.ellipse(x, y + 10, hw, 9, 0, 0, Math.PI * 2); c.fill();

    // 体
    c.fillStyle = '#ff6b5e';
    c.beginPath();
    c.roundRect(x - hw, y - 78, hw * 2, 78, 12);
    c.fill();

    // 頭
    c.fillStyle = '#ffe0c4';
    c.beginPath(); c.arc(x, y - 92, 15, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)';
    c.fillRect(x - 15, y - 98, 30, 6);

    // クロス（スティック）
    c.strokeStyle = '#f4d9a0';
    c.lineWidth = 5;
    c.beginPath(); c.moveTo(x + hw - 4, y - 30); c.lineTo(x + hw + 26, y - 96); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.9)';
    c.beginPath(); c.ellipse(x + hw + 30, y - 104, 12, 16, .5, 0, Math.PI * 2); c.fill();
    c.restore();
  };

  LacrosseGame.prototype._drawPlayer = function (c) {
    var x = W / 2, y = H - 34;
    c.save();
    c.fillStyle = 'rgba(0,0,0,.3)';
    c.beginPath(); c.ellipse(x, y + 6, 30, 8, 0, 0, Math.PI * 2); c.fill();

    c.fillStyle = '#0b1633';
    c.beginPath(); c.roundRect(x - 22, y - 58, 44, 58, 10); c.fill();
    c.fillStyle = '#ffe0c4';
    c.beginPath(); c.arc(x, y - 72, 14, 0, Math.PI * 2); c.fill();

    c.strokeStyle = '#f4d9a0';
    c.lineWidth = 5;
    c.beginPath(); c.moveTo(x + 16, y - 34); c.lineTo(x + 44, y - 88); c.stroke();
    c.fillStyle = '#c9f24d';
    c.beginPath(); c.ellipse(x + 47, y - 95, 11, 15, .5, 0, Math.PI * 2); c.fill();
    c.restore();
  };

  LacrosseGame.prototype._drawAim = function (c) {
    var x = this.aimX, y = GOAL.bottom + 26;
    c.save();
    c.strokeStyle = 'rgba(201,242,77,.5)';
    c.setLineDash([6, 8]);
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, GOAL.top + 20); c.stroke();
    c.setLineDash([]);

    c.strokeStyle = '#c9f24d';
    c.lineWidth = 4;
    c.beginPath(); c.arc(x, y, 16, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fillStyle = '#c9f24d'; c.fill();
    c.restore();
  };

  LacrosseGame.prototype._drawBall = function (c) {
    var b = this.ball;
    c.save();
    // 軌跡
    c.strokeStyle = 'rgba(255,255,255,.35)';
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(b.x0, b.y0); c.lineTo(b.x, b.y); c.stroke();

    var r = 12 - 5 * b.p;
    c.fillStyle = '#ffffff';
    c.beginPath(); c.arc(b.x, b.y, r, 0, Math.PI * 2); c.fill();
    c.restore();
  };

  LacrosseGame.prototype._drawParticles = function (c) {
    c.save();
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      c.globalAlpha = Math.max(p.life, 0);
      c.fillStyle = '#c9f24d';
      c.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    c.restore();
  };

  LacrosseGame.prototype._drawOverlay = function (c) {
    c.save();
    c.textAlign = 'center';

    if (this.state === 'idle') {
      c.fillStyle = 'rgba(11,22,51,.6)';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#fff';
      c.font = '800 34px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillText('シュートアウト', W / 2, H / 2 - 16);
      c.font = '700 18px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillStyle = '#c9f24d';
      c.fillText('タップしてスタート', W / 2, H / 2 + 22);
    }

    if (this.state === 'aiming') {
      c.fillStyle = 'rgba(255,255,255,.85)';
      c.font = '700 17px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillText('タップでシュート！', W / 2, H - 8);
    }

    if (this.flash) {
      c.globalAlpha = Math.min(1, this.flash.until * 2.2);
      c.fillStyle = this.flash.color;
      c.font = '800 46px "Hiragino Kaku Gothic ProN", sans-serif';
      c.strokeStyle = 'rgba(11,22,51,.75)';
      c.lineWidth = 8;
      c.strokeText(this.flash.text, W / 2, H / 2 - 30);
      c.fillText(this.flash.text, W / 2, H / 2 - 30);
      c.globalAlpha = 1;
    }

    if (this.state === 'over') {
      c.fillStyle = 'rgba(11,22,51,.72)';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#fff';
      c.font = '800 30px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillText('結果', W / 2, H / 2 - 54);
      c.fillStyle = '#c9f24d';
      c.font = '800 58px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillText(this.goals + ' / ' + SHOTS_PER_GAME, W / 2, H / 2 + 8);
      c.fillStyle = '#fff';
      c.font = '700 17px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillText(rank(this.goals), W / 2, H / 2 + 42);
      c.fillStyle = 'rgba(255,255,255,.8)';
      c.font = '700 15px "Hiragino Kaku Gothic ProN", sans-serif';
      c.fillText('タップでもう一度', W / 2, H / 2 + 74);
    }
    c.restore();
  };

  function rank(goals) {
    if (goals >= 5) return '完璧！エースアタッカー 🏆';
    if (goals === 4) return 'すごい！スタメン級 🔥';
    if (goals === 3) return 'ナイスシュート！ 👍';
    if (goals === 2) return 'いい感じ、あと一歩！';
    if (goals === 1) return '当日は現地で応援しよう！';
    return 'ドンマイ！ゴーリーが強すぎた…';
  }

  // roundRect が無い環境向けの補完
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      var rr = Math.min(r, w / 2, h / 2);
      this.moveTo(x + rr, y);
      this.arcTo(x + w, y, x + w, y + h, rr);
      this.arcTo(x + w, y + h, x, y + h, rr);
      this.arcTo(x, y + h, x, y, rr);
      this.arcTo(x, y, x + w, y, rr);
      this.closePath();
      return this;
    };
  }

  global.LacrosseGame = LacrosseGame;
  global.LacrosseGame.SHOTS = SHOTS_PER_GAME;
  global.LacrosseGame.rank = rank;
})(window);
