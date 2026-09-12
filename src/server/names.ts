const BRAINS = [
  "Atlas",
  "Minerva",
  "Helix",
  "Prism",
  "Meridian",
  "Axiom",
  "Keystone",
  "Quorum",
  "Harbor",
  "Vertex",
  "Palladium",
  "Cipher",
  "Solace",
  "Nexus",
  "Lumen",
  "Cord",
  "Truss",
  "Datum",
];

const WORKERS = [
  "Anvil",
  "Forge",
  "Chisel",
  "Lathe",
  "Rivet",
  "Adze",
  "Maul",
  "Wedge",
  "Plumb",
  "Vice",
  "Swage",
  "Drift",
  "Broach",
  "Reamer",
  "Arbor",
  "Collet",
  "Gauge",
  "Spindle",
  "Quill",
  "Loom",
  "Tread",
  "Kerf",
  "Rabbet",
  "Dowel",
  "Ferro",
  "Tempera",
  "Flux",
  "Crucible",
  "Tuyere",
  "Mandrel",
  "Scribe",
  "Burin",
  "Fret",
  "Jig",
  "Cam",
  "Pawl",
  "Ratchet",
  "Capstan",
  "Windlass",
  "Spar",
];

export function pickName(role: "brain" | "worker", taken: Set<string>): string {
  const pool = role === "brain" ? BRAINS : WORKERS;
  const available = pool.filter((n) => !taken.has(n.toLowerCase()));
  if (available.length > 0) {
    return available[cryptoRandom(available.length)]!;
  }
  const base = role === "brain" ? "Brain" : "Worker";
  let n = 1;
  while (taken.has(`${base}${n}`.toLowerCase())) n += 1;
  return `${base}${n}`;
}

function cryptoRandom(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}
