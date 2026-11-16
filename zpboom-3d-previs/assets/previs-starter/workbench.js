/* ZPboom.AI · 调试工作台
   面向「拿到别的平台 / 别的机器上排查」的调试面板：
   实时读数（相机 / 说话人头部 / 气泡几何）、镜头表、台词表、
   Schema 校验、全片气泡体检、遮挡体检（3D 视线 + DOM 覆盖）、
   诊断报告导出、场景热替换。
   全部走 window.__ZPBOOM_PREVIS__ 这层公开 API，不碰引擎内部。 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = () => window.__ZPBOOM_PREVIS__ || null;

  const S = { tab: 'live', open: false, cfg: null, actors: [], scan: null, occ: null, closeup: null, scanning: false };

  /* ───────── 基础工具 ───────── */
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const tc = (t) => {
    if (!isFinite(t)) return '--:--';
    const m = Math.floor(t / 60), s = t - m * 60;
    return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  };
  const vec = (a, d) => (Array.isArray(a) ? a.map((n) => Number(n).toFixed(d === undefined ? 2 : d)).join(', ') : '-');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep0 = () => new Promise((r) => setTimeout(r, 0));

  function rectCircleHit(r, cx, cy, rad) {
    const nx = clamp(cx, r.left, r.right), ny = clamp(cy, r.top, r.bottom);
    return Math.hypot(cx - nx, cy - ny) < rad;
  }
  function rectsHit(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /* 相机右向量（世界坐标），用来量「头在屏幕上的半径」 */
  function cameraRight(st) {
    const p = (st.view && st.view.mode === 'shot' ? st.camera.position : st.view.position) || st.camera.position;
    const t = st.camera.target;
    const f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    const r = [-f[2] / fl, 0, f[0] / fl];
    const rl = Math.hypot(r[0], r[1], r[2]) || 1;
    return [r[0] / rl, r[1] / rl, r[2] / rl];
  }

  /* ───────── DOM 覆盖检测：画面上有没有被别的元素盖住 ───────── */
  function domOcclusion() {
    const stage = $('stage');
    if (!stage) return [];
    const r = stage.getBoundingClientRect();
    const pts = [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75], [.5, .08], [.5, .92], [.1, .5], [.9, .5]];
    const hits = new Map();
    for (const [fx, fy] of pts) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === stage || el.tagName === 'CANVAS') continue;
        if (el.contains && el.contains(stage)) continue; // stage 的祖先容器不算遮挡
        if (el.closest('#bubble-layer') || el.closest('.overlay')) continue;
        if (el.id === 'error' || el.id === 'helpers' || el.id === 'cue-hud') continue;
        if (el.classList && el.classList.contains('bubble')) break;
        const key = el.id ? '#' + el.id : (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName);
        hits.set(key, (hits.get(key) || 0) + 1);
        break;
      }
    }
    return [...hits.entries()].map(([what, n]) => ({ what, n }));
  }

  /* ───────── 场景快照 ───────── */
  function reloadConfig() {
    const a = api();
    if (!a) return;
    try { S.cfg = a.getConfig(); } catch (e) { S.cfg = null; }
    S.actors = (S.cfg && S.cfg.actors) || [];
  }
  function activeLines(t) {
    if (!S.cfg) return [];
    return (S.cfg.dialogues || []).filter((d) => t >= d.start && t < d.end);
  }

  /* ───────── 单点体检 ───────── */
  function inspect() {
    const a = api();
    const st = a.getState();
    const stage = $('stage').getBoundingClientRect();
    const all = [...document.querySelectorAll('#bubble-layer .bubble')];
    const vis = all.filter((el) => !el.hidden && el.offsetWidth > 0);
    const lines = activeLines(st.time);
    const right = cameraRight(st);
    const out = { time: st.time, issues: [], bubbles: [], lines };

    for (const d of lines) {
      const el = vis.find((b) => b.dataset.speaker === d.speaker);
      if (!el) {
        out.issues.push({ kind: 'missing-bubble', level: 'bad', speaker: d.speaker, msg: '有台词但没有气泡（说话人出画或气泡被隐藏）' });
        continue;
      }
      const r = el.getBoundingClientRect();
      const rec = { speaker: d.speaker, text: d.text, rect: r, shown: (el.querySelector('.line') || {}).textContent || '' };

      if (r.left < stage.left - 1 || r.right > stage.right + 1 || r.top < stage.top - 1 || r.bottom > stage.bottom + 1) {
        out.issues.push({ kind: 'out-of-frame', level: 'bad', speaker: d.speaker, msg: '气泡超出画框' });
      }
      const actor = st.actors.find((x) => x.id === d.speaker);
      if (actor && actor.head) {
        const p1 = a.screenOf(actor.head);
        const p2 = a.screenOf([actor.head[0] + right[0] * 0.16, actor.head[1] + right[1] * 0.16, actor.head[2] + right[2] * 0.16]);
        const rad = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        rec.head = { world: actor.head, screen: p1, radius: rad };
        if (rad > 0 && rectCircleHit(r, p1[0], p1[1], rad)) {
          out.issues.push({ kind: 'face-overlap', level: 'warn', speaker: d.speaker, msg: '气泡压住说话人的脸' });
        }
      }
      out.bubbles.push(rec);
    }
    for (let i = 0; i < out.bubbles.length; i++) {
      for (let j = i + 1; j < out.bubbles.length; j++) {
        if (rectsHit(out.bubbles[i].rect, out.bubbles[j].rect)) {
          out.issues.push({ kind: 'bubble-overlap', level: 'warn', speaker: out.bubbles[i].speaker + ' / ' + out.bubbles[j].speaker, msg: '两个气泡互相压叠' });
        }
      }
    }
    if (lines.length > 1) {
      out.issues.push({ kind: 'multi-speaker', level: 'warn', speaker: lines.map((d) => d.speaker).join(' / '), msg: '同一时刻有多人台词' });
    }
    return out;
  }

  /* ───────── 实时读数 ───────── */
  function renderLive(snap) {
    const a = api();
    const st = a.getState();
    const cfg = S.cfg || {};
    const shot = (cfg.shots || []).find((x) => x.id === st.shot) || {};
    const lines = activeLines(st.time);
    let h = '<dl class="wb-kv">';
    h += '<dt>时间</dt><dd>' + tc(st.time) + ' / ' + tc(st.duration) + ' <span class="muted">(' + st.fps + ' fps)</span></dd>';
    h += '<dt>镜头</dt><dd>' + esc(st.shot) + ' · ' + esc(shot.label || '-') + '</dd>';
    h += '<dt>相机</dt><dd>' + vec(st.camera.position) + ' → ' + vec(st.camera.target) + '</dd>';
    h += '<dt>视场</dt><dd>' + st.camera.fov + '° <span class="muted">视图 ' + esc(st.view.mode) + '</span></dd>';

    if (!lines.length) h += '<dt>台词</dt><dd class="muted">此刻无台词</dd>';
    for (const d of lines) {
      const done = clamp((st.time - d.start) / Math.max(0.3, d.end - d.start), 0, 1);
      h += '<dt>台词</dt><dd>' + esc(d.speaker) + '：' + esc(d.text) + '<br><span class="muted">进度 ' + Math.round(done * 100) + '%</span></dd>';
    }
    if (!snap.bubbles.length) h += '<dt>气泡</dt><dd class="' + (lines.length ? 'bad' : 'muted') + '">' + (lines.length ? '缺失' : '无') + '</dd>';
    for (const b of snap.bubbles) {
      const r = b.rect;
      const hh = b.head ? ' · 头半径 ' + b.head.radius.toFixed(0) + 'px' : '';
      h += '<dt>气泡</dt><dd>' + esc(b.speaker) + ' (' + Math.round(r.left) + ',' + Math.round(r.top) + ') ' + Math.round(r.width) + '×' + Math.round(r.height) + hh + '<br><span class="muted">已显示「' + esc(b.shown.trim()) + '」</span></dd>';
      if (b.head) h += '<dt>头部</dt><dd>世界 ' + vec(b.head.world) + '<br>屏幕 ' + Math.round(b.head.screen[0]) + ',' + Math.round(b.head.screen[1]) + '</dd>';
    }
    /* 遮挡速览 */
    let occ = [];
    try { occ = a.occlusion ? a.occlusion() : []; } catch (e) { occ = []; }
    for (const row of occ) {
      const blocked = row.points.filter((p) => p.blocked);
      const near = blocked.filter((p) => p.by.length && p.by[0].distance < 0.6);
      if (!blocked.length) h += '<dt>视线</dt><dd class="ok">' + esc(row.actor) + ' 通畅</dd>';
      else h += '<dt>视线</dt><dd class="' + (near.length ? 'bad' : 'warn') + '">' + esc(row.actor) + ' 被挡：' + esc(blocked.map((p) => p.label).join('/')) + ' ← ' + esc(blocked[0].by.map((b) => b.kind + ':' + b.id).join(', ')) + '</dd>';
    }
    const dom = domOcclusion();
    h += '<dt>画面</dt><dd class="' + (dom.length ? 'warn' : 'ok') + '">' + (dom.length ? dom.map((d) => esc(d.what) + '×' + d.n).join(' ') : '无 DOM 元素覆盖') + '</dd>';
    h += '</dl>';
    $('wb-live').innerHTML = h;
  }

  /* ───────── 镜头表 / 台词表 ───────── */
  function renderShots() {
    const cfg = S.cfg || {};
    const st = api().getState();
    const rows = (cfg.shots || []).map((s, i) => {
      const on = s.id === st.shot ? ' class="on"' : '';
      return '<tr' + on + ' data-t0="' + s.start + '" data-t1="' + s.end + '"><td class="mono">' + (i + 1) + '</td><td class="mono">' + tc(s.start) + '</td>'
        + '<td class="mono">' + (s.end - s.start).toFixed(1) + 's</td><td class="tight">' + esc(s.label || s.id) + '</td></tr>';
    }).join('');
    $('wb-shots').innerHTML = '<table class="wb-table"><thead><tr><th>#</th><th>入点</th><th>时长</th><th>标题</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function renderLines() {
    const cfg = S.cfg || {};
    const st = api().getState();
    const rows = (cfg.dialogues || []).map((d, i) => {
      const on = st.time >= d.start && st.time < d.end ? ' class="on"' : '';
      const who = (S.actors.find((a) => a.id === d.speaker) || {}).label || d.speaker;
      return '<tr' + on + ' data-t0="' + d.start + '" data-t1="' + d.end + '"><td class="mono">' + (i + 1) + '</td><td class="mono">' + tc(d.start) + '</td>'
        + '<td>' + esc(who) + '</td><td class="tight">' + esc(d.text) + '</td></tr>';
    }).join('');
    $('wb-lines').innerHTML = '<table class="wb-table"><thead><tr><th>#</th><th>入点</th><th>说话人</th><th>台词</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ───────── 体检：Schema ───────── */
  function runSchema() {
    const a = api();
    const box = $('wb-schema');
    try {
      const cfg = a.getConfig();
      a.validateConfig(cfg);
      box.innerHTML = '<div class="wb-pass">✓ Schema 通过：' + (cfg.shots || []).length + ' 镜 · '
        + (cfg.dialogues || []).length + ' 句台词 · ' + (cfg.actors || []).length + ' 角色</div>';
    } catch (e) {
      box.innerHTML = '<div class="wb-issue bad"><span class="m">' + esc(e.message) + '</span></div>';
    }
  }

  /* ───────── 体检：全片气泡 ───────── */
  async function runScan() {
    const a = api();
    if (!a || S.scanning) return;
    const step = parseFloat($('wb-step').value) || 0.25;
    const dur = a.getState().duration;
    const keep = a.getState().time;
    S.scanning = true;
    $('wb-scan').disabled = true;
    const agg = new Map();
    let samples = 0, withBubble = 0;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      a.seek(Math.min(t, dur));
      const snap = inspect();
      samples++;
      if (snap.bubbles.length) withBubble++;
      for (const is of snap.issues) {
        const key = is.kind + '|' + is.speaker;
        if (!agg.has(key)) agg.set(key, Object.assign({}, is, { first: t, last: t, count: 0 }));
        const rec = agg.get(key); rec.last = t; rec.count++;
      }
      $('wb-scan-bar').style.width = ((t / dur) * 100).toFixed(1) + '%';
      $('wb-scan-tip').textContent = '扫描中 ' + t.toFixed(1) + ' / ' + dur.toFixed(1) + ' s';
      if (samples % 12 === 0) await sleep0();
    }
    a.seek(keep);
    S.scanning = false;
    $('wb-scan').disabled = false;
    const issues = [...agg.values()].sort((x, y) => x.first - y.first);
    S.scan = { samples, withBubble, step, issues, duration: dur, at: new Date().toISOString() };
    const box = $('wb-scan-out');
    if (!issues.length) {
      box.innerHTML = '<div class="wb-pass">✓ 全片 ' + samples + ' 采样点（步长 ' + step + 's）：' + withBubble + ' 点带气泡，0 个问题</div>';
    } else {
      box.innerHTML = '<div class="wb-counts"><span>采样 <b>' + samples + '</b></span><span>带气泡 <b>' + withBubble + '</b></span><span>问题 <b>' + issues.length + '</b></span></div>'
        + issues.map((is) => '<div class="wb-issue ' + is.level + '"><span class="t">' + tc(is.first) + '</span><span class="m">'
          + '<b>' + esc(is.kind) + '</b> · ' + esc(is.speaker || '') + ' — ' + esc(is.msg)
          + '（' + is.count + ' 点，' + tc(is.first) + '–' + tc(is.last) + '）</span></div>').join('');
    }
    $('wb-export-json').disabled = false;
    $('wb-export-md').disabled = false;
  }

  /* ───────── 体检：遮挡（3D 视线 + DOM） ───────── */
  async function runOcclusion() {
    const a = api();
    if (!a || S.scanning || !a.occlusion) return;
    const cfg = S.cfg || a.getConfig();
    const shots = cfg.shots || [];
    const keep = a.getState().time;
    S.scanning = true;
    $('wb-occ').disabled = true;
    const rows = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      a.seek((s.start + s.end) / 2);
      let rep = [];
      try { rep = a.occlusion(); } catch (e) { rep = []; }
      for (const row of rep) {
        for (const p of row.points) {
          if (!p.blocked) continue;
          const first = p.by[0] || { kind: '?', id: '?', distance: 0 };
          const stuck = first.distance < 0.6;
          rows.push({
            shot: s.id, label: s.label, at: (s.start + s.end) / 2, actor: row.actor,
            part: p.label, by: first.kind + ':' + first.id, dist: first.distance,
            kind: stuck ? 'camera-inside' : 'occluded',
            level: stuck ? 'bad' : 'warn',
            msg: stuck ? '相机贴住/陷进模型内部（穿模）' : '视线被「' + first.kind + ':' + first.id + '」挡住',
          });
        }
      }
      $('wb-occ-bar').style.width = (((i + 1) / shots.length) * 100).toFixed(1) + '%';
      $('wb-occ-tip').textContent = '检查 ' + (i + 1) + ' / ' + shots.length + ' 镜';
      if (i % 6 === 0) await sleep0();
    }
    a.seek(keep);
    S.scanning = false;
    $('wb-occ').disabled = false;
    const dom = domOcclusion();
    S.occ = { rows, dom, shots: shots.length, at: new Date().toISOString() };
    const box = $('wb-occ-out');
    let h = '';
    if (!rows.length) h += '<div class="wb-pass">✓ ' + shots.length + ' 镜的相机视线全部通畅，无穿模</div>';
    else {
      h += '<div class="wb-counts"><span>镜头 <b>' + shots.length + '</b></span><span>遮挡 <b>' + rows.length + '</b></span></div>';
      h += rows.map((r) => '<div class="wb-issue ' + r.level + '"><span class="t">' + tc(r.at) + '</span><span class="m">'
        + '<b>' + esc(r.shot) + '</b> ' + esc(r.label || '') + ' — ' + esc(r.msg)
        + '（被挡方 ' + esc(r.actor) + '·' + esc(r.part) + '，距离 ' + r.dist.toFixed(2) + ' m）</span></div>').join('');
    }
    if (dom.length) {
      h += '<div class="wb-issue warn"><span class="m"><b>DOM 覆盖</b> — 画面上被 ' + dom.map((d) => esc(d.what) + '×' + d.n).join('、') + ' 压住</span></div>';
    }
    box.innerHTML = h;
  }

  /* ───────── 体检：近景压脸元素（名牌 Sprite / 弧形眼带） ─────────
     分镜被"贴在脸上的元素"盖住，肉眼很难逐镜发现：
     角色名牌是 Sprite，永远压在画面最上层，特写时正中脸；
     白膜人偶的弧形眼带在近景是横贯面门的一条实心亮带。
     这里逐镜读引擎的屏幕空间判定，把这两类问题挑出来。 */
  async function runCloseup() {
    const a = api();
    if (!a || S.scanning || !a.overlays) return;
    const cfg = S.cfg || a.getConfig();
    const shots = cfg.shots || [];
    const keep = a.getState().time;
    S.scanning = true;
    $('wb-closeup').disabled = true;
    const rows = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const at = (s.start + s.end) / 2;
      a.seek(at);
      let list = [];
      try { list = a.overlays(); } catch (e) { list = []; }
      for (const o of list) {
        // 名牌只要压到脸上就是问题，不看景别
        if (o.nameplateOverlap) {
          rows.push({ shot: s.id, label: s.label, at, actor: o.actor, level: 'bad',
            msg: '角色名牌会压在脸上（头占屏 ' + (o.headFrac * 100).toFixed(0) + '%）' });
        }
        // 眼带只有在「真的有分量」时才算问题：头占屏超过 25% 才叫特写，
        // 这时它还保持实心就说明淡出逻辑没生效；头占屏 11–17% 的中近景里
        // 那只是一条细视线线，不必报。
        if (o.headFrac > 0.25 && o.bandOpacity != null && o.bandOpacity > 0.5) {
          rows.push({ shot: s.id, label: s.label, at, actor: o.actor, level: 'warn',
            msg: '特写里弧形眼带仍横贯面门且过实（opacity ' + o.bandOpacity.toFixed(2) + '，头占屏 ' + (o.headFrac * 100).toFixed(0) + '%）' });
        }
      }
      $('wb-closeup-bar').style.width = (((i + 1) / shots.length) * 100).toFixed(1) + '%';
      $('wb-closeup-tip').textContent = '检查 ' + (i + 1) + ' / ' + shots.length + ' 镜';
      if (i % 6 === 0) await sleep0();
    }
    a.seek(keep);
    S.scanning = false;
    $('wb-closeup').disabled = false;
    S.closeup = { rows, shots: shots.length, at: new Date().toISOString() };
    const box = $('wb-closeup-out');
    let h = '';
    if (!rows.length) h += '<div class="wb-pass">✓ ' + shots.length + ' 镜的近景均无压脸元素（名牌自动收起 / 眼带已淡出）</div>';
    else {
      h += '<div class="wb-counts"><span>镜头 <b>' + shots.length + '</b></span><span>压脸 <b>' + rows.length + '</b></span></div>';
      h += rows.map((r) => '<div class="wb-issue ' + r.level + '"><span class="t">' + tc(r.at) + '</span><span class="m">'
        + '<b>' + esc(r.shot) + '</b> ' + esc(r.label || '') + ' — ' + esc(r.msg) + '（' + esc(r.actor) + '）</span></div>').join('');
    }
    box.innerHTML = h;
  }

  /* ───────── 报告 ───────── */
  function reportJSON() {
    const a = api();
    const st = a.getState();
    const cfg = a.getConfig();
    return {
      generatedAt: new Date().toISOString(),
      platform: navigator.userAgent,
      threeRevision: a.threeRevision,
      scene: { duration: st.duration, fps: st.fps, shots: (cfg.shots || []).length, actors: (cfg.actors || []).length, dialogues: (cfg.dialogues || []).length },
      bubbleScan: S.scan, occlusion: S.occ, closeup: S.closeup,
      shots: (cfg.shots || []).map((s) => ({ id: s.id, label: s.label, start: s.start, end: s.end, fov: s.camera && s.camera.fov })),
      dialogues: (cfg.dialogues || []).map((d) => ({ speaker: d.speaker, text: d.text, start: d.start, end: d.end })),
    };
  }
  function reportMD() {
    const r = reportJSON();
    const L = ['# 3D 预演诊断报告', '',
      '- 生成时间：' + r.generatedAt,
      '- 浏览器：' + r.platform,
      '- Three.js：r' + r.threeRevision,
      '- 时长 ' + r.scene.duration + ' s · ' + r.scene.fps + ' fps · ' + r.scene.shots + ' 镜 · ' + r.scene.actors + ' 角色 · ' + r.scene.dialogues + ' 句台词', ''];
    if (r.bubbleScan) {
      L.push('## 全片气泡体检', '', '- 步长 ' + r.bubbleScan.step + ' s，采样 ' + r.bubbleScan.samples + ' 点，其中 ' + r.bubbleScan.withBubble + ' 点带气泡', '- 问题 ' + r.bubbleScan.issues.length + ' 项', '');
      if (r.bubbleScan.issues.length) {
        L.push('| 类型 | 级别 | 说话人 | 时间 | 次数 | 说明 |', '| --- | --- | --- | --- | --- | --- |');
        for (const is of r.bubbleScan.issues) L.push('| ' + is.kind + ' | ' + is.level + ' | ' + (is.speaker || '') + ' | ' + tc(is.first) + '–' + tc(is.last) + ' | ' + is.count + ' | ' + is.msg + ' |');
        L.push('');
      }
    }
    if (r.occlusion) {
      L.push('## 遮挡 / 穿模体检', '', '- 检查 ' + r.occlusion.shots + ' 镜，问题 ' + r.occlusion.rows.length + ' 项', '');
      if (r.occlusion.rows.length) {
        L.push('| 镜头 | 标题 | 时间 | 主体 | 被挡方 | 遮挡物 | 距离 | 说明 |', '| --- | --- | --- | --- | --- | --- | --- |');
        for (const x of r.occlusion.rows) L.push('| ' + x.shot + ' | ' + (x.label || '') + ' | ' + tc(x.at) + ' | ' + x.actor + '·' + x.part + ' | ' + x.by + ' | ' + x.dist.toFixed(2) + ' m | ' + x.msg + ' |');
        L.push('');
      }
      if (r.occlusion.dom && r.occlusion.dom.length) L.push('- DOM 覆盖：' + r.occlusion.dom.map((d) => d.what + '×' + d.n).join('、'), '');
    }
    L.push('## 镜头表', '', '| # | 入点 | 时长 | 标题 | FOV |', '| --- | --- | --- | --- | --- |');
    r.shots.forEach((s, i) => L.push('| ' + (i + 1) + ' | ' + tc(s.start) + ' | ' + (s.end - s.start).toFixed(1) + 's | ' + s.label + ' | ' + s.fov + '° |'));
    L.push('', '## 台词表', '', '| # | 入点 | 说话人 | 台词 |', '| --- | --- | --- | --- |');
    r.dialogues.forEach((d, i) => L.push('| ' + (i + 1) + ' | ' + tc(d.start) + ' | ' + d.speaker + ' | ' + d.text + ' |'));
    return L.join('\n');
  }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  /* ───────── 场景热替换 ───────── */
  async function loadFile(file) {
    try {
      const raw = JSON.parse(await file.text());
      await api().loadConfig(raw);
      reloadConfig(); buildTables(); runSchema();
      $('wb-msg').textContent = '已载入 ' + file.name + '（' + (S.cfg.shots || []).length + ' 镜 / ' + (S.cfg.dialogues || []).length + ' 句台词）';
    } catch (e) {
      $('wb-msg').textContent = '载入失败：' + e.message;
    }
  }

  function buildTables() { renderShots(); renderLines(); }

  /* ───────── 主循环 ───────── */
  let lastPaint = 0;
  function tick(now) {
    requestAnimationFrame(tick);
    if (!api() || !S.open) return;
    if (now - lastPaint < 130) return;
    lastPaint = now;
    try {
      renderLive(inspect());
      const st = api().getState();
      for (const tr of $('wb-shots').querySelectorAll('tr')) {
        const t0 = parseFloat(tr.dataset.t0), t1 = parseFloat(tr.dataset.t1);
        tr.classList.toggle('on', st.time >= t0 && st.time < t1);
      }
      for (const tr of $('wb-lines').querySelectorAll('tr')) {
        const t0 = parseFloat(tr.dataset.t0), t1 = parseFloat(tr.dataset.t1);
        tr.classList.toggle('on', st.time >= t0 && st.time < t1);
      }
    } catch (e) { /* 引擎未就绪时忽略 */ }
  }

  /* ───────── 启动 ───────── */
  function boot() {
    reloadConfig();
    buildTables();
    runSchema();
    const ver = $('wb-ver');
    if (ver && api().threeRevision) ver.textContent = 'three r' + api().threeRevision;

    $('wb-toggle').addEventListener('click', () => toggle());
    $('wb-close').addEventListener('click', () => toggle(false));
    for (const b of document.querySelectorAll('[data-wb-tab]')) {
      b.addEventListener('click', () => {
        S.tab = b.dataset.wbTab;
        for (const x of document.querySelectorAll('[data-wb-tab]')) x.classList.toggle('on', x === b);
        for (const p of document.querySelectorAll('[data-wb-pane]')) p.hidden = p.dataset.wbPane !== S.tab;
        if (S.tab === 'shots') renderShots();
        if (S.tab === 'lines') renderLines();
        if (S.tab === 'check') { runSchema(); renderLive(inspect()); }
      });
    }
    $('wb-schema-run').addEventListener('click', runSchema);
    $('wb-scan').addEventListener('click', runScan);
    $('wb-occ').addEventListener('click', runOcclusion);
    $('wb-closeup').addEventListener('click', runCloseup);
    $('wb-export-json').addEventListener('click', () => download('预演诊断报告.json', JSON.stringify(reportJSON(), null, 2), 'application/json'));
    $('wb-export-md').addEventListener('click', () => download('预演诊断报告.md', reportMD(), 'text/markdown'));
    $('wb-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
    $('wb-shots').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-t0]');
      if (tr) { api().seek(parseFloat(tr.dataset.t0)); renderShots(); renderLines(); }
    });
    $('wb-lines').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-t0]');
      if (tr) { api().seek(parseFloat(tr.dataset.t0)); renderLines(); renderShots(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches && e.target.matches('input, textarea, select')) return;
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); toggle(); }
    });
    requestAnimationFrame(tick);
  }

  function toggle(force) {
    S.open = force === undefined ? !S.open : force;
    $('workbench').hidden = !S.open;
    $('wb-toggle').classList.toggle('active', S.open);
    if (S.open) { reloadConfig(); buildTables(); if (S.tab === 'check') { runSchema(); renderLive(inspect()); } }
  }

  const wait = setInterval(() => {
    if (api() && api().ready) { clearInterval(wait); boot(); }
  }, 120);
})();
