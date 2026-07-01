const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Config ----------------
const WORLD_W = 1600;
const WORLD_H = 900;
const TICK_MS = 50; // 20 Hz simulation

const PLAYER_SPEED = 220;
const PLAYER_RADIUS = 16;
const PLAYER_MAX_HEALTH = 100;

const BULLET_SPEED = 900;
const BULLET_RADIUS = 4;
const BULLET_DAMAGE = 25;
const BULLET_LIFE = 1.3;
const SHOOT_COOLDOWN_MS = 220;

const ZOMBIE_RADIUS = 15;
const ZOMBIE_BASE_SPEED = 70;
const ZOMBIE_BASE_HEALTH = 60;
const ZOMBIE_CONTACT_DAMAGE = 10;
const ZOMBIE_CONTACT_COOLDOWN_MS = 700;

const INTERMISSION_MS = 9000;
const RESPAWN_MS = 4500;
const MAX_LIVES = 5;
const MAX_CHAT_LEN = 140;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const COLORS = ['#9fef00', '#3fc7ff', '#ff8a3d', '#ff5da2', '#c58bff', '#ffe14d'];

const OBSTACLES = [
  { x: 380, y: 180, w: 150, h: 40 },
  { x: 380, y: 680, w: 150, h: 40 },
  { x: 1070, y: 180, w: 150, h: 40 },
  { x: 1070, y: 680, w: 150, h: 40 },
  { x: 740, y: 410, w: 120, h: 120 },
];

// ---------------- Helpers ----------------
function circleRectCollide(cx, cy, r, rect) {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - closestX, dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
}

function moveWithCollision(entity, nx, ny, radius) {
  let blocked = false;
  for (const o of OBSTACLES) {
    if (circleRectCollide(nx, entity.y, radius, o)) { blocked = true; break; }
  }
  if (!blocked) entity.x = nx;
  blocked = false;
  for (const o of OBSTACLES) {
    if (circleRectCollide(entity.x, ny, radius, o)) { blocked = true; break; }
  }
  if (!blocked) entity.y = ny;
  entity.x = Math.max(radius, Math.min(WORLD_W - radius, entity.x));
  entity.y = Math.max(radius, Math.min(WORLD_H - radius, entity.y));
}

function safeSpawnPoint() {
  return {
    x: WORLD_W / 2 + (Math.random() * 100 - 50),
    y: WORLD_H / 2 + (Math.random() * 100 - 50),
  };
}

function escapeText(str) {
  return String(str).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// ---------------- Room ----------------
class Room {
  constructor(code) {
    this.code = code;
    this.players = {};
    this.zombies = [];
    this.bullets = [];
    this.nextZombieId = 1;
    this.nextBulletId = 1;
    this.wave = 1;
    this.lives = MAX_LIVES;
    this.waveState = 'lobby'; // lobby | intermission | spawning | active | gameover
    this.waveTimer = 0;
    this.zombiesToSpawn = 0;
    this.spawnAccumulator = 0;
    this.gameStarted = false;
    this.interval = null;
  }

  playerCount() {
    return Object.keys(this.players).length;
  }

  respawnPlayer(p) {
    const pt = safeSpawnPoint();
    p.x = pt.x;
    p.y = pt.y;
    p.health = PLAYER_MAX_HEALTH;
    p.downed = false;
    p.respawnAt = 0;
  }

  reset() {
    this.zombies = [];
    this.bullets = [];
    this.wave = 1;
    this.lives = MAX_LIVES;
    this.waveState = 'lobby';
    this.waveTimer = 0;
    this.zombiesToSpawn = 0;
    this.gameStarted = false;
    for (const id in this.players) this.respawnPlayer(this.players[id]);
  }

  startWave() {
    this.waveState = 'spawning';
    this.zombiesToSpawn = Math.min(6 + this.wave * 3, 60);
    this.spawnAccumulator = 0;
  }

  spawnZombie() {
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    if (edge === 0) { x = Math.random() * WORLD_W; y = -30; }
    else if (edge === 1) { x = Math.random() * WORLD_W; y = WORLD_H + 30; }
    else if (edge === 2) { x = -30; y = Math.random() * WORLD_H; }
    else { x = WORLD_W + 30; y = Math.random() * WORLD_H; }
    const speed = ZOMBIE_BASE_SPEED + Math.min(this.wave * 4, 90) + Math.random() * 20;
    const health = ZOMBIE_BASE_HEALTH + this.wave * 12;
    this.zombies.push({ id: this.nextZombieId++, x, y, speed, health, maxHealth: health, lastHit: 0 });
  }

  feed(text, type = 'info') {
    io.to(this.code).emit('feed', { text, type });
  }
}

const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    const room = new Room(code);
    rooms.set(code, room);
    room.interval = setInterval(() => tickRoom(room), TICK_MS);
  }
  return rooms.get(code);
}

function destroyRoomIfEmpty(room) {
  if (room.playerCount() === 0) {
    clearInterval(room.interval);
    rooms.delete(room.code);
  }
}

// ---------------- Networking ----------------
io.on('connection', (socket) => {
  socket.on('join', ({ name, room: roomCodeRaw } = {}) => {
    let code = (roomCodeRaw || '').toString().trim().toUpperCase().slice(0, 8);
    const isNewRoom = !code;
    if (!code) code = generateRoomCode();

    const room = getOrCreateRoom(code);
    const color = COLORS[room.playerCount() % COLORS.length];
    const pt = safeSpawnPoint();
    const playerName = (name || 'Survivor').toString().slice(0, 14).trim() || 'Survivor';

    room.players[socket.id] = {
      id: socket.id,
      name: playerName,
      x: pt.x,
      y: pt.y,
      angle: 0,
      health: PLAYER_MAX_HEALTH,
      color,
      kills: 0,
      downed: false,
      respawnAt: 0,
      input: { up: false, down: false, left: false, right: false },
      lastShot: 0,
      lastHit: 0,
    };

    socket.data.roomCode = code;
    socket.join(code);

    if (!room.gameStarted) {
      room.gameStarted = true;
      room.waveState = 'intermission';
      room.waveTimer = 4000;
    }

    socket.emit('joined', {
      id: socket.id,
      roomCode: code,
      isNewRoom,
      world: { w: WORLD_W, h: WORLD_H, obstacles: OBSTACLES },
    });

    room.feed(`${playerName} dropped in`, 'join');
  });

  socket.on('input', (inp) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || !inp) return;
    p.input = {
      up: !!inp.up,
      down: !!inp.down,
      left: !!inp.left,
      right: !!inp.right,
    };
    if (typeof inp.angle === 'number') p.angle = inp.angle;
  });

  socket.on('shoot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || p.downed || room.waveState === 'gameover' || room.waveState === 'lobby') return;
    const now = Date.now();
    if (now - p.lastShot < SHOOT_COOLDOWN_MS) return;
    p.lastShot = now;
    room.bullets.push({
      id: room.nextBulletId++,
      x: p.x + Math.cos(p.angle) * (PLAYER_RADIUS + 6),
      y: p.y + Math.sin(p.angle) * (PLAYER_RADIUS + 6),
      vx: Math.cos(p.angle) * BULLET_SPEED,
      vy: Math.sin(p.angle) * BULLET_SPEED,
      life: BULLET_LIFE,
      owner: socket.id,
    });
  });

  socket.on('chat', (text) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || typeof text !== 'string') return;
    const clean = escapeText(text.trim().slice(0, MAX_CHAT_LEN));
    if (!clean) return;
    io.to(room.code).emit('chat', { name: p.name, color: p.color, text: clean, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players[socket.id];
    if (p) room.feed(`${p.name} disconnected`, 'leave');
    delete room.players[socket.id];
    if (room.playerCount() === 0) {
      room.reset();
    }
    destroyRoomIfEmpty(room);
  });
});

// ---------------- Simulation ----------------
function tickRoom(room) {
  const dt = TICK_MS / 1000;
  const now = Date.now();

  // Player movement
  for (const id in room.players) {
    const p = room.players[id];
    if (p.downed) continue;
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      dx /= len; dy /= len;
      moveWithCollision(p, p.x + dx * PLAYER_SPEED * dt, p.y + dy * PLAYER_SPEED * dt, PLAYER_RADIUS);
    }
  }

  // Wave state machine
  if (room.waveState === 'intermission') {
    room.waveTimer -= TICK_MS;
    if (room.waveTimer <= 0) room.startWave();
  } else if (room.waveState === 'spawning') {
    room.spawnAccumulator += TICK_MS;
    if (room.spawnAccumulator > 350 && room.zombiesToSpawn > 0) {
      room.spawnAccumulator = 0;
      room.spawnZombie();
      room.zombiesToSpawn--;
    }
    if (room.zombiesToSpawn <= 0) room.waveState = 'active';
  } else if (room.waveState === 'active') {
    if (room.zombies.length === 0 && room.playerCount() > 0) {
      room.feed(`Wave ${room.wave} cleared`, 'wave');
      room.wave++;
      room.waveState = 'intermission';
      room.waveTimer = INTERMISSION_MS;
      for (const id in room.players) {
        const p = room.players[id];
        if (!p.downed) p.health = Math.min(PLAYER_MAX_HEALTH, p.health + 20);
      }
    }
  } else if (room.waveState === 'gameover') {
    room.waveTimer -= TICK_MS;
    if (room.waveTimer <= 0) {
      room.reset();
      room.waveState = 'intermission';
      room.waveTimer = 4000;
    }
  }

  // Zombie AI
  if (room.waveState === 'spawning' || room.waveState === 'active') {
    for (const z of room.zombies) {
      let target = null, best = Infinity;
      for (const id in room.players) {
        const p = room.players[id];
        if (p.downed) continue;
        const d = Math.hypot(p.x - z.x, p.y - z.y);
        if (d < best) { best = d; target = p; }
      }
      if (target) {
        const dx = target.x - z.x, dy = target.y - z.y;
        const len = Math.hypot(dx, dy) || 1;
        moveWithCollision(z, z.x + (dx / len) * z.speed * dt, z.y + (dy / len) * z.speed * dt, ZOMBIE_RADIUS);
        if (best < ZOMBIE_RADIUS + PLAYER_RADIUS + 4 && now - (target.lastHit || 0) > ZOMBIE_CONTACT_COOLDOWN_MS) {
          target.lastHit = now;
          target.health -= ZOMBIE_CONTACT_DAMAGE;
          if (target.health <= 0) {
            target.downed = true;
            target.respawnAt = now + RESPAWN_MS;
            room.lives--;
            room.feed(`${target.name} was downed`, 'down');
            if (room.lives <= 0) {
              room.waveState = 'gameover';
              room.waveTimer = 8000;
              room.feed('OVERRUN — the horde broke through', 'gameover');
            }
          }
        }
      }
    }
  }

  // Respawns
  for (const id in room.players) {
    const p = room.players[id];
    if (p.downed && p.respawnAt && now > p.respawnAt && room.waveState !== 'gameover') {
      room.respawnPlayer(p);
    }
  }

  // Bullets
  room.bullets = room.bullets.filter((b) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) return false;
    if (b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) return false;
    for (const o of OBSTACLES) {
      if (circleRectCollide(b.x, b.y, BULLET_RADIUS, o)) return false;
    }
    for (const z of room.zombies) {
      const d = Math.hypot(z.x - b.x, z.y - b.y);
      if (d < ZOMBIE_RADIUS + BULLET_RADIUS) {
        z.health -= BULLET_DAMAGE;
        z.lastHit = now;
        if (z.health <= 0) {
          z.dead = true;
          const owner = room.players[b.owner];
          if (owner) {
            owner.kills++;
            room.feed(`${owner.name} dropped a zombie`, 'kill');
          }
        }
        return false;
      }
    }
    return true;
  });
  room.zombies = room.zombies.filter((z) => !z.dead);

  // Broadcast
  io.to(room.code).emit('state', {
    roomCode: room.code,
    playerCount: room.playerCount(),
    wave: room.wave,
    lives: room.lives,
    waveState: room.waveState,
    waveTimer: room.waveTimer,
    players: Object.values(room.players).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      angle: p.angle,
      health: p.health,
      color: p.color,
      kills: p.kills,
      downed: p.downed,
    })),
    zombies: room.zombies.map((z) => ({ id: z.id, x: z.x, y: z.y, health: z.health, maxHealth: z.maxHealth })),
    bullets: room.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y })),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Outbreak server running on port ${PORT}`));
