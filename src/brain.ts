import { World } from "./world.ts"

type V3 = [number, number, number]

const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const hyp = Math.hypot

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const env = (k: string, d: number) => {
  const v = typeof process !== "undefined" ? process.env["MB_" + k] : undefined
  return v === undefined || v === "" ? d : +v
}
const MODE = typeof process !== "undefined" ? process.env.MB_MODE || "duel" : "duel"
const WEAPON_VALUE: Record<string, number> = { laser: 10, lightning: env("LIGHT", 8), gun: env("GUN", 9), mortar: env("MORT", 4) }

const UPGRADE_ORDER = [
  "plating", "armor", "laser_damage", "laser_charge", "gun_damage", "nanites", "gun_rate",
  "lightning_efficiency", "lightning_range", "gyros", "gun_mag", "servos", "gun_velocity",
  "sensors", "mortar_reload", "reactor", "capacitor", "lightning_chain", "jets",
  "mortar_velocity", "mortar_splash", "laser_pierce",
]

type Enemy = {
  id: number
  pos: V3
  vel: V3
  aim: [number, number]
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  chargeSince: number
  seen: number // last time listed in obs
  firstSeen: number
  dmgToMe: number // recent damage they did to me (decays)
}

type Thing = { id: number; pos: V3; kind?: string; hp?: number; seen: number }

export class Brain {
  w: World
  cfg: any
  rand: () => number
  slot: number
  t = 0
  tick = 0
  me: any
  P: V3 = [0, 0, 0]
  scale = 1

  enemies = new Map<number, Enemy>()
  npcs = new Map<number, Enemy>()
  crates = new Map<number, Thing>()
  pickups = new Map<number, Thing>()
  cubes = new Map<number, Thing>()
  badCrates = new Set<number>()
  badPickups = new Map<number, number>()
  contacts: { x: number; y: number; t: number; kind: string; w: number }[] = []
  ghosts = new Map<number, { x: number; y: number; t: number; weapon: string; bearing: number; dmg: number }>()
  lastHurt = -99
  lastHurtBy = -1
  lastDealt = -99
  hurtBearing = 0

  route: number[] | null = null
  routeGoal: [number, number] = [0, 0]
  routeAt = -99
  routeIdx = 0
  stuckRef: [number, number, number] = [0, 0, 0]
  stuckTimer = 0
  unstickUntil = -1
  unstickDir = 0
  jinkSign = 1
  jinkNext = 0
  fightGoal: [number, number] | null = null
  fightGoalAt = -99
  scanYaw = 0
  visited = new Map<number, number>()
  lastMoveCmd: [number, number] = [0, 0]
  aimCmd: [number, number] = [0, 0]
  laserHoldStart = -1
  mode = ""
  dropGoal: number | null = null
  lastPathCost = 0
  climbH = 0
  climbUntil = -1
  curTarget = -1
  curTargetAt = -99
  prof: Record<string, number> = {}
  lastProf: Record<string, number> = {}
  pt(k: string, t0: number) { this.prof[k] = (this.prof[k] || 0) + performance.now() - t0 }

  constructor(hello: any) {
    this.cfg = hello.config
    this.slot = hello.slot
    this.rand = rng(hello.seed ?? 1)
    this.w = new World(hello.map.dir)
    this.jinkSign = this.rand() < 0.5 ? 1 : -1
  }

  // ---------------- helpers ----------------

  weapon(kind: string): any {
    const ws = this.me.weapons
    for (let i = 0; i < ws.length; i++) if (ws[i] && ws[i].kind === kind) return ws[i]
    return null
  }
  slotOf(kind: string) {
    const ws = this.me.weapons
    for (let i = 0; i < ws.length; i++) if (ws[i] && ws[i].kind === kind) return i
    return -1
  }

  zoneAt(t: number): [number, number, number] {
    const z = this.obsZone
    if (t <= z.shrink_start) return [z.center[0], z.center[1], z.radius]
    const f = clamp((t - z.shrink_start) / Math.max(0.01, z.shrink_end - z.shrink_start), 0, 1)
    return [
      z.center[0] + (z.next_center[0] - z.center[0]) * f,
      z.center[1] + (z.next_center[1] - z.center[1]) * f,
      z.radius + (z.next_radius - z.radius) * f,
    ]
  }
  obsZone: any

  // margin to the zone edge at time t (positive = inside)
  zoneMargin(x: number, y: number, t: number) {
    const [cx, cy, r] = this.zoneAt(t)
    return r - hyp(x - cx, y - cy)
  }

  eyeOf(e: Enemy) {
    return e.pos[2] + 8 * (1 + 0.05 * e.cubes)
  }
  centerOf(e: Enemy) {
    return e.pos[2] + 4.5 * (1 + 0.05 * e.cubes)
  }

  // can enemy e see/shoot a mech standing at (x,y,z)?
  exposedTo(e: Enemy, x: number, y: number, z: number) {
    const ez = this.eyeOf(e)
    const h = 9 * this.scale
    return (
      this.w.clear(e.pos[0], e.pos[1], ez, x, y, z + h * 0.5) ||
      this.w.clear(e.pos[0], e.pos[1], ez, x, y, z + h * 0.92)
    )
  }

  canHitFrom(x: number, y: number, z: number, tx: number, ty: number, tz: number) {
    const mz = z + this.me.stats.muzzle_height
    return this.w.clear(x, y, mz, tx, ty, tz)
  }

  // ---------------- main ----------------

  act(obs: any) {
    const t0 = performance.now()
    this.t = obs.t
    this.tick = obs.tick
    this.me = obs.self
    this.P = this.me.pos
    this.obsZone = obs.zone
    this.obsDrops = obs.drops || []
    this.scale = 1 + 0.05 * (this.me.cubes || 0)
    const act: any = { tick: obs.tick }

    this.ingest(obs)

    if (obs.offer) act.pick = this.pickUpgrade(obs.offer)

    let t1 = performance.now()
    this.pt("ingest", t0)
    const plan = MODE === "hide" ? this.decideHide(obs) : this.decide(obs)
    this.pt("decide", t1)
    act.move = plan.move
    act.boost = plan.boost
    if (plan.jump) act.jump = true
    act.aim = plan.aim
    act.fire = plan.fire
    if (plan.reload) act.reload = true
    if (plan.take !== undefined) {
      act.take = plan.take
      if (plan.drop !== undefined) act.drop = plan.drop
    }
    this.lastMoveCmd = plan.move
    this.aimCmd = plan.aim
    const ms = performance.now() - t0
    if (ms > 30) console.error(`slow tick ${obs.tick}: ${ms.toFixed(1)}ms ${this.mode} ${JSON.stringify(this.prof)}`)
    this.lastProf = this.prof; this.prof = {}
    return act
  }

  ingest(obs: any) {
    const t = this.t
    const seenIds = new Set<number>()
    for (const m of obs.mechs) {
      const map = m.kind === "mech" ? this.enemies : this.npcs
      seenIds.add(m.id)
      let e = map.get(m.id)
      if (!e) {
        e = {
          id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp, maxHp: m.max_hp, cubes: m.cubes ?? 0,
          weapons: m.weapons ?? [], charging: !!m.charging, chargeSince: -1, seen: t, firstSeen: t, dmgToMe: 0,
        }
        map.set(m.id, e)
      }
      e.pos = m.pos
      e.vel = m.vel
      e.aim = m.aim
      if (m.hp !== undefined) e.hp = m.hp
      if (m.max_hp !== undefined) e.maxHp = m.max_hp
      e.cubes = m.cubes ?? e.cubes
      if (m.weapons) e.weapons = m.weapons
      const ch = !!m.charging
      if (ch && !e.charging) e.chargeSince = t
      if (!ch) e.chargeSince = -1
      e.charging = ch
      e.seen = t
    }
    // forget stale tracks
    for (const [id, e] of this.enemies) {
      e.dmgToMe *= 0.97
      if (t - e.seen > 25) this.enemies.delete(id)
    }
    for (const [id, e] of this.npcs) if (t - e.seen > 10) this.npcs.delete(id)

    for (const ev of obs.events) {
      if (ev.type === "damaged") {
        if (ev.by !== null && ev.by !== undefined) {
          this.lastHurt = t
          this.lastHurtBy = ev.by
          if (ev.bearing !== null) this.hurtBearing = ev.bearing
          const e = this.enemies.get(ev.by)
          if (e) e.dmgToMe += ev.amount
          if ((!e || e.seen !== t) && ev.by < 100 && ev.bearing !== null) {
            const gd = ev.weapon === "lightning" ? 30 : ev.weapon === "laser" ? 110 : ev.weapon === "mortar" ? 120 : 90
            const gx = this.P[0] + Math.cos(ev.bearing) * gd, gy = this.P[1] + Math.sin(ev.bearing) * gd
            this.ghosts.set(ev.by, { x: gx, y: gy, t, weapon: ev.weapon, bearing: ev.bearing, dmg: ev.amount + (this.ghosts.get(ev.by)?.dmg ?? 0) * 0.5 })
          }
          if (!e && ev.by < 100 && ev.bearing !== null) {
            const d = ev.weapon === "lightning" ? 35 : ev.weapon === "laser" ? 120 : 90
            this.contacts.push({ x: this.P[0] + Math.cos(ev.bearing) * d, y: this.P[1] + Math.sin(ev.bearing) * d, t, kind: "hit", w: 3 })
          }
        }
      } else if (ev.type === "hit") {
        this.lastDealt = t
      } else if (ev.type === "take_failed") {
        this.badPickups.set(ev.id, t)
      } else if (ev.type === "kill") {
        this.enemies.delete(ev.target)
      }
    }

    // sounds -> rough contacts (mech weapons only)
    for (const s of obs.sounds) {
      const k = s.kind
      if (k === "gun" || k === "laser" || k === "laser_charge" || k === "lightning" || k === "mortar" || k === "step" || k === "boost" || k === "jet" || k === "reload") {
        const d = s.dist === "near" ? 35 : s.dist === "mid" ? 110 : 220
        this.contacts.push({ x: this.P[0] + Math.cos(s.bearing) * d, y: this.P[1] + Math.sin(s.bearing) * d, t: t - (s.age || 0), kind: k, w: s.dist === "near" ? 2 : 1 })
      }
    }
    this.contacts = this.contacts.filter((c) => t - c.t < 8)
    if (this.contacts.length > 40) this.contacts.splice(0, this.contacts.length - 40)

    // static-ish loot memory; drop entries we should be seeing but aren't
    const vis = (list: any[], map: Map<number, Thing>, ttl: number) => {
      const ids = new Set<number>()
      for (const o of list) {
        ids.add(o.id)
        const th = map.get(o.id)
        if (th) { th.pos = o.pos; th.seen = t; if (o.hp !== undefined) th.hp = o.hp; if (o.kind) th.kind = o.kind }
        else map.set(o.id, { id: o.id, pos: o.pos, kind: o.kind, hp: o.hp, seen: t })
      }
      for (const [id, th] of map) {
        if (ids.has(id)) continue
        const d = hyp(th.pos[0] - this.P[0], th.pos[1] - this.P[1])
        if (d < 35 || t - th.seen > ttl) map.delete(id)
      }
    }
    vis(obs.crates, this.crates, 120)
    vis(obs.pickups, this.pickups, 200)
    vis(obs.cubes, this.cubes, 60)

    const vk = (Math.floor((this.P[0] + 600) / 40) << 8) | Math.floor((this.P[1] + 400) / 40)
    this.visited.set(vk, t)
  }

  pickUpgrade(offer: any) {
    let best = 0, bs = 1e9
    offer.choices.forEach((c: any, i: number) => {
      let r = UPGRADE_ORDER.indexOf(c.id)
      if (r < 0) r = 50
      if (r < bs) { bs = r; best = i }
    })
    return best
  }

  // ---------------- decisions ----------------

  // probe mode: never shoot, stay quiet and out of sight
  decideHide(obs: any) {
    const me = this.me, P = this.P, t = this.t
    const threats: Enemy[] = []
    for (const e of this.enemies.values()) if (t - e.seen < 10) threats.push(e)
    for (const [id, g] of this.ghosts) if (t - g.t < 6) threats.push({ id: 1000 + id, pos: [g.x, g.y, this.w.surfAt(g.x, g.y)], cubes: 0 } as any)
    let move: [number, number] = [0, 0], boost = false, jump = false
    const zu = this.zoneUrgency()
    const near = threats.some((e) => hyp(e.pos[0] - P[0], e.pos[1] - P[1]) < 130)
    if (zu >= 0.7) {
      const sp = this.zoneSafePoint()
      move = this.followTo(sp[0], sp[1], 3)
      boost = zu >= 1 || near
      this.mode = "zone"
    } else if (threats.length) {
      const spot = this.retreatSpot(threats)
      if (spot) move = this.followTo(spot[0], spot[1], 2)
      boost = near && me.energy > 10
      this.mode = "hide-run"
    } else {
      const sp = this.zoneSafePoint()
      const d = hyp(sp[0] - P[0], sp[1] - P[1])
      if (d > 40) move = this.followTo(sp[0], sp[1], 3)
      this.mode = "hide-wait"
    }
    if (!boost) { const l = hyp(move[0], move[1]); if (l > 0.4) move = [move[0] / l * 0.4, move[1] / l * 0.4] }
    if (t < this.climbUntil && P[2] < this.climbH + 0.6) { if (me.grounded) jump = true; else boost = me.energy > 2 }
    const moving = hyp(move[0], move[1]) > 0.2
    if (t < this.unstickUntil) { move = [Math.cos(this.unstickDir), Math.sin(this.unstickDir)]; jump = me.grounded; boost = !me.grounded && me.energy > 5 }
    else if (moving && hyp(me.vel[0], me.vel[1]) < 1 && me.grounded) {
      this.stuckTimer += 0.1
      if (this.stuckTimer > 1.5) { this.stuckTimer = 0; this.unstickUntil = t + 0.8; this.unstickDir = Math.atan2(move[1], move[0]) + (this.rand() - 0.5) * 2.2; this.route = null }
    } else this.stuckTimer = Math.max(0, this.stuckTimer - 0.05)
    let look: V3 = this.scanLook()
    let nearest: Enemy | null = null
    for (const e of threats) if (!nearest || hyp(e.pos[0] - P[0], e.pos[1] - P[1]) < hyp(nearest.pos[0] - P[0], nearest.pos[1] - P[1])) nearest = e
    if (nearest) look = [nearest.pos[0], nearest.pos[1], nearest.pos[2] + 5]
    const yaw = Math.atan2(look[1] - P[1], look[0] - P[0])
    return { move, boost, jump, aim: [yaw, 0] as [number, number], fire: [false, false], reload: false, take: undefined, drop: undefined }
  }

  decide(obs: any) {
    const me = this.me
    const P = this.P
    const t = this.t
    const hpFrac = me.hp / me.max_hp

    // threats we currently know about
    const threats: Enemy[] = []
    for (const e of this.enemies.values()) if (t - e.seen < 6) threats.push(e)
    let ghostLook: V3 | null = null
    for (const [id, g] of this.ghosts) {
      if (t - g.t > 4) { this.ghosts.delete(id); continue }
      const known = this.enemies.get(id)
      if (known && known.seen > g.t) continue
      const gz = this.w.surfAt(g.x, g.y)
      threats.push({ id: 1000 + id, pos: [g.x, g.y, gz], vel: [0, 0, 0], aim: [g.bearing + Math.PI, 0], hp: 1400, maxHp: 1400, cubes: 0,
        weapons: [g.weapon], charging: false, chargeSince: -1, seen: g.t, firstSeen: g.t, dmgToMe: g.dmg, ghost: true } as any)
      if (t - g.t < 1.2 && (!ghostLook || g.dmg > 60)) ghostLook = [g.x, g.y, gz + 5]
    }
    const dist = (e: { pos: V3 }) => hyp(e.pos[0] - P[0], e.pos[1] - P[1])

    let target: Enemy | null = null
    let tScore = -1e9
    for (const e of threats) {
      if ((e as any).ghost) continue
      const d = dist(e)
      if (d > 260) continue
      const fresh = t - e.seen < 0.15
      const sticky = e.id === this.curTarget && t - this.curTargetAt < 1.5 ? 45 + (1 - e.hp / Math.max(1, e.maxHp)) * 30 : 0
      const s = -d * 0.5 - (e.hp / 14) + (fresh ? 40 : 0) + (e.id === this.lastHurtBy && t - this.lastHurt < 3 ? 25 : 0) + e.dmgToMe * 0.1 + sticky
      if (s > tScore) { tScore = s; target = e }
    }

    if (target) { this.curTarget = target.id; this.curTargetAt = t }
    // shot by someone we can't see: treat their rough position as the target and turn to it
    if (ghostLook && (!target || t - target.seen > 0.3 || target.hp > 250)) {
      let gt: Enemy | null = null
      for (const e of threats) if ((e as any).ghost && (!gt || e.dmgToMe > gt.dmgToMe)) gt = e
      if (gt && (!target || t - target.seen > 0.3)) target = gt
    }
    const fighting = !!target && (dist(target) < 230 || t - this.lastHurt < 4)
    let move: [number, number] = [0, 0]
    let boost = false
    let jump = false
    let lookAt: V3 | null = null
    let shootAt: { pos: V3; vel: V3; r: number; isMech: boolean; e?: Enemy } | null = null
    let take: number | undefined
    let drop: number | undefined
    let reload = false

    // loot swap/take within reach, regardless of mode
    const tk = this.considerTake()
    if (tk) { take = tk.id; drop = tk.drop }

    const zoneUrgent = this.zoneUrgency()

    const grab = this.worstSlotValue() < 5 ? this.nearWeapon(env("GRAB_R", 45)) : null
    if (fighting && target) {
      this.mode = "fight"
      const tf = performance.now()
      const r = grab ? { move: this.followTo(grab[0], grab[1], 0.5), boost: me.energy > 20 } : this.fightMove(target, threats, hpFrac)
      if (grab) this.mode = "fight-grab"
      this.pt("fight", tf)
      move = r.move
      boost = r.boost
      lookAt = [target.pos[0], target.pos[1], this.centerOf(target)]
      if (!(target as any).ghost) shootAt = { pos: [target.pos[0], target.pos[1], this.centerOf(target)], vel: target.vel, r: 2.5 * (1 + 0.05 * target.cubes), isMech: true, e: target }
      if (ghostLook && shootAt && t - this.lastHurt < 0.6 && target.hp > 250) {
        // getting hit from outside our view: look first, the front arc halves nothing but the rear adds 50%
        const gy = Math.atan2(ghostLook[1] - P[1], ghostLook[0] - P[0])
        const ty = Math.atan2(target.pos[1] - P[1], target.pos[0] - P[0])
        if (Math.abs(wrap(gy - ty)) > 1.0) { shootAt = null; lookAt = ghostLook }
      }
      if (zoneUrgent > 0.6) {
        const zm = this.zoneMove()
        if (zm) { move = zm; boost = me.energy > 20 }
      }
    } else {
      this.fightGoal = null
      const tg = performance.now()
      const g = this.chooseGoal(threats)
      this.pt("goal", tg)
      this.mode = g.label
      if (g.goal) {
        move = this.followTo(g.goal[0], g.goal[1], g.stopDist ?? 2)
        boost = g.boost ?? false
      }
      if (g.shoot) shootAt = g.shoot
      if (g.look) lookAt = g.look
    }

    // dodge incoming shells / bullets
    const td = performance.now()
    const dodge = this.dodgeVector(obs)
    this.pt("dodge", td)
    if (dodge) {
      move = [move[0] * 0.4 + dodge[0], move[1] * 0.4 + dodge[1]]
      const l = hyp(move[0], move[1])
      if (l > 1) move = [move[0] / l, move[1] / l]
      if (me.energy > 15) boost = true
    }

    if (t < this.climbUntil && P[2] < this.climbH + 0.6) {
      if (me.grounded) jump = true
      else boost = me.energy > 2
      this.stuckTimer = 0
    }
    // stuck handling
    const moving = hyp(move[0], move[1]) > 0.3
    const sp = hyp(me.vel[0], me.vel[1])
    if (t < this.unstickUntil) {
      const a = this.unstickDir
      move = [Math.cos(a), Math.sin(a)]
      jump = me.grounded
      boost = !me.grounded && me.energy > 5
    } else if (moving && sp < 1.5 && me.grounded) {
      this.stuckTimer += 0.1
      if (this.stuckTimer > 1.2) {
        this.stuckTimer = 0
        this.unstickUntil = t + 0.8
        this.unstickDir = Math.atan2(move[1], move[0]) + (this.rand() - 0.5) * 2.2
        this.route = null
      }
    } else this.stuckTimer = Math.max(0, this.stuckTimer - 0.05)

    // ---- aim and fire ----
    const fc = this.fireControl(shootAt, lookAt, move)
    if (fc.reload) reload = true

    if (me.energy < 25 && !dodge && zoneUrgent < 0.6 && !(t < this.climbUntil)) boost = false
    return { move, boost, jump, aim: fc.aim, fire: fc.fire, reload, take, drop }
  }

  // ---------------- zone ----------------

  // 0 = relaxed, 1 = must run now
  zoneUrgency() {
    const P = this.P, t = this.t, z = this.obsZone
    const speed = this.me.stats.walk_speed || 11.7
    const mNow = this.zoneMargin(P[0], P[1], t)
    if (mNow < 0) return 1
    const nm = z.next_radius - hyp(P[0] - z.next_center[0], P[1] - z.next_center[1])
    if (nm > 10) return 0
    // time we need to get well inside the next circle vs time until it finishes closing
    const need = (10 - nm) / speed + 6
    const left = z.shrink_end - t
    if (left <= need) return 1
    if (left <= need * 1.6 + 8) return 0.7
    const m5 = this.zoneMargin(P[0], P[1], t + 8)
    if (m5 < 5) return 0.8
    return 0.2
  }

  zoneSafePoint(): [number, number] {
    const z = this.obsZone
    const P = this.P
    const cx = z.next_center[0], cy = z.next_center[1]
    const d = hyp(P[0] - cx, P[1] - cy)
    const inner = Math.max(0, z.next_radius * 0.6 - 5)
    if (d <= inner) return [P[0], P[1]]
    return [cx + ((P[0] - cx) / d) * inner, cy + ((P[1] - cy) / d) * inner]
  }

  zoneMove(): [number, number] | null {
    const sp = this.zoneSafePoint()
    return this.followTo(sp[0], sp[1], 3)
  }

  // ---------------- goals outside combat ----------------

  chooseGoal(threats: Enemy[]): { label: string; goal?: [number, number]; stopDist?: number; boost?: boolean; shoot?: any; look?: V3 } {
    const P = this.P, t = this.t, me = this.me
    const zu = this.zoneUrgency()
    const hpFrac = me.hp / me.max_hp
    if (zu >= 0.7) {
      const sp = this.zoneSafePoint()
      return { label: "zone", goal: sp, boost: zu >= 1 || this.zoneMargin(P[0], P[1], this.t + 3) < 0 }
    }
    const inZoneLater = (x: number, y: number) => this.zoneMargin(x, y, Math.max(t + 20, this.obsZone.shrink_end)) > 8 || this.zoneMargin(x, y, t + 25) > 15
    const near = (p: V3) => hyp(p[0] - P[0], p[1] - P[1])

    // avoid walking into tracked enemies far away
    const danger = (x: number, y: number) => {
      let d = 0
      for (const e of threats) {
        const dd = hyp(e.pos[0] - x, e.pos[1] - y)
        if (dd < 120) d += (120 - dd) / 120
      }
      return d
    }

    type Opt = { s: number; label: string; goal: [number, number]; stopDist?: number; shoot?: any; look?: V3 }
    const opts: Opt[] = []

    // weapon pickups
    const worst = this.worstSlotValue()
    for (const p of this.pickups.values()) {
      const bad = this.badPickups.get(p.id)
      if (bad !== undefined && t - bad < 8) continue
      const v = WEAPON_VALUE[p.kind || ""] ?? 0
      if (v <= worst + 0.1) continue
      if (this.slotOf(p.kind || "") >= 0) continue
      const d = near(p.pos)
      if (d > 260) continue
      if (!inZoneLater(p.pos[0], p.pos[1])) continue
      const roof = p.pos[2] - this.w.groundAt(p.pos[0], p.pos[1]) > 3
      if (roof) continue
      opts.push({ s: (v - worst) * 9 - d * 0.18 - danger(p.pos[0], p.pos[1]) * 25, label: "loot " + p.kind, goal: [p.pos[0], p.pos[1]], stopDist: 0.5 })
    }
    // cubes
    for (const c of this.cubes.values()) {
      const d = near(c.pos)
      if (d > 220 || !inZoneLater(c.pos[0], c.pos[1])) continue
      if (c.pos[2] - this.w.groundAt(c.pos[0], c.pos[1]) > 3) continue
      opts.push({ s: env("W_CUBE", 40) - d * 0.18 - danger(c.pos[0], c.pos[1]) * 20, label: "cube", goal: [c.pos[0], c.pos[1]], stopDist: 0.3 })
    }
    // crates: shoot from range, walk to the cube afterwards
    for (const c of this.crates.values()) {
      if (this.badCrates.has(c.id)) continue
      const d = near(c.pos)
      if (d > 200 || !inZoneLater(c.pos[0], c.pos[1])) continue
      if (c.pos[2] - this.w.groundAt(c.pos[0], c.pos[1]) > 3) continue
      const cz = c.pos[2] + 1.2
      const los = d < 150 && this.canHitFrom(P[0], P[1], P[2], c.pos[0], c.pos[1], cz)
      const s = env("W_CRATE", 28) + (this.worstSlotValue() < 5 ? env("W_CRATE_EARLY", 8) : 0) - d * 0.15 - danger(c.pos[0], c.pos[1]) * 20
      opts.push({
        s, label: "crate", goal: los && d < 60 ? [P[0], P[1]] : [c.pos[0], c.pos[1]], stopDist: los ? 0 : 20,
        shoot: los ? { pos: [c.pos[0], c.pos[1], cz], vel: [0, 0, 0], r: 1.3, isMech: false } : undefined,
      })
    }
    // npc drones: worth 2 cubes, only when healthy
    if (hpFrac > env("NPC_HP", 0.55)) {
      for (const n of this.npcs.values()) {
        if (t - n.seen > 3) continue
        const d = near(n.pos)
        if (d > 170 || !inZoneLater(n.pos[0], n.pos[1])) continue
        const cz = n.pos[2] + 1.75
        const los = this.canHitFrom(P[0], P[1], P[2], n.pos[0], n.pos[1], cz)
        // fight from ~55 m: outside their aggro radius unless they chase
        let gx = n.pos[0], gy = n.pos[1]
        const want = this.weapon("lightning") && me.energy > 30 ? 30 : 55
        if (d > 1) { gx = n.pos[0] + ((P[0] - n.pos[0]) / d) * want; gy = n.pos[1] + ((P[1] - n.pos[1]) / d) * want }
        opts.push({
          s: env("W_NPC", 30) - d * 0.15 + (n.hp < n.maxHp ? 6 : 0) - danger(n.pos[0], n.pos[1]) * 20 - (1 - hpFrac) * 20,
          label: "npc", goal: [gx, gy], stopDist: 4,
          shoot: los ? { pos: [n.pos[0], n.pos[1], cz], vel: n.vel, r: 1.8, isMech: false } : undefined,
          look: [n.pos[0], n.pos[1], cz],
        })
      }
    }
    // supply drops
    for (const dr of this.obsDrops) {
      const d = hyp(dr.pos[0] - P[0], dr.pos[1] - P[1])
      const eta = d / 13
      if (eta + 2 < dr.lands_in - 6) continue
      if (dr.holder !== null && dr.holder !== this.me.id) continue
      const dg = danger(dr.pos[0], dr.pos[1])
      opts.push({ s: env("W_DROP", 45) - d * 0.12 - dg * 30 + (1 - hpFrac) * 15, label: "drop", goal: [dr.pos[0], dr.pos[1]], stopDist: 0.5 })
    }

    // regroup: when hurt, sit somewhere hidden from recent contacts
    if (hpFrac < 0.6 && t - this.lastHurt < 12) {
      const away = this.awayFromContacts()
      if (away) opts.push({ s: 30 + (1 - hpFrac) * 30, label: "hide", goal: away, stopDist: 2 })
    }

    // explore inside the next circle
    const ex = this.exploreTarget()
    if (ex) opts.push({ s: 5, label: "explore", goal: ex, stopDist: 6 })

    let best: Opt | null = null
    for (const o of opts) if (!best || o.s > best.s) best = o
    if (!best) {
      const sp = this.zoneSafePoint()
      return { label: "center", goal: sp }
    }
    // keep shooting a crate/npc in view while doing something else
    let shoot = best.shoot
    let look = best.look
    if (!shoot) {
      for (const o of opts) if (o.shoot && o.label !== "npc") { shoot = o.shoot; break }
    }
    if (!look && !shoot) look = this.scanLook()
    return { label: best.label, goal: best.goal, stopDist: best.stopDist, shoot, look, boost: best.label === "drop" || best.label === "hide" }
  }
  obsDrops: any[] = []

  awayFromContacts(): [number, number] | null {
    const P = this.P, t = this.t
    let sx = 0, sy = 0, n = 0
    for (const c of this.contacts) if (t - c.t < 8) { sx += c.x * c.w; sy += c.y * c.w; n += c.w }
    for (const e of this.enemies.values()) if (t - e.seen < 10) { sx += e.pos[0] * 3; sy += e.pos[1] * 3; n += 3 }
    if (n === 0) return null
    const cx = sx / n, cy = sy / n
    let best: [number, number] | null = null, bs = -1e9
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU
      for (const r of [15, 30, 50]) {
        const x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r
        if (!this.w.standableAt(x, y)) continue
        if (this.zoneMargin(x, y, t + 10) < 10) continue
        const z = this.w.surfAt(x, y)
        const hidden = !this.w.clear(cx, cy, this.w.surfAt(cx, cy) + 8, x, y, z + 5)
        const s = (hidden ? 40 : 0) + hyp(x - cx, y - cy) * 0.3 - r * 0.2
        if (s > bs) { bs = s; best = [x, y] }
      }
    }
    return best
  }

  exploreTarget(): [number, number] | null {
    const z = this.obsZone, t = this.t, P = this.P
    const cx = z.next_center[0], cy = z.next_center[1]
    const R = Math.max(20, z.next_radius * 0.85)
    let best: [number, number] | null = null, bs = -1e9
    for (let k = 0; k < 24; k++) {
      const a = this.rand() * TAU, r = Math.sqrt(this.rand()) * R
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
      if (!this.w.inBounds(x, y)) continue
      const vk = (Math.floor((x + 600) / 40) << 8) | Math.floor((y + 400) / 40)
      const last = this.visited.get(vk) ?? -999
      const d = hyp(x - P[0], y - P[1])
      const s = Math.min(90, t - last) - d * 0.12
      if (s > bs) { bs = s; best = [x, y] }
    }
    if (this.exploreGoal && this.t - this.exploreAt < 15 && hyp(this.exploreGoal[0] - P[0], this.exploreGoal[1] - P[1]) > 12) {
      if (this.zoneMargin(this.exploreGoal[0], this.exploreGoal[1], Math.max(t + 15, z.shrink_end)) > 5) return this.exploreGoal
    }
    this.exploreGoal = best
    this.exploreAt = t
    return best
  }
  exploreGoal: [number, number] | null = null
  exploreAt = -99

  nearWeapon(maxD: number): [number, number] | null {
    const P = this.P, t = this.t
    let best: [number, number] | null = null, bd = maxD
    for (const p of this.pickups.values()) {
      const v = WEAPON_VALUE[p.kind || ""] ?? 0
      if (v < 7.9 || this.slotOf(p.kind || "") >= 0) continue
      const bad = this.badPickups.get(p.id)
      if (bad !== undefined && t - bad < 8) continue
      if (p.pos[2] - this.w.groundAt(p.pos[0], p.pos[1]) > 3) continue
      const d = hyp(p.pos[0] - P[0], p.pos[1] - P[1])
      if (d < bd) { bd = d; best = [p.pos[0], p.pos[1]] }
    }
    return best
  }

  scanLook(): V3 {
    const P = this.P, t = this.t
    // full turn at the start to spot loot
    if (t < 1.8 && env("SPIN", 0) > 0) {
      const a = this.me.aim[0] + 1.4
      return [P[0] + Math.cos(a) * 50, P[1] + Math.sin(a) * 50, P[2] + 6]
    }
    // look toward the freshest contact, otherwise sweep
    let bc: any = null
    for (const c of this.contacts) if (!bc || c.t > bc.t) bc = c
    if (bc && t - bc.t < 4) return [bc.x, bc.y, P[2] + 6]
    if (t - this.lastHurt < 3) return [P[0] + Math.cos(this.hurtBearing) * 50, P[1] + Math.sin(this.hurtBearing) * 50, P[2] + 6]
    const mv = this.lastMoveCmd
    let base = hyp(mv[0], mv[1]) > 0.3 ? Math.atan2(mv[1], mv[0]) : this.scanYaw
    this.scanYaw = base + Math.sin(t * 0.9) * 1.2
    return [P[0] + Math.cos(this.scanYaw) * 50, P[1] + Math.sin(this.scanYaw) * 50, P[2] + 6]
  }

  worstSlotValue() {
    const ws = this.me.weapons
    let worst = 1e9
    for (let i = 0; i < ws.length; i++) {
      const v = ws[i] ? WEAPON_VALUE[ws[i].kind] ?? 0 : 0
      if (v < worst) worst = v
    }
    return worst
  }

  considerTake(): { id: number; drop?: number } | null {
    const P = this.P, ws = this.me.weapons, t = this.t
    for (const p of this.pickups.values()) {
      if (hyp(p.pos[0] - P[0], p.pos[1] - P[1]) > 3.8 || Math.abs(p.pos[2] - P[2]) > 3.8) continue
      const bad = this.badPickups.get(p.id)
      if (bad !== undefined && t - bad < 3) continue
      const kind = p.kind || ""
      if (this.slotOf(kind) >= 0) continue
      const v = WEAPON_VALUE[kind] ?? 0
      let empty = -1, worstI = -1, worstV = 1e9
      for (let i = 0; i < ws.length; i++) {
        if (!ws[i]) { if (empty < 0) empty = i; continue }
        const wv = WEAPON_VALUE[ws[i].kind] ?? 0
        if (wv < worstV) { worstV = wv; worstI = i }
      }
      if (empty >= 0) return { id: p.id }
      if (v > worstV + 0.1) {
        const w = ws[worstI]
        if (w.kind === "laser" && w.charge > 0) continue
        return { id: p.id, drop: worstI }
      }
    }
    return null
  }

  // ---------------- movement ----------------

  followTo(gx: number, gy: number, stopDist: number): [number, number] {
    const P = this.P, w = this.w, t = this.t
    const d = hyp(gx - P[0], gy - P[1])
    if (d <= stopDist) return [0, 0]
    if (d < 25 && w.lineWalkable(P[0], P[1], gx, gy)) {
      const s = d < 4 ? Math.max(0.35, d / 4) : 1
      return [((gx - P[0]) / d) * s, ((gy - P[1]) / d) * s]
    }
    const needPlan =
      !this.route ||
      hyp(gx - this.routeGoal[0], gy - this.routeGoal[1]) > 10 ||
      t - this.routeAt > 2.5
    if (needPlan) {
      const t0 = performance.now()
      const r = w.path(P[0], P[1], gx, gy, 25000)
      this.pt("path", t0)
      this.route = r
      this.routeGoal = [gx, gy]
      this.routeAt = t
      this.routeIdx = 0
    }
    const r = this.route
    if (!r || r.length === 0) return [(gx - P[0]) / d, (gy - P[1]) / d]
    // nearest route point ahead of current index
    let bi = this.routeIdx, bd = 1e9
    for (let i = this.routeIdx; i < Math.min(r.length, this.routeIdx + 30); i++) {
      const dd = hyp(w.cellX(r[i]) - P[0], w.cellY(r[i]) - P[1])
      if (dd < bd) { bd = dd; bi = i }
    }
    if (bd > 12) { this.route = null }
    this.routeIdx = bi
    // a climb coming up on the route: head at it and jet
    for (let i = bi + 1; i < Math.min(r.length, bi + 5); i++) {
      const h = w.navH[r[i]]
      if (h - Math.max(P[2], w.navH[r[i - 1]]) > 1.1) {
        const cx = w.cellX(r[i]), cy = w.cellY(r[i])
        const dc = hyp(cx - P[0], cy - P[1])
        if (dc < 9) {
          this.climbH = h
          this.climbUntil = t + 0.4
          if (dc < 0.5) return [0, 0]
          return [(cx - P[0]) / dc, (cy - P[1]) / dc]
        }
        break
      }
    }
    let tgt = Math.min(r.length - 1, bi + 1)
    for (let i = Math.min(r.length - 1, bi + 14); i > bi; i--) {
      if (w.lineWalkable(P[0], P[1], w.cellX(r[i]), w.cellY(r[i]))) { tgt = i; break }
    }
    let tx = w.cellX(r[tgt]), ty = w.cellY(r[tgt])
    if (tgt === r.length - 1) { tx = gx; ty = gy }
    const dd = hyp(tx - P[0], ty - P[1])
    if (dd < 0.01) return [0, 0]
    return [(tx - P[0]) / dd, (ty - P[1]) / dd]
  }

  preferredRange(target: Enemy) {
    const hasL = !!this.weapon("lightning")
    const hasLaser = !!this.weapon("laser")
    const hpFrac = this.me.hp / this.me.max_hp
    const theyL = target.weapons.includes("lightning")
    if (hasL && this.me.energy > 20 && hpFrac > 0.4) return 22
    if (theyL && !hasL) return 75
    if (hasLaser) return env("PREF_LASER", 30)
    return env("PREF_GUN", 20)
  }

  fightMove(target: Enemy, threats: Enemy[], hpFrac: number): { move: [number, number]; boost: boolean } {
    const P = this.P, w = this.w, t = this.t, me = this.me
    const tx = target.pos[0], ty = target.pos[1], tz = this.centerOf(target)
    const dT = hyp(tx - P[0], ty - P[1])
    const gun = this.weapon("gun"), laser = this.weapon("laser"), light = this.weapon("lightning")
    const gunReady = !!gun && (gun.ammo ?? 0) > 0 && !(gun.reload > 0)
    const laserReady = !!laser && laser.cooldown < 0.35
    const lightReady = !!light && me.energy > 12
    const ready = gunReady || laserReady || (lightReady && dT < 60)
    const R = (laserReady ? 1 : 0) + (gunReady ? 0.6 : 0) + (lightReady && dT < 50 ? 1 : 0)
    const eFrac = target.hp / Math.max(1, target.maxHp)
    const live = threats.filter((e) => t - e.seen < 4 && hyp(e.pos[0] - P[0], e.pos[1] - P[1]) < 200)
    let aggr = clamp(hpFrac * 1.25 - 0.3 + (1 - eFrac) * 0.5 - 0.2 * (live.length - 1) + (this.me.cubes || 0) * 0.02, 0, 1)
    if (hpFrac < 0.3 && eFrac > hpFrac + 0.1) aggr = 0
    const pref = this.preferredRange(target)

    if (MODE === "duel") return this.duelMove(target, dT, pref)
    const zoneT = t + 6
    const cands: [number, number][] = [[P[0], P[1]]]
    for (const r of [5, 10, 17, 26]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU + (r === 10 || r === 26 ? Math.PI / 12 : 0)
        cands.push([P[0] + Math.cos(a) * r, P[1] + Math.sin(a) * r])
      }
    }
    if (this.fightGoal && t - this.fightGoalAt < 3) cands.push(this.fightGoal)

    let best = cands[0], bs = -1e9, bestExpo = 0, anyHit = false
    const myZ0 = P[2]
    const tStart = performance.now()
    for (let ci = 0; ci < cands.length; ci++) {
      if (ci > 12 && performance.now() - tStart > 12) break
      const [x, y] = cands[ci]
      const isHere = ci === 0
      if (!isHere) {
        if (!w.standableAt(x, y)) continue
        if (!w.lineWalkable(P[0], P[1], x, y)) continue
      }
      const z = isHere ? myZ0 : w.surfAt(x, y)
      const dm = hyp(x - P[0], y - P[1])
      let s = -dm * 0.12
      const zm = this.zoneMargin(x, y, zoneT)
      if (zm < 4) s -= 40 + (4 - zm) * 2
      let expo = 0
      for (const e of live) {
        const de = hyp(e.pos[0] - x, e.pos[1] - y)
        let wgt = 1
        if (e.weapons.includes("laser")) wgt += 0.8
        if (e.weapons.includes("lightning") && de < 50) wgt += 1.2
        if (e.charging) wgt += t - e.chargeSince > 0.35 ? env("CHW", 5) : 1.5
        wgt *= 0.4 + 0.6 * (e.hp / Math.max(1, e.maxHp))
        if (de > 230) wgt *= 0.3
        if (this.exposedTo(e, x, y, z)) expo += wgt
      }
      const canHit = this.canHitFrom(x, y, z, tx, ty, tz)
      if (canHit) anyHit = true
      const dTx = hyp(tx - x, ty - y)
      if (ready && aggr > 0.35) {
        if (canHit) s += 6 + 10 * Math.min(1.6, R) * aggr
        s -= expo * (2 + (1 - aggr) * 8 + (R < 0.7 ? 5 : 0))
        s -= Math.abs(dTx - pref) * 0.07 * (0.5 + aggr)
      } else {
        s -= expo * 12
        if (canHit && expo === 0) s += 2
        s += Math.min(dTx, 120) * 0.04
      }
      // keep every shooter inside the front arc
      if (live.length > 1) {
        const yT = Math.atan2(ty - y, tx - x)
        for (const e of live) {
          if (e === target) continue
          const off = Math.abs(wrap(Math.atan2(e.pos[1] - y, e.pos[0] - x) - yT))
          if (off > 1.4 && this.exposedTo(e, x, y, z)) s -= (off - 1.4) * env("ARC", 6)
        }
      }
      // stay out of arc range of lightning carriers unless we brawl too
      if (!light || hpFrac < 0.4) {
        for (const e of live) {
          if (!e.weapons.includes("lightning")) continue
          const de = hyp(e.pos[0] - x, e.pos[1] - y)
          if (de < 50) s -= (50 - de) * env("LKITE", 4)
        }
      }
      // spacing from secondary threats
      for (const e of live) {
        if (e === target) continue
        const de = hyp(e.pos[0] - x, e.pos[1] - y)
        if (de < 40) s -= (40 - de) * 0.2
      }
      if (light && dTx < 40 && canHit) s += 4
      if (this.fightGoal && hyp(x - this.fightGoal[0], y - this.fightGoal[1]) < 3) s += 1.5
      if (s > bs) { bs = s; best = [x, y]; bestExpo = expo }
    }
    // losing and nowhere close to hide: run to a spot out of everyone's sight
    if (aggr < env("RETREAT", 0.05) && bestExpo > 0 && live.length) {
      const spot = this.retreatSpot(live)
      if (spot) {
        this.fightGoal = null
        const mv = this.followTo(spot[0], spot[1], 2)
        return { move: mv, boost: me.energy > 8 }
      }
    }
    // nothing nearby gives a shot: go find them instead of waiting behind a wall
    if (!anyHit && ready && aggr > env("PUSH_AGGR", 2) && !(target as any).ghost) {
      this.fightGoal = null
      const mv = this.followTo(tx, ty, Math.min(pref, 30))
      return { move: mv, boost: me.energy > 40 && dT > 60 }
    }
    this.fightGoal = best
    this.fightGoalAt = t
    let mx = best[0] - P[0], my = best[1] - P[1]
    const ml = hyp(mx, my)
    let move: [number, number] = ml > 1 ? [mx / ml, my / ml] : [0, 0]
    if (ml <= 1 && ml > 0.2) move = [mx / ml * 0.5, my / ml * 0.5]

    // strafe so bullets led at us miss; strongest at range where travel time is long
    let exposedNow = false
    for (const e of live) if (this.exposedTo(e, P[0], P[1], P[2])) { exposedNow = true; break }
    if (exposedNow) {
      if (t > this.jinkNext) {
        this.jinkSign = -this.jinkSign
        this.jinkNext = t + 0.35 + this.rand() * 0.6
      }
      const ax = (tx - P[0]) / Math.max(1, dT), ay = (ty - P[1]) / Math.max(1, dT)
      let px = -ay * this.jinkSign, py = ax * this.jinkSign
      // don't strafe into walls
      if (!w.lineWalkable(P[0], P[1], P[0] + px * 6, P[1] + py * 6)) { this.jinkSign = -this.jinkSign; px = -px; py = -py }
      const js = dT > 30 ? 0.9 : 0.6
      move = [move[0] * 0.8 + px * js, move[1] * 0.8 + py * js]
      const l = hyp(move[0], move[1])
      if (l > 1) move = [move[0] / l, move[1] / l]
    }
    const boost = (exposedNow && me.energy > 35) || (ml > 8 && me.energy > 30) || (aggr < 0.2 && me.energy > 10)
    return { move, boost }
  }

  // plain stand-and-fight: hold range, strafe, never hide
  duelMove(target: Enemy, dT: number, pref: number): { move: [number, number]; boost: boolean } {
    const P = this.P, t = this.t, w = this.w
    const tx = target.pos[0], ty = target.pos[1]
    const ux = (tx - P[0]) / Math.max(1, dT), uy = (ty - P[1]) / Math.max(1, dT)
    const los = this.canHitFrom(P[0], P[1], P[2], tx, ty, this.centerOf(target))
    if (!los) return { move: this.followTo(tx, ty, 8), boost: this.me.energy > 40 }
    if (t > this.jinkNext) { this.jinkSign = -this.jinkSign; this.jinkNext = t + 0.4 + this.rand() * 0.7 }
    let px = -uy * this.jinkSign, py = ux * this.jinkSign
    if (!w.lineWalkable(P[0], P[1], P[0] + px * 6, P[1] + py * 6)) { this.jinkSign = -this.jinkSign; px = -px; py = -py }
    const k = clamp((dT - pref) / 25, -1, 1)
    const jk = env("JINK", 0.8), rk = env("RADIAL", 0.7)
    let mx = ux * k * rk + px * jk, my = uy * k * rk + py * jk
    const l = hyp(mx, my)
    if (l > 1) { mx /= l; my /= l }
    if (this.zoneMargin(P[0] + mx * 10, P[1] + my * 10, t + 5) < 3) { const sp = this.zoneSafePoint(); return { move: this.followTo(sp[0], sp[1], 3), boost: true } }
    return { move: [mx, my], boost: this.me.energy > env("DUEL_BOOST", 45) }
  }

  retreatSpot(live: Enemy[]): [number, number] | null {
    const P = this.P, t = this.t, w = this.w
    if (this.retreat && t - this.retreatAt < 1.5) {
      const [x, y] = this.retreat
      if (hyp(x - P[0], y - P[1]) > 3) return this.retreat
    }
    let cx = 0, cy = 0
    for (const e of live) { cx += e.pos[0]; cy += e.pos[1] }
    cx /= live.length; cy /= live.length
    let best: [number, number] | null = null, bs = -1e9
    const t0 = performance.now()
    for (const r of [30, 45, 65]) {
      for (let k = 0; k < 16; k++) {
        if (performance.now() - t0 > 8) break
        const a = (k / 16) * TAU
        const x = P[0] + Math.cos(a) * r, y = P[1] + Math.sin(a) * r
        if (!w.standableAt(x, y)) continue
        if (this.zoneMargin(x, y, t + 12) < 6) continue
        const z = w.surfAt(x, y)
        let seen = false
        for (const e of live) if (this.exposedTo(e, x, y, z)) { seen = true; break }
        if (seen) continue
        // moving toward the enemy to get there is bad
        const toward = ((x - P[0]) * (cx - P[0]) + (y - P[1]) * (cy - P[1])) / (r * (hyp(cx - P[0], cy - P[1]) || 1))
        const s = -r * 0.5 - toward * 25 + Math.min(hyp(x - cx, y - cy), 150) * 0.15
        if (s > bs) { bs = s; best = [x, y] }
      }
    }
    this.retreat = best
    this.retreatAt = t
    return best
  }
  retreat: [number, number] | null = null
  retreatAt = -99

  dodgeVector(obs: any): [number, number] | null {
    const P = this.P
    const cz = P[2] + 4.5 * this.scale
    const R = 2.5 * this.scale + 1.2
    let dx = 0, dy = 0, any = false
    for (const pr of obs.projectiles) {
      const [px, py, pz] = pr.pos
      const [vx, vy, vz] = pr.vel
      if (pr.kind === "mortar") {
        const g = this.cfg.weapons.mortar.gravity
        // march the shell forward to the ground
        let x = px, y = py, z = pz, ux = vx, uy = vy, uz = vz
        let hit = false
        for (let s = 0; s < 80; s++) {
          const dt = 0.05
          x += ux * dt; y += uy * dt; z += uz * dt; uz -= g * dt
          if (this.w.solidAt(x, y, z) || z < this.w.groundAt(x, y)) { hit = true; break }
        }
        if (!hit) continue
        const d = hyp(x - P[0], y - P[1])
        const sr = this.cfg.weapons.mortar.splash_radius + 4 + 2.5 * this.scale
        if (d < sr) {
          const k = (sr - d) / sr + 0.5
          if (d < 0.5) { dx += Math.cos(this.rand() * TAU) * k; dy += Math.sin(this.rand() * TAU) * k }
          else { dx += ((P[0] - x) / d) * k; dy += ((P[1] - y) / d) * k }
          any = true
        }
        continue
      }
      const v2 = vx * vx + vy * vy + vz * vz
      if (v2 < 1) continue
      const rx = P[0] - px, ry = P[1] - py, rz = cz - pz
      const tc = (rx * vx + ry * vy + rz * vz) / v2
      if (tc < 0 || tc > 0.7) continue
      const cx = px + vx * tc - P[0], cy = py + vy * tc - P[1]
      const miss = hyp(cx, cy)
      if (miss > R) continue
      // sidestep perpendicular to the bullet, away from its line
      const vl = hyp(vx, vy) || 1
      let nx = -vy / vl, ny = vx / vl
      if (nx * -cx + ny * -cy < 0) { nx = -nx; ny = -ny }
      dx += nx * 0.8; dy += ny * 0.8
      any = true
    }
    if (!any) return null
    const l = hyp(dx, dy)
    if (l < 1e-3) return null
    return [dx / l, dy / l]
  }

  // ---------------- weapons ----------------

  fireControl(shootAt: { pos: V3; vel: V3; r: number; isMech: boolean; e?: Enemy } | null, lookAt: V3 | null, move: [number, number]) {
    const me = this.me, P = this.P, t = this.t
    const ws = me.weapons
    const fire = [false, false]
    let reload = false
    const myAim = me.aim
    const mz = P[2] + me.stats.muzzle_height
    let aim: [number, number] = [this.aimCmd[0], this.aimCmd[1]]

    const gunI = this.slotOf("gun"), laserI = this.slotOf("laser"), lightI = this.slotOf("lightning"), mortI = this.slotOf("mortar")
    const gun = gunI >= 0 ? ws[gunI] : null
    const laser = laserI >= 0 ? ws[laserI] : null

    if (!shootAt) {
      const la = lookAt ?? this.scanLook()
      const dx = la[0] - P[0], dy = la[1] - P[1]
      aim = [Math.atan2(dy, dx), clamp(Math.atan2(la[2] - (P[2] + 8), hyp(dx, dy)), -0.3, 0.3)]
      if (gun && gun.ammo < gun.stats.mag * 0.5 && !(gun.reload > 0)) reload = true
      // never sit on a full charge with nothing to shoot
      if (laser && laser.charge > 0) {
        fire[laserI] = laser.charge < laser.stats.charge + this.cfg.weapons.laser.hold_s - 0.4
      }
      return { aim, fire, reload }
    }

    const [sx, sy, sz] = shootAt.pos
    const dist = hyp(sx - P[0], sy - P[1])
    const los = this.w.clear(P[0], P[1], mz, sx, sy, sz)
    const vel = shootAt.vel

    // gun lead
    const gs = gun ? gun.stats.speed : 252
    let lx = sx, ly = sy, lz = sz
    {
      let tt = hyp(sx - P[0], sy - P[1], sz - mz) / gs
      // airborne targets follow a ballistic arc unless they jet; stop at the ground
      const tgtFeet = sz - (shootAt.isMech ? 4.5 : 1.5)
      const airborne = Math.abs(vel[2]) > 0.3 || tgtFeet - this.w.surfAt(sx, sy) > 0.8
      const g = this.cfg.mech.gravity
      for (let k = 0; k < 3; k++) {
        lx = sx + vel[0] * tt; ly = sy + vel[1] * tt
        lz = airborne ? sz + vel[2] * tt - 0.5 * g * tt * tt * 0.7 : sz
        if (airborne) {
          const floor = this.w.surfAt(lx, ly) + (sz - tgtFeet)
          if (lz < floor) lz = floor
        }
        tt = hyp(lx - P[0], ly - P[1], lz - mz) / gs + 0.05
      }
    }
    const aimTo = (x: number, y: number, z: number): [number, number] => {
      const dx = x - P[0], dy = y - P[1]
      return [Math.atan2(dy, dx), Math.atan2(z - mz, hyp(dx, dy))]
    }
    const gunAim = aimTo(lx, ly, lz)
    const laserAim = aimTo(sx + vel[0] * 0.1, sy + vel[1] * 0.1, sz)
    const angErr = (a: [number, number]) => {
      const dy = wrap(myAim[0] - a[0])
      const dp = myAim[1] - a[1]
      return Math.sqrt(dy * dy * Math.cos(a[1]) ** 2 + dp * dp)
    }
    const tol = Math.atan2(shootAt.r * 0.75, Math.max(1, dist))

    aim = gunAim
    let usingMortar = false

    // laser: charge while we have a line, release on target once full
    if (laser) {
      const full = laser.stats.charge
      const charging = laser.charge > 0
      if (charging) {
        const nearFull = laser.charge >= full - 0.05
        const forced = laser.charge >= full + this.cfg.weapons.laser.hold_s - 0.35
        if (nearFull) aim = laserAim
        const onTarget = angErr(laserAim) < tol
        if ((nearFull && los && onTarget) || forced) fire[laserI] = false
        else fire[laserI] = true
      } else if (laser.cooldown <= 0.05 && dist < laser.stats.range * 0.97 && (los || (shootAt.isMech && shootAt.e && t - shootAt.e.seen < 2.5 && env("PRECHARGE", 0) > 0))) {
        fire[laserI] = true
      }
    }

    // mortar when we can't see the target directly
    if (mortI >= 0 && ws[mortI].cooldown <= 0 && !los && dist > 25 && dist < 220 && !(laser && laser.charge > 0)) {
      const m = ws[mortI].stats
      const v = m.speed, g = m.gravity
      const tf0 = dist / (v * 0.7)
      const ax = sx + vel[0] * tf0, ay = sy + vel[1] * tf0
      const dd = hyp(ax - P[0], ay - P[1])
      const dz = shootAt.pos[2] - 4 - (P[2] + 9.5 * this.scale)
      const disc = v ** 4 - g * (g * dd * dd + 2 * dz * v * v)
      if (disc > 0) {
        const th = Math.atan((v * v + Math.sqrt(disc)) / (g * dd))
        if (th < me.stats.max_pitch) {
          const ma: [number, number] = [Math.atan2(ay - P[1], ax - P[0]), th]
          aim = ma
          usingMortar = true
          if (angErr(ma) < 0.03) fire[mortI] = true
        }
      }
    } else if (mortI >= 0 && ws[mortI].cooldown <= 0 && los && dist > 40 && dist < 200 && shootAt.isMech && gun && gun.reload > 0) {
      // gun reloading: lob a low shell at them
      const m = ws[mortI].stats
      const v = m.speed, g = m.gravity
      const tf0 = dist / (v * 0.9)
      const ax = sx + vel[0] * tf0, ay = sy + vel[1] * tf0
      const dd = hyp(ax - P[0], ay - P[1])
      const dz = shootAt.pos[2] - 4 - (P[2] + 9.5 * this.scale)
      const disc = v ** 4 - g * (g * dd * dd + 2 * dz * v * v)
      if (disc > 0) {
        const th = Math.atan((v * v - Math.sqrt(disc)) / (g * dd))
        const ma: [number, number] = [Math.atan2(ay - P[1], ax - P[0]), th]
        aim = ma
        usingMortar = true
        if (angErr(ma) < 0.025) fire[mortI] = true
      }
    }

    // gun
    if (gun && !usingMortar) {
      const inRange = dist < gun.stats.range * 0.98
      const leadClear = this.w.clear(P[0], P[1], mz, lx, ly, lz)
      if ((gun.ammo ?? 0) > 0 && !(gun.reload > 0) && inRange && (los || leadClear) && angErr(gunAim) < tol * 1.3 + 0.004) {
        if (shootAt.isMech || dist < 160) fire[gunI] = true
      }
      if ((gun.ammo ?? 0) === 0 && !(gun.reload > 0)) reload = true
    }

    // lightning auto-targets inside its cone; just keep the cone on them
    if (lightI >= 0) {
      const L = ws[lightI].stats
      const yawErr = Math.abs(wrap(myAim[0] - Math.atan2(sy - P[1], sx - P[0])))
      const d3 = hyp(sx - P[0], sy - P[1], sz - mz)
      if (d3 < L.range * 0.97 && yawErr < (L.cone_deg * Math.PI) / 180 * 0.5 && los && me.energy >= L.energy && ws[lightI].cooldown <= 0.05) fire[lightI] = true
    }

    aim = [aim[0], clamp(aim[1], me.stats.min_pitch, me.stats.max_pitch)]
    return { aim, fire, reload }
  }
}
