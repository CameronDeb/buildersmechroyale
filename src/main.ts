import { Brain } from "./brain.ts"

let brain: Brain | null = null
let last: any = {}
let buf = ""
let queued = false
let errs = 0

const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n")

function handle(lines: string[]) {
  let obs: any = null
  for (const line of lines) {
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === "hello") {
      try { brain = new Brain(msg) } catch (e) { console.error("init failed", e) }
      send({ type: "ready", name: "ironclad" })
    } else if (msg.type === "obs") obs = msg
    else if (msg.type === "end") process.exit(0)
  }
  if (!obs) return
  let act: any = { tick: obs.tick }
  if (brain) {
    try {
      act = brain.act(obs)
      last = { move: act.move, aim: act.aim, boost: act.boost }
    } catch (e) {
      if (errs++ < 5) console.error("act failed", obs.tick, e)
      act = { ...last }
    }
  }
  act.tick = obs.tick
  send(act)
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  if (queued) return
  queued = true
  setImmediate(flush)
})
function flush() {
  queued = false
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  handle(lines.filter((l) => l.length > 1))
}
process.stdin.on("end", () => {
  buf += "\n"
  flush()
  process.exit(0)
})
