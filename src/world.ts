import { readFileSync } from "node:fs"

// Static map: terrain + a 1 m raster of solid intervals, plus a 2 m nav grid.

const NONE_BASE = 1e9
const NONE_TOP = -1e9

export class World {
  minX = 0
  minY = 0
  nx = 0
  ny = 0
  ground!: Float32Array
  sBase!: Float32Array
  sTop!: Float32Array
  surf!: Float32Array
  bx0 = 0
  bx1 = 0
  by0 = 0
  by1 = 0

  // nav grid, 2 m cells
  NX = 0
  NY = 0
  navH!: Float32Array
  stand!: Uint8Array
  // nav cell sits on a building/bridge top rather than terrain
  navSolid!: Uint8Array
  rSolid!: Uint8Array
  // distance (in cells) to nearest unstandable cell, capped
  open!: Uint8Array

  private g!: Float32Array
  private came!: Int32Array
  private stamp!: Uint32Array
  private closed!: Uint32Array
  private gen = 0
  maxClimb = 18
  pathBudgetMs = 10
  private heapI!: Int32Array
  private heapF!: Float32Array

  constructor(dir: string) {
    const w = JSON.parse(readFileSync(dir + "/v2/world.json", "utf8"))
    const t = w.terrain
    this.minX = t.minX
    this.minY = t.minY
    this.nx = t.nx
    this.ny = t.ny
    const raw = readFileSync(dir + "/v2/" + (t.file || "terrain.i16"))
    const bytes = new Uint8Array(raw.byteLength)
    bytes.set(raw)
    const i16 = new Int16Array(bytes.buffer, 0, this.nx * this.ny)
    const n = this.nx * this.ny
    const scale = t.scale ?? 0.01
    this.ground = new Float32Array(n)
    for (let k = 0; k < n; k++) this.ground[k] = i16[k] * scale
    this.bx0 = w.bounds.minX
    this.bx1 = w.bounds.maxX
    this.by0 = w.bounds.minY
    this.by1 = w.bounds.maxY

    this.sBase = new Float32Array(n).fill(NONE_BASE)
    this.sTop = new Float32Array(n).fill(NONE_TOP)
    for (const p of w.prisms) this.rasterPrism(p)

    this.surf = new Float32Array(n)
    this.rSolid = new Uint8Array(n)
    for (let k = 0; k < n; k++) {
      const g = this.ground[k]
      const top = this.sTop[k]
      if (top > NONE_TOP && !(this.sBase[k] - g >= 9.2) && top > g + 0.05) { this.surf[k] = top; this.rSolid[k] = 1 }
      else this.surf[k] = g
    }
    this.buildNav()
  }

  private rasterPrism(p: any) {
    const ring: number[] = p.ring
    const polys: number[][] = [ring, ...(p.holes || [])]
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let k = 0; k < ring.length; k += 2) {
      x0 = Math.min(x0, ring[k]); x1 = Math.max(x1, ring[k])
      y0 = Math.min(y0, ring[k + 1]); y1 = Math.max(y1, ring[k + 1])
    }
    const i0 = Math.max(0, Math.floor(x0 - this.minX)), i1 = Math.min(this.nx - 1, Math.ceil(x1 - this.minX))
    const j0 = Math.max(0, Math.floor(y0 - this.minY)), j1 = Math.min(this.ny - 1, Math.ceil(y1 - this.minY))
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      // scanline: collect crossings
      const xs: number[] = []
      for (const poly of polys) {
        const m = poly.length
        for (let a = 0, b = m - 2; a < m; b = a, a += 2) {
          const ya = poly[a + 1], yb = poly[b + 1]
          if ((ya > y) !== (yb > y)) {
            xs.push(poly[a] + ((y - ya) / (yb - ya)) * (poly[b] - poly[a]))
          }
        }
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const ia = Math.max(i0, Math.ceil(xs[q] - this.minX)), ib = Math.min(i1, Math.floor(xs[q + 1] - this.minX))
        for (let i = ia; i <= ib; i++) {
          const k = j * this.nx + i
          if (p.base < this.sBase[k]) this.sBase[k] = p.base
          if (p.top > this.sTop[k]) this.sTop[k] = p.top
        }
      }
    }
  }

  idx(x: number, y: number) {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  groundAt(x: number, y: number) {
    const fx = x - this.minX, fy = y - this.minY
    let i = Math.floor(fx), j = Math.floor(fy)
    if (i < 0) i = 0; else if (i > this.nx - 2) i = this.nx - 2
    if (j < 0) j = 0; else if (j > this.ny - 2) j = this.ny - 2
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j))
    const k = j * this.nx + i, G = this.ground
    const a = G[k] + (G[k + 1] - G[k]) * tx
    const b = G[k + this.nx] + (G[k + this.nx + 1] - G[k + this.nx]) * tx
    return a + (b - a) * ty
  }

  surfAt(x: number, y: number) {
    return this.surf[this.idx(x, y)]
  }

  solidAt(x: number, y: number, z: number) {
    const k = this.idx(x, y)
    return z < this.ground[k] - 0.4 || (z >= this.sBase[k] && z <= this.sTop[k])
  }

  inBounds(x: number, y: number) {
    return x > this.bx0 && x < this.bx1 && y > this.by0 && y < this.by1
  }

  // straight segment free of buildings and terrain (trees ignored, they don't stop shots)
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 0.9) {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const n = Math.ceil(len / step)
    if (n < 2) return true
    const nx = this.nx, ny = this.ny, mx = this.minX, my = this.minY
    const G = this.ground, B = this.sBase, T = this.sTop
    for (let s = 1; s < n; s++) {
      const t = s / n
      const x = ax + dx * t, y = ay + dy * t, z = az + dz * t
      const i = Math.round(x - mx), j = Math.round(y - my)
      if (i < 0 || j < 0 || i >= nx || j >= ny) return false
      const k = j * nx + i
      if (z < G[k] - 0.4) return false
      if (z >= B[k] && z <= T[k]) return false
    }
    return true
  }

  // fraction of the way until the segment hits something (1 = clear)
  hitFrac(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 1.0) {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const n = Math.ceil(len / step)
    for (let s = 1; s <= n; s++) {
      const t = s / n
      if (this.solidAt(ax + dx * t, ay + dy * t, az + dz * t)) return t
    }
    return 1
  }

  // ---------- navigation ----------

  private buildNav() {
    const NX = (this.NX = Math.floor((this.nx - 1) / 2) + 1)
    const NY = (this.NY = Math.floor((this.ny - 1) / 2) + 1)
    const N = NX * NY
    this.navH = new Float32Array(N)
    this.stand = new Uint8Array(N)
    this.navSolid = new Uint8Array(N)
    const nx = this.nx, S = this.surf, RS = this.rSolid
    const R = 3
    const offs: number[] = []
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) if (di * di + dj * dj <= 2.8 * 2.8) offs.push(di, dj, Math.hypot(di, dj))
    const margin = 8
    for (let cj = 0; cj < NY; cj++) {
      for (let ci = 0; ci < NX; ci++) {
        const i = ci * 2, j = cj * 2
        const c = cj * NX + ci
        const h = S[j * nx + i]
        this.navH[c] = h
        this.navSolid[c] = RS[j * nx + i]
        const wx = this.minX + i, wy = this.minY + j
        if (wx < this.bx0 + margin || wx > this.bx1 - margin || wy < this.by0 + margin || wy > this.by1 - margin) continue
        let ok = 1
        for (let q = 0; q < offs.length; q += 3) {
          const ii = i + offs[q], jj = j + offs[q + 1]
          if (ii < 0 || jj < 0 || ii >= nx || jj >= this.ny) { ok = 0; break }
          const k = jj * nx + ii
          const dh = S[k] - h
          // buildings are walls; terrain only when steeper than the slope limit
          if (RS[k] ? dh > 1.2 : dh > 1.2 + offs[q + 2] * 1.1) { ok = 0; break }
        }
        this.stand[c] = ok
      }
    }
    // chamfer distance to blocked cells (capped at 255)
    const open = (this.open = new Uint8Array(N))
    for (let c = 0; c < N; c++) open[c] = this.stand[c] ? 255 : 0
    for (let cj = 0; cj < NY; cj++)
      for (let ci = 0; ci < NX; ci++) {
        const c = cj * NX + ci
        if (!open[c]) continue
        let v = open[c]
        if (ci > 0) v = Math.min(v, open[c - 1] + 1)
        if (cj > 0) v = Math.min(v, open[c - NX] + 1)
        if (ci > 0 && cj > 0) v = Math.min(v, open[c - NX - 1] + 1)
        if (ci < NX - 1 && cj > 0) v = Math.min(v, open[c - NX + 1] + 1)
        open[c] = v
      }
    for (let cj = NY - 1; cj >= 0; cj--)
      for (let ci = NX - 1; ci >= 0; ci--) {
        const c = cj * NX + ci
        if (!open[c]) continue
        let v = open[c]
        if (ci < NX - 1) v = Math.min(v, open[c + 1] + 1)
        if (cj < NY - 1) v = Math.min(v, open[c + NX] + 1)
        if (ci < NX - 1 && cj < NY - 1) v = Math.min(v, open[c + NX + 1] + 1)
        if (ci > 0 && cj < NY - 1) v = Math.min(v, open[c + NX - 1] + 1)
        open[c] = v
      }
    this.g = new Float32Array(N)
    this.came = new Int32Array(N)
    this.stamp = new Uint32Array(N)
    this.closed = new Uint32Array(N)
    this.heapI = new Int32Array(N * 2)
    this.heapF = new Float32Array(N * 2)
  }

  cellOf(x: number, y: number) {
    let ci = Math.round((x - this.minX) / 2), cj = Math.round((y - this.minY) / 2)
    if (ci < 0) ci = 0; else if (ci >= this.NX) ci = this.NX - 1
    if (cj < 0) cj = 0; else if (cj >= this.NY) cj = this.NY - 1
    return cj * this.NX + ci
  }
  cellX(c: number) { return this.minX + (c % this.NX) * 2 }
  cellY(c: number) { return this.minY + Math.floor(c / this.NX) * 2 }

  standableAt(x: number, y: number) {
    return this.stand[this.cellOf(x, y)] === 1
  }

  // nearest standable cell to (x, y), searching rings out to maxR cells; prefer cells
  // reachable without climbing above zMax when given
  nearestStand(x: number, y: number, maxR = 25, zMax = Infinity) {
    const c0 = this.cellOf(x, y)
    if (this.stand[c0] && this.navH[c0] <= zMax) return c0
    const ci0 = c0 % this.NX, cj0 = Math.floor(c0 / this.NX)
    let best = -1, bd = Infinity
    for (let r = 1; r <= maxR; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue
          const ci = ci0 + di, cj = cj0 + dj
          if (ci < 0 || cj < 0 || ci >= this.NX || cj >= this.NY) continue
          const c = cj * this.NX + ci
          if (!this.stand[c] || this.navH[c] > zMax) continue
          const d = di * di + dj * dj
          if (d < bd) { bd = d; best = c }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  // walkable straight line on the nav grid (no blocked cells, no climbs over step height)
  lineWalkable(ax: number, ay: number, bx: number, by: number, minOpen = 1) {
    const dx = bx - ax, dy = by - ay
    const len = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(len / 1.0))
    let pc = this.cellOf(ax, ay)
    let prevH = this.navH[pc]
    const stepLen = len / n
    for (let s = 1; s <= n; s++) {
      const t = s / n
      const c = this.cellOf(ax + dx * t, ay + dy * t)
      if (this.open[c] < minOpen) return false
      const h = this.navH[c]
      if (c !== pc) {
        const lim = this.navSolid[c] || this.navSolid[pc] ? 1.2 : 1.2 + stepLen * 1.1
        if (h - prevH > lim) return false
      }
      prevH = h
      pc = c
    }
    return true
  }

  // A* over the nav grid. extraCost(c) lets the caller add penalties (zone, danger).
  path(sx: number, sy: number, gx: number, gy: number, maxExpand = 40000, extraCost?: (c: number) => number, weight = 1.25): number[] | null {
    const NX = this.NX, NY = this.NY
    let s = this.cellOf(sx, sy)
    if (!this.stand[s]) {
      const alt = this.nearestStand(sx, sy, 6)
      if (alt < 0) return null
      s = alt
    }
    let goal = this.cellOf(gx, gy)
    if (!this.stand[goal]) {
      goal = this.nearestStand(gx, gy, 20)
      if (goal < 0) return null
    }
    if (s === goal) return [goal]
    const gen = ++this.gen
    const G = this.g, came = this.came, stamp = this.stamp, closed = this.closed
    const H = this.navH, stand = this.stand, open = this.open, navSolid = this.navSolid
    const hI = this.heapI, hF = this.heapF
    let hn = 0
    const gci = goal % NX, gcj = Math.floor(goal / NX)
    const heur = (c: number) => {
      const dx = Math.abs((c % NX) - gci), dy = Math.abs(Math.floor(c / NX) - gcj)
      return (dx > dy ? dx + 0.4142 * dy : dy + 0.4142 * dx) * weight
    }
    const push = (c: number, f: number) => {
      let i = hn++
      while (i > 0) {
        const p = (i - 1) >> 1
        if (hF[p] <= f) break
        hI[i] = hI[p]; hF[i] = hF[p]; i = p
      }
      hI[i] = c; hF[i] = f
    }
    const pop = () => {
      const top = hI[0]
      const lastI = hI[--hn], lastF = hF[hn]
      let i = 0
      for (;;) {
        let l = 2 * i + 1
        if (l >= hn) break
        if (l + 1 < hn && hF[l + 1] < hF[l]) l++
        if (hF[l] >= lastF) break
        hI[i] = hI[l]; hF[i] = hF[l]; i = l
      }
      hI[i] = lastI; hF[i] = lastF
      return top
    }
    const tStart = performance.now()
    stamp[s] = gen; G[s] = 0; came[s] = -1
    push(s, heur(s))
    let expanded = 0
    let bestC = s, bestH = heur(s)
    const DX = [1, -1, 0, 0, 1, 1, -1, -1]
    const DY = [0, 0, 1, -1, 1, -1, 1, -1]
    const DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142]
    while (hn > 0) {
      const c = pop()
      if (closed[c] === gen) continue
      closed[c] = gen
      if (c === goal) { bestC = c; break }
      const hc = heur(c)
      if (hc < bestH) { bestH = hc; bestC = c }
      if (++expanded > maxExpand) break
      if ((expanded & 1023) === 0 && performance.now() - tStart > this.pathBudgetMs) break
      const ci = c % NX, cj = (c - ci) / NX
      const hcur = H[c]
      for (let d = 0; d < 8; d++) {
        const ni = ci + DX[d], nj = cj + DY[d]
        if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue
        const nc = nj * NX + ni
        if (!stand[nc] || closed[nc] === gen) continue
        const dh = H[nc] - hcur
        let climb = 0
        if (dh > 1.2 && (navSolid[nc] || navSolid[c] || dh > (d < 4 ? 2.2 : 3.1))) {
          // jump + jets: possible but costs energy and time
          if (dh > this.maxClimb || d >= 4) continue
          climb = 4 + dh * 1.5
        }
        if (d >= 4) {
          const a = cj * NX + ni, b = nj * NX + ci
          if (!stand[a] || !stand[b]) continue
        }
        // mild preference for open space, keeps paths off walls
        let cost = DC[d] + (open[nc] < 3 ? 0.6 : 0) + climb
        if (extraCost) cost += extraCost(nc)
        const ng = G[c] + cost
        if (stamp[nc] !== gen || ng < G[nc]) {
          stamp[nc] = gen; G[nc] = ng; came[nc] = c
          push(nc, ng + heur(nc))
        }
      }
      // hop over a strip of wall-adjacent cells (jump or jet), orthogonal only
      for (let d = 0; d < 4; d++) {
        const n1 = (cj + DY[d]) * NX + ci + DX[d]
        if (ci + DX[d] < 0 || cj + DY[d] < 0 || ci + DX[d] >= NX || cj + DY[d] >= NY || stand[n1]) continue
        let peak = H[n1]
        for (let k = 2; k <= 4; k++) {
          const ni = ci + DX[d] * k, nj = cj + DY[d] * k
          if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) break
          const nc = nj * NX + ni
          if (!stand[nc]) { peak = Math.max(peak, H[nc]); continue }
          if (closed[nc] === gen) break
          const top = Math.max(peak, H[nc]) - hcur
          if (top > this.maxClimb) break
          const ng = G[c] + k + 3 + Math.max(0, top - 1.2) * 1.5
          if (stamp[nc] !== gen || ng < G[nc]) {
            stamp[nc] = gen; G[nc] = ng; came[nc] = c
            push(nc, ng + heur(nc))
          }
          break
        }
      }
    }
    const out: number[] = []
    let c = bestC
    while (c >= 0 && out.length < 5000) { out.push(c); c = came[c] }
    out.reverse()
    return out
  }
}
