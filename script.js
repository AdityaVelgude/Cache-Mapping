// ===== Cache Memory Mapping Simulator =====
function $(id){ return document.getElementById(id); }

let cache = [], fifo = [], cfgKey = '', plan = null, shown = 0;
let stats = { h: 0, m: 0 }, history = [];

const isPow2 = n => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
const lg = n => Math.log2(n);
const bin = (n, w) => n.toString(2).padStart(Math.max(w, 1), '0');

// Read + validate inputs. Returns config object or null (and shows error).
function readConfig() {
  const mem = +$('mem').value, cs = +$('cache').value, bs = +$('block').value;
  const mode = $('mode').value, k = +$('ways').value, raw = $('addr').value.trim();
  const addr = Number(raw);
  const fail = m => { $('error').textContent = '⚠ ' + m; return null; };
  $('error').textContent = '';
  if (![mem, cs, bs].every(isPow2)) return fail('Memory, cache and block size must be powers of 2 (e.g. 16, 32, 64).');
  if (bs > cs || cs > mem) return fail('Required: Block Size ≤ Cache Size ≤ Main Memory Size.');
  const lines = cs / bs;
  if (mode === 'set' && k > lines) return fail('Ways (' + k + ') cannot exceed number of cache lines (' + lines + ').');
  if (raw === '' || !Number.isInteger(addr) || addr < 0 || addr >= mem) return fail('Address must be an integer from 0 to ' + (mem - 1) + '.');
  const ways = mode === 'direct' ? 1 : mode === 'assoc' ? lines : k;
  return { mem, cs, bs, mode, lines, ways, sets: lines / ways, addr };
}

function initCache(c) {
  cache = Array.from({ length: c.lines }, () => ({ valid: false, tag: 0, block: 0 }));
  fifo = Array(c.sets).fill(0);
  stats = { h: 0, m: 0 }; history = []; plan = null; shown = 0;
}

// Build the whole calculation (does NOT change the cache yet).
function buildPlan(c) {
  const addrBits = lg(c.mem), offBits = lg(c.bs), setBits = lg(c.sets);
  const tagBits = addrBits - offBits - setBits;
  const block = Math.floor(c.addr / c.bs), off = c.addr % c.bs;
  const set = block % c.sets, tag = Math.floor(block / c.sets);
  const base = set * c.ways;
  let way = -1;
  for (let w = 0; w < c.ways; w++) if (cache[base + w].valid && cache[base + w].tag === tag) way = w;
  const hit = way >= 0;
  if (!hit) { // choose victim: first empty line, else FIFO
    way = 0;
    let free = -1;
    for (let w = 0; w < c.ways; w++) if (!cache[base + w].valid) { free = w; break; }
    way = free >= 0 ? free : fifo[set];
  }
  const bits = bin(c.addr, addrBits);
  const T = bits.slice(0, tagBits), S = bits.slice(tagBits, tagBits + setBits), O = bits.slice(tagBits + setBits);
  const where = c.mode === 'direct' ? 'Index' : 'Set';
  const p = { c, addrBits, offBits, setBits, tagBits, block, off, set, tag, base, way, hit, line: base + way, bits: { T, S, O } };

  const colored = `<span class="bits"><span class="t">${T || '-'}</span><span class="s">${S || '-'}</span><span class="o">${O}</span></span>`;
  p.steps = [
    { t: 'Step 1: Split the address', h:
      `<p>Memory = ${c.mem} B → <b>${addrBits}</b> address bits. Block = ${c.bs} B → <b>${offBits}</b> offset bits.</p>
       <p>Address ${c.addr} = <code>${bits}</code></p>
       <p>${colored} &nbsp;(<b>Tag</b> ${tagBits} | <b>${where}</b> ${setBits} | <b>Offset</b> ${offBits})</p>
       <p class="why">Why: the CPU address is divided into fields; each field has a job.</p>` },
    { t: 'Step 2: Offset (byte inside block)', h:
      `<p>Offset = Address mod Block Size = ${c.addr} mod ${c.bs} = <b>${off}</b> (binary ${O || '-'})</p>
       <p class="why">Why: tells which byte inside the block the CPU wants.</p>` },
    { t: 'Step 3: Block Number', h:
      `<p>Block No = Address ÷ Block Size = ⌊${c.addr} / ${c.bs}⌋ = <b>${block}</b></p>
       <p class="why">Why: memory is moved to cache in whole blocks, not single bytes. Total blocks in memory = ${c.mem / c.bs}.</p>` },
    c.mode === 'direct' ? { t: 'Step 4: Cache Index', h:
      `<p>Index = Block No mod Cache Lines = ${block} mod ${c.lines} = <b>${set}</b></p>
       <p class="why">Why: in direct mapping the block can live in only this one cache line.</p>` }
    : c.mode === 'assoc' ? { t: 'Step 4: Cache location', h:
      `<p>No index needed. The block may be placed in <b>any of the ${c.lines} lines</b>, so every line must be searched.</p>
       <p class="why">Why: fully associative = most flexible, but needs a comparator for every line.</p>` }
    : { t: 'Step 4: Cache Set', h:
      `<p>Sets = Lines ÷ Ways = ${c.lines} / ${c.ways} = ${c.sets}</p>
       <p>Set = Block No mod Sets = ${block} mod ${c.sets} = <b>${set}</b></p>
       <p class="why">Why: block goes to this set, but may use any of its ${c.ways} lines.</p>` },
    { t: 'Step 5: Tag', h: c.mode === 'assoc'
      ? `<p>Tag = Block No = <b>${tag}</b> (binary ${T})</p><p class="why">Why: with no index bits, the whole block number identifies the block.</p>`
      : `<p>Tag = ⌊Block No / ${c.sets}⌋ = ⌊${block} / ${c.sets}⌋ = <b>${tag}</b> (binary ${T || '-'})</p>
         <p class="why">Why: many blocks share the same ${where.toLowerCase()}; the tag tells which one is stored.</p>` },
    { t: 'Step 6: Compare tag → HIT or MISS', last: true, h: '' }
  ];
  const look = c.mode === 'direct' ? `line ${set}` : c.mode === 'assoc' ? 'all lines' : `lines of set ${set}`;
  const victim = cache[p.line].valid
    ? `Line ${p.line} was full (held block ${cache[p.line].block}) → replaced using FIFO.`
    : `Line ${p.line} was empty → block loaded there.`;
  p.steps[5].h = hit
    ? `<p>Checked ${look}: valid bit = 1 and stored tag = ${tag} matches → <b>HIT ✔</b> in line ${p.line}.</p><p class="why">Data is read directly from cache (fast).</p>`
    : `<p>Checked ${look}: no valid line with tag ${tag} → <b>MISS ✘</b>.</p><p>Block ${block} is fetched from main memory. ${victim}</p><p class="why">Next access to this block will be a HIT.</p>`;
  return p;
}

// Apply the cache update (called on the last step).
function applyPlan() {
  const p = plan, c = p.c;
  if (p.hit) stats.h++;
  else {
    cache[p.line] = { valid: true, tag: p.tag, block: p.block };
    if (cache[p.line] && c.ways > 1) fifo[p.set] = (p.way + 1) % c.ways;
    stats.m++;
  }
  history.unshift(`Addr ${c.addr} → Block ${p.block}, ${c.mode === 'direct' ? 'Index' : 'Set'} ${p.set}, Tag ${p.tag} → ${p.hit ? 'HIT' : 'MISS'}`);
  p.done = true;
}

function prepare() {
  const c = readConfig();
  if (!c) return false;
  const key = [c.mem, c.cs, c.bs, c.mode, c.ways].join('|');
  if (key !== cfgKey) { cfgKey = key; initCache(c); }
  plan = buildPlan(c); shown = 0;
  return true;
}

function simulate() { if (!prepare()) return; shown = plan.steps.length; applyPlan(); render(); }
function nextStep() {
  if (!plan || plan.done) { if (!prepare()) return; }
  shown++;
  if (shown === plan.steps.length) applyPlan();
  render();
}
function reset() {
  const c = readConfig();
  cfgKey = ''; plan = null; shown = 0; stats = { h: 0, m: 0 }; history = [];
  if (c) { cfgKey = [c.mem, c.cs, c.bs, c.mode, c.ways].join('|'); initCache(c); }
  render();
}

// ===== Rendering =====
function render() {
  const res = $('result'), stepsDiv = $('steps');
  stepsDiv.innerHTML = '';
  if (plan) {
    for (let i = 0; i < shown; i++) {
      const s = plan.steps[i];
      stepsDiv.insertAdjacentHTML('beforeend', `<div class="step ${s.last ? 'last' : ''}"><h4>${s.t}</h4>${s.h}</div>`);
    }
    if (plan.done) { res.className = 'result ' + (plan.hit ? 'hit' : 'miss'); res.textContent = plan.hit ? '✔ CACHE HIT' : '✘ CACHE MISS'; }
    else { res.className = 'result idle'; res.textContent = 'Step ' + shown + ' of ' + plan.steps.length + ' — press Next Step'; }
  } else { res.className = 'result idle'; res.innerHTML = 'Press <b>Simulate</b> or <b>Next Step</b> to begin'; }
  renderMemory(); renderCache();
  $('sHit').textContent = stats.h; $('sMiss').textContent = stats.m;
  const t = stats.h + stats.m; $('sRatio').textContent = t ? (100 * stats.h / t).toFixed(1) + '%' : '0%';
  $('log').innerHTML = history.map(h => `<li>${h}</li>`).join('');
}

function renderMemory() {
  const c = readConfigQuiet(); if (!c) { $('memView').innerHTML = ''; return; }
  const total = c.mem / c.bs, inCache = new Set(cache.filter(l => l.valid).map(l => l.block));
  const sel = plan && shown >= 3 ? plan.block : -1;
  let start = 0, end = total;
  if (total > 24) { const focus = sel >= 0 ? sel : Math.floor(c.addr / c.bs) || 0; start = Math.max(0, Math.min(focus - 6, total - 24)); end = start + 24; }
  let h = `<div class="row mrow head"><span>Block</span><span>Addresses</span></div>`;
  if (start > 0) h += `<div class="note">… blocks 0–${start - 1} hidden …</div>`;
  for (let b = start; b < end; b++) {
    const cls = b === sel ? 'sel' : inCache.has(b) ? 'inc' : '';
    h += `<div class="row mrow ${cls}"><span>B${b}</span><span>${b * c.bs}–${b * c.bs + c.bs - 1}</span></div>`;
  }
  if (end < total) h += `<div class="note">… blocks ${end}–${total - 1} hidden …</div>`;
  $('memView').innerHTML = h;
}

function renderCache() {
  const c = readConfigQuiet(); if (!c || !cache.length) { $('cacheView').innerHTML = ''; return; }
  let h = `<div class="row crow head"><span>Line</span><span>V</span><span>Tag</span><span>Holds</span></div>`;
  for (let i = 0; i < c.lines; i++) {
    if (c.mode === 'set' && i % c.ways === 0) h += `<div class="setlabel">Set ${i / c.ways}</div>`;
    const l = cache[i]; let cls = '';
    if (plan && plan.c.lines === c.lines) {
      const inSet = i >= plan.base && i < plan.base + plan.c.ways;
      if (shown >= 4 && inSet) cls = 'sel';
      if (plan.done && i === plan.line) cls = plan.hit ? 'hit' : 'miss';
    }
    h += `<div class="row crow ${cls}"><span>${i}</span><span>${l.valid ? 1 : 0}</span><span>${l.valid ? l.tag : '-'}</span><span>${l.valid ? 'Block ' + l.block : 'empty'}</span></div>`;
  }
  $('cacheView').innerHTML = h;
}

// Same as readConfig but silent (no error text), used for drawing.
function readConfigQuiet() {
  const e = $('error').textContent, c = readConfig(); $('error').textContent = e; return c;
}

function showDerived() {
  const mem = +$('mem').value, cs = +$('cache').value, bs = +$('block').value, mode = $('mode').value, k = +$('ways').value;
  $('waysBox').classList.toggle('hidden', mode !== 'set');
  const d = $('derived');
  if (![mem, cs, bs].every(isPow2) || bs > cs || cs > mem) { d.textContent = 'Enter valid power-of-2 sizes (Block ≤ Cache ≤ Memory).'; return; }
  const lines = cs / bs, ways = mode === 'direct' ? 1 : mode === 'assoc' ? lines : Math.min(k, lines), sets = lines / ways;
  d.innerHTML = `Address bits: <b>${lg(mem)}</b> | Offset bits: <b>${lg(bs)}</b> | Memory blocks: <b>${mem / bs}</b> | Cache lines: <b>${lines}</b>` +
    (mode === 'set' ? ` | Sets: <b>${sets}</b>` : '') + ` | Tag bits: <b>${lg(mem) - lg(bs) - lg(sets)}</b>`;
}

// ===== Events =====
$('btnSim').onclick = simulate;
$('btnNext').onclick = nextStep;
$('btnReset').onclick = reset;
['mem', 'cache', 'block', 'mode', 'ways'].forEach(id => $(id).addEventListener('input', () => { showDerived(); plan = null; shown = 0; $('error').textContent = ''; render(); }));
$('addr').addEventListener('input', () => { plan = null; shown = 0; render(); });
showDerived(); reset();
