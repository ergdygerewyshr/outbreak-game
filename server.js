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

// ---- Zombie variants ----
const ZOMBIE_TYPES = {
  normal: { radius: 15, speedMul: 1, healthMul: 1, damageMul: 1, color: '#5c8f2e' },
  runner: { radius: 12, speedMul: 1.9, healthMul: 0.45, damageMul: 0.8, color: '#c7e63d' },
  brute: { radius: 24, speedMul: 0.55, healthMul: 2.8, damageMul: 1.8, color: '#7a2323' },
};

function pickZombieType(wave) {
  const weights = {
    normal: Math.max(10 - wave, 3),
    runner: 3 + Math.min(wave, 6),
    brute: wave >= 3 ? Math.min(wave - 1, 6) : 0,
  };
  const total = weights.normal + weights.runner + weights.brute;
  let r = Math.random() * total;
  for (const type of Object.keys(weights)) {
    if (r < weights[type]) return type;
    r -= weights[type];
  }
  return 'normal';
}

// ---- Power-ups ----
const POWERUP_TYPES = {
  medkit: { label: 'Medkit', color: '#ff5da2', weight: 3 },
  speed: { label: 'Speed Boost', color: '#3fc7ff', weight: 2 },
  rapid: { label: 'Rapid Fire', color: '#ffe14d', weight: 2 },
  damage: { label: 'Damage Boost', color: '#ff8a3d', weight: 2 },
  shotgun: { label: 'Shotgun Rounds', color: '#c58bff', weight: 2 },
};
const POWERUP_RADIUS = 16;
const POWERUP_MAX_ON_MAP = 4;
const POWERUP_SPAWN_INTERVAL_MS = 7000;
const BUFF_DURATION_MS = 9000;
const SHOTGUN_DURATION_MS = 11000;

function pickPowerupType() {
  const entries = Object.entries(POWERUP_TYPES);
  const total = entries.reduce((s, [, v]) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const [type, cfg] of entries) {
    if (r < cfg.weight) return type;
    r -= cfg.weight;
  }
  return 'medkit';
}

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

function randomOpenPoint(radius) {
  const margin = 60;
  for (let i = 0; i < 30; i++) {
    const x = margin + Math.random() * (WORLD_W - margin * 2);
    const y = margin + Math.random() * (WORLD_H - margin * 2);
    let blocked = false;
    for (const o of OBSTACLES) {
      if (circleRectCollide(x, y, radius + 10, o)) { blocked = true; break; }
    }
    if (!blocked) return { x, y };
  }
  return { x: WORLD_W / 2, y: WORLD_H / 2 };
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
    this.powerups = [];
    this.nextZombieId = 1;
    this.nextBulletId = 1;
    this.nextPowerupId = 1;
    this.wave = 1;
    this.lives = MAX_LIVES;
    this.waveState = 'lobby'; // lobby | intermission | spawning | active | gameover
    this.waveTimer = 0;
    this.zombiesToSpawn = 0;
    this.spawnAccumulator = 0;
    this.powerupTimer = POWERUP_SPAWN_INTERVAL_MS;
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
    this.powerups = [];
    this.wave = 1;
    this.lives = MAX_LIVES;
    this.waveState = 'lobby';
    this.waveTimer = 0;
    this.zombiesToSpawn = 0;
    this.powerupTimer = POWERUP_SPAWN_INTERVAL_MS;
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

    const type = pickZombieType(this.wave);
    const cfg = ZOMBIE_TYPES[type];
    const speed = (ZOMBIE_BASE_SPEED + Math.min(this.wave * 4, 90) + Math.random() * 20) * cfg.speedMul;
    const health = (ZOMBIE_BASE_HEALTH + this.wave * 12) * cfg.healthMul;
    const damage = ZOMBIE_CONTACT_DAMAGE * cfg.damageMul;
    this.zombies.push({
      id: this.nextZombieId++, x, y, type, speed, health, maxHealth: health,
      damage, radius: cfg.radius, lastHit: 0,
    });
  }

  spawnPowerup() {
    if (this.powerups.length >= POWERUP_MAX_ON_MAP) return;
    const type = pickPowerupType();
    const pt = randomOpenPoint(POWERUP_RADIUS);
    this.powerups.push({ id: this.nextPowerupId++, type, x: pt.x, y: pt.y });
  }

  applyPowerup(p, type) {
    const now = Date.now();
    switch (type) {
      case 'medkit':
        p.health = Math.min(PLAYER_MAX_HEALTH, p.health + 50);
        break;
      case 'speed':
        p.buffs.speed = now + BUFF_DURATION_MS;
        break;
      case 'rapid':
        p.buffs.rapid = now + BUFF_DURATION_MS;
        break;
      case 'damage':
        p.buffs.damage = now + BUFF_DURATION_MS;
        break;
      case 'shotgun':
        p.buffs.shotgun = now + SHOTGUN_DURATION_MS;
        break;
    }
    this.feed(`${p.name} grabbed ${POWERUP_TYPES[type].label}`, 'pickup');
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

function makeBullet(room, p, angle, damage) {
  return {
    id: room.nextBulletId++,
    x: p.x + Math.cos(angle) * (PLAYER_RADIUS + 6),
    y: p.y + Math.sin(angle) * (PLAYER_RADIUS + 6),
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    life: BULLET_LIFE,
    damage,
    owner: p.id,
  };
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
      buffs: { speed: 0, rapid: 0, damage: 0, shotgun: 0 },
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
    const rapidActive = p.buffs.rapid > now;
    const cooldown = SHOOT_COOLDOWN_MS * (rapidActive ? 0.5 : 1);
    if (now - p.lastShot < cooldown) return;
    p.lastShot = now;

    const dmg = BULLET_DAMAGE * (p.buffs.damage > now ? 2 : 1);
    const shotgunActive = p.buffs.shotgun > now;

    if (shotgunActive) {
      const pellets = 5;
      const spread = 0.5;
      for (let i = 0; i < pellets; i++) {
        const off = -spread / 2 + (spread / (pellets - 1)) * i;
        room.bullets.push(makeBullet(room, p, p.angle + off, Math.round(dmg * 0.55)));
      }
    } else {
      room.bullets.push(makeBullet(room, p, p.angle, dmg));
    }
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
      const speed = PLAYER_SPEED * (p.buffs.speed > now ? 1.35 : 1);
      moveWithCollision(p, p.x + dx * speed * dt, p.y + dy * speed * dt, PLAYER_RADIUS);
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
        moveWithCollision(z, z.x + (dx / len) * z.speed * dt, z.y + (dy / len) * z.speed * dt, z.radius);
        if (best < z.radius + PLAYER_RADIUS + 4 && now - (target.lastHit || 0) > ZOMBIE_CONTACT_COOLDOWN_MS) {
          target.lastHit = now;
          target.health -= z.damage;
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

  // Power-up spawning
  if (room.waveState !== 'lobby' && room.waveState !== 'gameover') {
    room.powerupTimer -= TICK_MS;
    if (room.powerupTimer <= 0) {
      room.spawnPowerup();
      room.powerupTimer = POWERUP_SPAWN_INTERVAL_MS + Math.random() * 3000;
    }
  }

  // Power-up pickup
  if (room.powerups.length) {
    for (const id in room.players) {
      const p = room.players[id];
      if (p.downed) continue;
      room.powerups = room.powerups.filter((pu) => {
        const d = Math.hypot(p.x - pu.x, p.y - pu.y);
        if (d < PLAYER_RADIUS + POWERUP_RADIUS) {
          room.applyPowerup(p, pu.type);
          return false;
        }
        return true;
      });
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
      if (d < z.radius + BULLET_RADIUS) {
        z.health -= b.damage;
        z.lastHit = now;
        if (z.health <= 0) {
          z.dead = true;
          const owner = room.players[b.owner];
          if (owner) {
            owner.kills++;
            room.feed(`${owner.name} dropped a ${z.type}`, 'kill');
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
      buffs: {
        speed: Math.max(0, p.buffs.speed - now),
        rapid: Math.max(0, p.buffs.rapid - now),
        damage: Math.max(0, p.buffs.damage - now),
        shotgun: Math.max(0, p.buffs.shotgun - now),
      },
    })),
    zombies: room.zombies.map((z) => ({
      id: z.id, x: z.x, y: z.y, type: z.type, radius: z.radius, health: z.health, maxHealth: z.maxHealth,
    })),
    bullets: room.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y })),
    powerups: room.powerups.map((pu) => ({ id: pu.id, type: pu.type, x: pu.x, y: pu.y })),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Outbreak server running on port ${PORT}`));
