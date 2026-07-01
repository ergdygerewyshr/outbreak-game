const socket = io();

const lobby = document.getElementById('lobby');
const gameWrap = document.getElementById('gameWrap');
const nameInput = document.getElementById('nameInput');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const connStatus = document.getElementById('connStatus');

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const waveNumEl = document.getElementById('waveNum');
const livesRowEl = document.getElementById('livesRow');
const leaderboardEl = document.getElementById('leaderboard');
const centerMsgEl = document.getElementById('centerMsg');
const centerBigEl = document.getElementById('centerBig');
const centerSmallEl = document.getElementById('centerSmall');
const healthFillEl = document.getElementById('healthFill');
const downedOverlayEl = document.getElementById('downedOverlay');
const roomCodeLabelEl = document.getElementById('roomCodeLabel');
const playerCountLabelEl = document.getElementById('playerCountLabel');
const killFeedEl = document.getElementById('killFeed');
const chatLogEl = document.getElementById('chatLog');
const chatInputEl = document.getElementById('chatInput');

let myId = null;
let world = { w: 1600, h: 900, obstacles: [] };
let latestState = null;
let joined = false;

// ---------------- Join flow ----------------
joinBtn.addEventListener('click', doJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  if (joined) return;
  const name = nameInput.value.trim() || 'Survivor';
  const room = roomInput.value.trim();
  socket.emit('join', { name, room });
  connStatus.textContent = 'Connecting...';
}

socket.on('connect', () => { connStatus.textContent = ''; });
socket.on('disconnect', () => { connStatus.textContent = 'Disconnected from server.'; });

socket.on('joined', (data) => {
  joined = true;
  myId = data.id;
  world = data.world;
  roomCodeLabelEl.textContent = data.roomCode;
  lobby.style.display = 'none';
  gameWrap.style.display = 'flex';
  requestAnimationFrame(loop);
});

socket.on('state', (state) => {
  latestState = state;
});

// ---------------- Kill feed ----------------
socket.on('feed', ({ text, type }) => {
  const item = document.createElement('div');
  item.className = `feed-item ${type}`;
  item.textContent = text;
  killFeedEl.appendChild(item);
  setTimeout(() => item.remove(), 4200);
  while (killFeedEl.children.length > 5) killFeedEl.removeChild(killFeedEl.firstChild);
});

// ---------------- Chat ----------------
socket.on('chat', ({ name, color, text }) => {
  const row = document.createElement('div');
  row.className = 'chat-msg';
  const who = document.createElement('span');
  who.className = 'who';
  who.style.color = color;
  who.textContent = name + ':';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = ' ' + text;
  row.appendChild(who);
  row.appendChild(txt);
  chatLogEl.appendChild(row);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  while (chatLogEl.children.length > 60) chatLogEl.removeChild(chatLogEl.firstChild);
});

chatInputEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const text = chatInputEl.value.trim();
    if (text) {
      socket.emit('chat', text);
      chatInputEl.value = '';
    }
    chatInputEl.blur();
  } else if (e.key === 'Escape') {
    chatInputEl.value = '';
    chatInputEl.blur();
  }
});

// ---------------- Input ----------------
const keys = { up: false, down: false, left: false, right: false };
let mouseAngle = 0;
let firing = false;

function chatFocused() {
  return document.activeElement === chatInputEl;
}

window.addEventListener('keydown', (e) => {
  if (chatFocused()) return; // let the chat box handle typing
  if (e.key === 'Enter') { chatInputEl.focus(); e.preventDefault(); return; }
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.up = true; break;
    case 'KeyS': case 'ArrowDown': keys.down = true; break;
    case 'KeyA': case 'ArrowLeft': keys.left = true; break;
    case 'KeyD': case 'ArrowRight': keys.right = true; break;
  }
});
window.addEventListener('keyup', (e) => {
  if (chatFocused()) return;
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.up = false; break;
    case 'KeyS': case 'ArrowDown': keys.down = false; break;
    case 'KeyA': case 'ArrowLeft': keys.left = false; break;
    case 'KeyD': case 'ArrowRight': keys.right = false; break;
  }
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top) * scaleY;
  const me = myId && latestState ? latestState.players.find((p) => p.id === myId) : null;
  if (me) mouseAngle = Math.atan2(my - me.y, mx - me.x);
});
canvas.addEventListener('mousedown', () => { firing = true; });
window.addEventListener('mouseup', () => { firing = false; });

// Send input to server at a steady rate
setInterval(() => {
  if (!joined) return;
  socket.emit('input', { ...keys, angle: mouseAngle });
  if (firing && !chatFocused()) socket.emit('shoot');
}, 50);

// ---------------- Rendering ----------------
function drawGrid() {
  ctx.strokeStyle = 'rgba(159,239,0,0.05)';
  ctx.lineWidth = 1;
  const step = 80;
  for (let x = 0; x <= world.w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.h); ctx.stroke();
  }
  for (let y = 0; y <= world.h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(world.w, y); ctx.stroke();
  }
}

function drawObstacles() {
  ctx.fillStyle = '#1c2216';
  ctx.strokeStyle = '#3a4530';
  ctx.lineWidth = 2;
  for (const o of world.obstacles) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeRect(o.x, o.y, o.w, o.h);
  }
}

function drawZombie(z) {
  ctx.save();
  ctx.translate(z.x, z.y);
  ctx.fillStyle = '#5c8f2e';
  ctx.beginPath();
  ctx.arc(0, 0, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2f4a17';
  ctx.beginPath();
  ctx.arc(-5, -5, 4, 0, Math.PI * 2);
  ctx.arc(5, -5, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const pct = Math.max(0, z.health / z.maxHealth);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(z.x - 16, z.y - 26, 32, 4);
  ctx.fillStyle = '#d1302f';
  ctx.fillRect(z.x - 16, z.y - 26, 32 * pct, 4);
}

function drawPlayer(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.globalAlpha = p.downed ? 0.35 : 1;
  ctx.rotate(p.angle);
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(0, 0, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(10, -3, 14, 6);
  ctx.restore();

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e8e6df';
  ctx.font = '12px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, p.x, p.y - 26);

  const pct = Math.max(0, p.health / 100);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(p.x - 18, p.y - 34, 36, 4);
  ctx.fillStyle = pct > 0.4 ? '#9fef00' : '#d1302f';
  ctx.fillRect(p.x - 18, p.y - 34, 36 * pct, 4);
}

function drawBullet(b) {
  ctx.fillStyle = '#ffe14d';
  ctx.beginPath();
  ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function updateHud(state) {
  waveNumEl.textContent = state.wave;
  playerCountLabelEl.textContent = state.playerCount;

  livesRowEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const dot = document.createElement('div');
    dot.className = 'life-dot' + (i < state.lives ? '' : ' lost');
    livesRowEl.appendChild(dot);
  }

  const rows = [...state.players].sort((a, b) => b.kills - a.kills).slice(0, 6);
  leaderboardEl.innerHTML = rows.map((p) =>
    `<div class="row"><span class="name" style="color:${p.color}">${escapeHtml(p.name)}</span><span class="kills">${p.kills}</span></div>`
  ).join('');

  centerMsgEl.style.display = 'none';
  if (state.waveState === 'intermission') {
    centerMsgEl.style.display = 'block';
    centerBigEl.className = 'big';
    centerBigEl.textContent = `WAVE ${state.wave} INCOMING`;
    centerSmallEl.textContent = `Get ready — ${Math.max(0, Math.ceil(state.waveTimer / 1000))}s`;
  } else if (state.waveState === 'gameover') {
    centerMsgEl.style.display = 'block';
    centerBigEl.className = 'big danger';
    centerBigEl.textContent = 'OVERRUN';
    centerSmallEl.textContent = `The horde got in. Restarting in ${Math.max(0, Math.ceil(state.waveTimer / 1000))}s`;
  }

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    healthFillEl.style.width = Math.max(0, me.health) + '%';
    downedOverlayEl.style.display = me.downed ? 'flex' : 'none';
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loop() {
  if (latestState) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    drawObstacles();
    for (const z of latestState.zombies) drawZombie(z);
    for (const p of latestState.players) drawPlayer(p);
    for (const b of latestState.bullets) drawBullet(b);
    updateHud(latestState);
  }
  requestAnimationFrame(loop);
}
