import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { supabase } from './supabase'

// feed timestamp — Eastern Time HH:MM:SS (now, or a given DB timestamp)
const fmtFeedTime = () => new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtTs = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
// build an SVG polyline path from a rolling array of values (auto-scaled)
const sparkPath = (vals, w = 144, h = 36) => {
  if (!vals || vals.length < 2) return ''
  const max = Math.max(...vals), min = Math.min(...vals), rng = max - min || 1, n = vals.length
  return vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (n - 1)) * w).toFixed(1)} ${(h - 3 - ((v - min) / rng) * (h - 6)).toFixed(1)}`).join(' ')
}
// ---- house navigation graph: the minifig walks through DOORWAYS, never through walls ----
// house is a 2x2 of rooms split by walls at x=0 and z=0; interior floor y=0.4, yard/door y=0.14
const ROOM_CENTER = {
  OUTSIDE: [-4.5, 0.14, 6.9],
  LIVING: [-4.5, 0.4, 3.8],   // front-left
  KITCHEN: [-3.5, 0.4, -3.0], // back-left
  STUDY: [5.5, 0.4, 3.0],     // front-right
  BEDROOM: [4.5, 0.4, -2.0],  // back-right
}
// doorway gap between two adjacent rooms (key = the two room names sorted, joined by |)
const DOOR_PT = {
  'LIVING|OUTSIDE': [-4.5, 6.0], // front entrance
  'KITCHEN|LIVING': [-4.5, 0.0], // z=0 wall, left door
  'BEDROOM|STUDY': [4.5, 0.0],   // z=0 wall, right door
  'LIVING|STUDY': [0.0, 4.5],    // x=0 wall, front door
  'BEDROOM|KITCHEN': [0.0, -4.5],// x=0 wall, back door
}
const ROOM_ADJ = {
  OUTSIDE: ['LIVING'],
  LIVING: ['OUTSIDE', 'KITCHEN', 'STUDY'],
  KITCHEN: ['LIVING', 'BEDROOM'],
  STUDY: ['LIVING', 'BEDROOM'],
  BEDROOM: ['KITCHEN', 'STUDY'],
}
const roomOf = (x, z) => (z > 6.2 ? 'OUTSIDE' : x < 0 ? (z > 0 ? 'LIVING' : 'KITCHEN') : (z > 0 ? 'STUDY' : 'BEDROOM'))
const locToNode = (loc) => {
  const s = String(loc || '').toUpperCase()
  if (s.includes('KITCHEN')) return 'KITCHEN'
  if (s.includes('BED')) return 'BEDROOM'
  if (s.includes('STUD') || s.includes('DESK') || s.includes('OFFICE') || s.includes('WORK')) return 'STUDY'
  if (s.includes('DOOR') || s.includes('OUTSIDE') || s.includes('YARD') || s.includes('STREET') || s.includes('PORCH')) return 'OUTSIDE'
  return 'LIVING'
}
// breadth-first shortest room-sequence from start to goal
const bfsRooms = (start, goal) => {
  if (start === goal) return [start]
  const q = [[start]], seen = new Set([start])
  while (q.length) {
    const path = q.shift(), node = path[path.length - 1]
    for (const nb of ROOM_ADJ[node] || []) {
      if (seen.has(nb)) continue
      const np = [...path, nb]
      if (nb === goal) return np
      seen.add(nb); q.push(np)
    }
  }
  return [start, goal]
}
// turn a room path into ordered THREE waypoints: each doorway to pass through, ending at the goal's centre
const buildFigPath = (start, goal) => {
  const seq = bfsRooms(start, goal), wp = []
  for (let i = 1; i < seq.length; i++) {
    const d = DOOR_PT[[seq[i - 1], seq[i]].sort().join('|')]
    if (d) wp.push(new THREE.Vector3(d[0], 0.4, d[1]))
  }
  const c = ROOM_CENTER[goal] || ROOM_CENTER.LIVING
  wp.push(new THREE.Vector3(c[0], c[1], c[2]))
  return wp
}

// capitalise the first letter (normal sentence case for monologue + chat text)
const cap = (s) => (s && typeof s === 'string') ? s.charAt(0).toUpperCase() + s.slice(1) : s
// a proper sentence: capitalised, ending in punctuation (no quote marks)
const sentence = (s) => { if (!s) return s; const c = cap(s.trim()); return /[.!?…]$/.test(c) ? c : c + '.' }

// feed category tag colours — different event types get different tags
const TAG = { TRADE: '#ff531f', MOVE: '#5b9bd5', WORK: '#a06cd5', FOOD: '#e0a52a', REST: '#3aa0ab', CARE: '#57a35c', READ: '#c86bb0', THINK: '#7f86e0', HOME: '#ff8a4c' }
// memory type colours (SILICOO writes these himself)
const MEM_TAG = { LESSON: '#a06cd5', MARKET: '#e0a52a', STUDY: '#5b9bd5', MOMENT: '#57a35c', MILESTONE: '#ff8a4c', PERSON: '#c86bb0' }

// chat emoji palette
const EMOJIS = ['😀', '😂', '🥰', '😎', '😭', '😍', '🤔', '😴', '👍', '🙌', '👋', '🙏', '🔥', '🎉', '🥳', '🚀', '💜', '❤️', '✨', '💯', '🧱', '☕', '👀', '😅']
// 10 preset username colours (orange first = default)
const NAME_COLORS = ['#ff531f', '#ff8a4c', '#e0a52a', '#57a35c', '#3aa0ab', '#5b9bd5', '#7f86e0', '#a06cd5', '#c86bb0', '#e8e2d5']
// reject any username that impersonates SILICOO (prevents fake announcements)
const isBadName = (n) => /silicoo/i.test(String(n || '').replace(/[^a-z0-9]/gi, ''))

// ----- MEMORY page -----
// Intentionally empty. Silicoo's memory stays blank until the AI is connected;
// every entry will be written by the model itself, in his own words, as it happens.

// ----- DEVLOG board -----
const DEVLOG = {
  shipped: [
    { t: 'The world in 3D', d: 'Silicoo’s house and the block around it — rooms, streets, lights — built in brick and rendered live in the browser.', day: 'DAY 2' },
    { t: 'Silicoo, matching the logo', d: 'The little black minifig rebuilt from scratch: charcoal body, rainbow eyes, a proper neck and hands.', day: 'DAY 6' },
    { t: 'The live spectator page', d: 'The stream view with his action feed, live monologue, camera angles and full viewport controls.', day: 'DAY 9' },
    { t: 'Real shared chat & viewer count', d: 'Everyone sees the same messages live, with custom names and colors, plus a real count of who is watching.', day: 'DAY 12' },
    { t: 'The intro & docs pages', d: 'The full narrative of what Silicoo is, and a technical reference for how the whole thing works.', day: 'DAY 16' },
    { t: 'Silicoo driven by Claude Fable 5', d: 'His feed, his monologue and his status all come from a real AI now, not a script.', day: 'DAY 22' },
    { t: 'A real 24-hour routine', d: 'He wakes, makes coffee, works, studies, eats and sleeps on the real clock, and never claims the wrong time of day.', day: 'DAY 23' },
    { t: 'Real market awareness', d: 'He watches genuine live BTC, ETH and SOL prices and reacts to them. He never invents a number.', day: 'DAY 24' },
    { t: 'He walks his own house', d: 'The minifig actually paths room to room through the doorways to wherever the AI says he is — no walking through walls.', day: 'DAY 24' },
    { t: 'Living needs', d: 'Energy, hunger, focus and social that rise and fall over real time and genuinely drive what he does next.', day: 'DAY 25' },
    { t: 'His own memory', d: 'He writes his own memories as he lives — market reads, lessons, moments — and the Memory page fills with them.', day: 'DAY 26' },
    { t: 'He speaks out loud', d: 'Each new line is read aloud in his voice, with a working volume control on the stream.', day: 'DAY 26' },
  ],
  progress: [
    { t: 'Giving him a wallet', d: 'Connecting real funds so Silicoo can actually trade instead of only watching. Until this lands he holds no positions on purpose.' },
    { t: 'Token launch & integration', d: 'The live ticker, contract, price, and a running tracker of every buyback and burn tied to his spending.' },
    { t: 'Always-on hosting', d: 'Moving his brain onto a server so he stays live 24/7 for everyone, not just while a machine is running.' },
    { t: 'Breaking ground on the hospital', d: 'The first building beyond the house, where he recovers after the rough days.' },
  ],
  backlog: [
    { t: 'Trading for real', d: 'Once funded: real positions, real profit and loss, and spending that buys back and burns $SILICOO.' },
    { t: 'Talking with the chat', d: 'Reading the live chat and replying to viewers by name, right there on the stream.' },
    { t: 'Collaborative brick art', d: 'Holders lay bricks together on one canvas, mint it as an NFT, auction it, and burn the proceeds.' },
    { t: 'The Congress', d: 'On-chain governance where holders bring proposals, vote with their bags, and decide what gets built next.' },
    { t: 'Milestones set in stone', d: 'Every big moment the community hits gets carved permanently into the monument at the square.' },
    { t: 'The rest of the city', d: 'The cinema, the arena, and everything else that turns one house into a whole society.' },
    { t: 'Holder sub-worlds', d: 'Stake $SILICOO to spin up your own world. On-chain Roblox, with Silicoo as player zero.' },
    { t: 'Mobile', d: 'The whole stream and console, rebuilt to feel right on a phone.' },
  ],
}
const DEV_COLS = [
  { key: 'shipped', label: 'SHIPPED', sub: 'Done and live', color: '#57a35c', items: DEVLOG.shipped },
  { key: 'progress', label: 'IN PROGRESS', sub: 'On the board now', color: '#ff8a4c', items: DEVLOG.progress },
  { key: 'backlog', label: 'PLANNED', sub: 'Not scheduled yet', color: '#8a847a', items: DEVLOG.backlog },
]

// ----- DOCS table of contents -----
const DOC_TOC = [
  { id: 'intro', label: 'Introduction' },
  { id: 'stack', label: 'Architecture' },
  { id: 'world', label: 'The 3D World' },
  { id: 'stream', label: 'The Livestream' },
  { id: 'brain', label: 'Silicoo’s Brain' },
  { id: 'memory', label: 'Memory' },
  { id: 'token', label: 'Token & Economy' },
  { id: 'city', label: 'The City' },
  { id: 'community', label: 'Community' },
  { id: 'subworlds', label: 'Sub-Worlds' },
  { id: 'faq', label: 'FAQ' },
]

function LoadBars({ values }) {
  return (
    <>
      {values.map((v, t) => (
        <div className="load" key={t}><span>L{t + 1}</span><i><em style={{ width: `${v}%` }} /></i><b>{v}</b></div>
      ))}
    </>
  )
}

// segmented progress bar (discrete cells fill up, LEGO / equalizer style)
function SegBar({ value, segments = 16 }) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * segments)
  return (
    <i>{Array.from({ length: segments }, (_, k) => <em key={k} className={k < filled ? 'on' : ''} />)}</i>
  )
}

export default function App() {
  const stageRef = useRef(null)
  const compassRef = useRef(null)
  const coordRef = useRef(null)
  const panRef = useRef(null)
  const holdRef = useRef(null)
  const portraitRef = useRef(null)
  const figGoalRef = useRef(null) // which room the minifig should be in (from the shared AI state)
  const volumeRef = useRef(70) // current voice volume, read by the TTS effect without re-triggering it
  const spokeRef = useRef(false) // skip reading the initial line; only speak live updates
  const voiceRef = useRef(null) // the chosen ENGLISH voice (never Chinese / never the system default)
  const [page, setPage] = useState('LIVE')
  const [docActive, setDocActive] = useState('intro')
  const [running, setRunning] = useState(true)
  const [buildSpeed, setBuildSpeed] = useState(54)
  const [terrainHeight, setTerrainHeight] = useState(62)
  const [density, setDensity] = useState(68)
  const [volume, setVolume] = useState(70)
  const [brightness, setBrightness] = useState(100)
  const [view, setView] = useState('ISO')
  const [replay, setReplay] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [showFigure, setShowFigure] = useState(true)
  const [online, setOnline] = useState(1)
  const [feed, setFeed] = useState(() => {
    // stagger the seed entries so each has its own timestamp (newest on top)
    const at = (secAgo) => new Date(Date.now() - secAgo * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return [
      { id: 0, w: 'SILICOO', a: 'Arrived home', ts: at(0), k: 'HOME' },
      { id: 1, w: 'SILICOO', a: 'Sat down in the living room', ts: at(3), k: 'REST' },
      { id: 2, w: 'SILICOO', a: 'Made coffee in the kitchen', ts: at(7), k: 'FOOD' },
    ]
  })
  const [chat, setChat] = useState([])
  const [draft, setDraft] = useState('')
  const chatRef = useRef(null)
  const presenceKey = useRef(null)
  const [myName, setMyName] = useState('Guest')
  const [myColor, setMyColor] = useState('#ff531f')
  const [showEmoji, setShowEmoji] = useState(false)
  const [showColors, setShowColors] = useState(false)
  const [nameError, setNameError] = useState(false)
  const [status, setStatus] = useState({ state: 'THINKING', mood: 'CURIOUS', location: 'LIVING ROOM', intent: 'settling in at home' })
  const [vitals, setVitals] = useState({ energy: 0, hunger: 0, focus: 0, social: 0 })
  const [lastSeen, setLastSeen] = useState(0) // ms of the last worker state update (liveness)
  const [bornAt, setBornAt] = useState(0) // ms of SILICOO's first ever action
  const [memories, setMemories] = useState(0)
  const [memList, setMemList] = useState([]) // SILICOO's real memories from Supabase
  const [actions, setActions] = useState(0)
  const [speech, setSpeech] = useState('') // filled from the shared AI state; no fabricated placeholder
  const [now, setNow] = useState(() => Date.now())

  const runningRef = useRef(running)
  useEffect(() => { runningRef.current = running }, [running])
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(id)
  }, [running])
  // SILICOO is driven live by the worker (Claude Fable 5) via Supabase:
  // silicoo_state holds his current status/mood/speech, silicoo_feed his actions.
  useEffect(() => {
    if (!supabase) return // no backend configured -> keep the seed feed as a static fallback
    let active = true
    const applyState = (d) => {
      if (!d) return
      setStatus({ state: d.status || 'LIVE', mood: d.mood || 'CALM', location: d.location || 'HOME', intent: d.intent || '' })
      if (d.speech) setSpeech(d.speech)
      setVitals({ energy: d.energy || 0, hunger: d.hunger || 0, focus: d.focus || 0, social: d.social || 0 })
      if (d.updated_at) setLastSeen(Date.parse(d.updated_at))
    }
    const mapRow = (r) => ({ id: r.id, w: 'SILICOO', a: r.action, ts: fmtTs(r.created_at), k: r.kind, tok: r.gen_tokens, lat: r.latency_ms, at: r.created_at })
    // initial snapshot
    supabase.from('silicoo_state').select('*').eq('id', 1).single().then(({ data }) => { if (active) applyState(data) })
    supabase.from('silicoo_feed').select('*').order('created_at', { ascending: false }).limit(30).then(({ data }) => {
      if (active && data) setFeed(data.map(mapRow))
    })
    // real totals + SILICOO's true birth (his first ever action)
    supabase.from('silicoo_feed').select('*', { count: 'exact', head: true }).then(({ count }) => { if (active) setActions(count || 0) })
    supabase.from('silicoo_memories').select('*', { count: 'exact', head: true }).then(({ count }) => { if (active) setMemories(count || 0) })
    supabase.from('silicoo_memories').select('*').order('created_at', { ascending: false }).limit(100).then(({ data }) => { if (active && data) setMemList(data) })
    supabase.from('silicoo_feed').select('created_at').order('created_at', { ascending: true }).limit(1).then(({ data }) => { if (active && data?.[0]) setBornAt(Date.parse(data[0].created_at)) })
    // live updates
    const ch = supabase
      .channel('silicoo-live')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'silicoo_state' }, ({ new: d }) => applyState(d))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'silicoo_feed' }, ({ new: r }) => {
        setFeed((f) => (f.some((x) => x.id === r.id) ? f : [mapRow(r), ...f]).slice(0, 30))
        setActions((a) => a + 1)
        setBornAt((b) => b || Date.parse(r.created_at))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'silicoo_memories' }, ({ new: r }) => { setMemList((l) => (l.some((x) => x.id === r.id) ? l : [r, ...l])); setMemories((m) => m + 1) })
      .subscribe()
    return () => { active = false; supabase.removeChannel(ch) }
  }, [])

  // steer the 3D minifig to wherever the AI says SILICOO currently is (the loop paths him through doorways)
  useEffect(() => { figGoalRef.current = locToNode(status.location) }, [status.location])

  // pick a robotic ENGLISH voice (prefer a male one), reloading when the voice list changes
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const pick = () => {
      if (voiceRef.current) return // lock the first good English voice for the whole session, never swap
      const en = window.speechSynthesis.getVoices().filter((v) => /^en\b|^en[-_]/i.test(v.lang))
      if (!en.length) return
      voiceRef.current =
        en.find((v) => /google/i.test(v.name) && /male/i.test(v.name)) ||  // Google male: male voice AND respects the volume slider
        en.find((v) => /david|mark|guy|male|daniel|george|alex/i.test(v.name)) || // other male (may ignore volume on Windows)
        en.find((v) => /google/i.test(v.name)) ||                          // any Google voice: reliably respects volume
        en.find((v) => !/zira|female|woman|susan|hazel|eva|samantha|karen|moira|tessa|catherine/i.test(v.name)) ||
        en[0]
    }
    pick()
    window.speechSynthesis.addEventListener('voiceschanged', pick)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick)
  }, [])

  // speak any text in the chosen English robotic voice at the current VOLUME (0 = mute / no English voice = silent)
  const speak = (text) => {
    if (!('speechSynthesis' in window)) return
    const vol = volumeRef.current, v = voiceRef.current
    if (!text || vol <= 0 || !v) return // NEVER read in Chinese: bail if no English voice
    const u = new SpeechSynthesisUtterance(text)
    u.voice = v; u.lang = v.lang || 'en-US'
    u.volume = Math.min(1, vol / 100)
    u.pitch = 0.5 // low + flat = robotic
    u.rate = 0.98
    window.speechSynthesis.cancel() // stop any previous line, speak this one once
    window.speechSynthesis.speak(u)
  }
  useEffect(() => { volumeRef.current = volume }, [volume])
  // read each new SILICOO SAYS line aloud once
  useEffect(() => {
    if (!spokeRef.current) { spokeRef.current = true; return } // don't read the initial/placeholder line
    speak(speech)
  }, [speech])

  // real shared chat via Supabase — everyone sees the same messages, live
  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.from('messages').select('*').order('created_at', { ascending: true }).limit(80)
      .then(({ data }) => { if (active && data) setChat(data.map((m) => ({ id: m.id, u: m.username, t: m.text, color: m.color }))) })
    const ch = supabase.channel('public:messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c, { id: m.id, u: m.username, t: m.text, color: m.color }]).slice(-100))
      })
      .subscribe()
    return () => { active = false; supabase.removeChannel(ch) }
  }, [])

  // real online count — Supabase Presence: each open tab joins, count = tracked clients
  useEffect(() => {
    if (!supabase) return
    if (!presenceKey.current) {
      try { presenceKey.current = sessionStorage.getItem('silicoo_pk') || '' } catch { presenceKey.current = '' }
      if (!presenceKey.current) {
        presenceKey.current = (globalThis.crypto?.randomUUID?.() || String(Math.random()))
        try { sessionStorage.setItem('silicoo_pk', presenceKey.current) } catch { /* ignore */ }
      }
    }
    const ch = supabase.channel('online-users', { config: { presence: { key: presenceKey.current } } })
    ch.on('presence', { event: 'sync' }, () => setOnline(Math.max(1, Object.keys(ch.presenceState()).length)))
    ch.subscribe((status) => { if (status === 'SUBSCRIBED') ch.track({ at: Date.now() }) })
    return () => { supabase.removeChannel(ch) }
  }, [])

  // keep the chat scrolled to the newest message
  useEffect(() => { const el = chatRef.current; if (el) el.scrollTop = el.scrollHeight }, [chat])

  // real-time clock — drives ET time, days-lived and world uptime
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])

  useEffect(() => {
    const host = stageRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.52
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d0c0b)
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 260)
    if (view === 'TOP') camera.position.set(0, 30, 0.01)
    else if (view === 'SIDE') camera.position.set(26, 11, 0.01)
    else camera.position.set(18, 29, 34)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = 0.06
    controls.minDistance = 11; controls.maxDistance = 95
    controls.maxPolarAngle = Math.PI * 0.49
    controls.target.set(0, 0.6, 0)

    scene.add(new THREE.HemisphereLight(0xfff3e6, 0x181410, 0.3))
    const key = new THREE.DirectionalLight(0xffffff, 0.82)
    key.position.set(9, 20, 12); key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = key.shadow.camera.bottom = -18
    key.shadow.camera.right = key.shadow.camera.top = 18
    key.shadow.bias = -0.00015
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffd9c7, 0.26); fill.position.set(-11, 8, 12); scene.add(fill)

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(180, 180), new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 1 }))
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground)
    const grid = new THREE.GridHelper(180, 180, 0x453b33, 0x211d19)
    grid.material.transparent = true; grid.material.opacity = 0.4; scene.add(grid)

    // ---------- matte materials ----------
    const P = (c, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: Math.min(1, Math.max(0.6, r)), metalness: 0, envMapIntensity: 0.04 })
    const flat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, envMapIntensity: 0 })
    const M = {
      wall: flat(0x625a4a), wall2: flat(0x554e40), base: flat(0x6a655c), skirt: flat(0x4a4438),
      flLiving: flat(0x7a5636), flKitchen: flat(0x60635c), flStudy: flat(0x6a4a2e), flBed: flat(0x3c4a5c),
      wood: P(0x9c6b3f, 0.85), woodMid: P(0x845026, 0.85), woodDark: P(0x593a22, 0.85), woodLt: P(0xb2814a, 0.85),
      metal: P(0x36393d, 0.7), steel: P(0x777a7e, 0.7), black: P(0x1a1a1a, 0.6), figblack: P(0x101010, 0.7),
      orange: P(0xd9541f, 0.85), red: P(0xbb3a2c, 0.85), blue: P(0x2f6ea0, 0.85), teal: P(0x2c82a6, 0.8),
      green: P(0x4f8a56, 0.85), mustard: P(0xd39a2e, 0.85), cream: P(0xc3b79c, 0.9), plum: P(0x7a4b78, 0.85),
      bed: P(0xa9a08e, 0.95), pillow: P(0xb0a692, 0.95), pot: P(0xb2593a, 0.9), leaf: P(0x4f8a56, 0.85),
      glass: new THREE.MeshStandardMaterial({ color: 0x2a3d47, roughness: 0.45, metalness: 0, envMapIntensity: 0.2 }),
      screen: new THREE.MeshStandardMaterial({ color: 0x1a6b7a, emissive: 0x0d4954, emissiveIntensity: 0.5, roughness: 0.6 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xffce7a, emissive: 0xffab3d, emissiveIntensity: 0.7, roughness: 0.6 }),
    }

    // ---------- authentic LEGO units ----------
    const U = 0.5, PH = 0.2, SR = 0.15, SH = 0.11, GAP = 0 // no gap — bricks fit perfectly (shared faces are internal/occluded, so no z-fighting)
    const rad = (w, h, d) => Math.max(0.012, Math.min(0.03, Math.min(w, h, d) * 0.14))
    const VGAP = 0 // no vertical gap — stacked bricks sit flush, lower studs poke into the upper brick (real LEGO)
    function bx(w, h, d, m, x, y, z, ry = 0, studs = 'auto') {
      const W = Math.max(0.04, w - GAP), D = Math.max(0.04, d - GAP), Hh = Math.max(0.04, h - VGAP)
      const geo = new RoundedBoxGeometry(W, Hh, D, 2, rad(W, Hh, D))
      const want = studs === true || (studs === 'auto' && h >= 0.12 && w >= 0.34 && d >= 0.3)
      if (!want) {
        const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.rotation.y = ry
        mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); return mesh
      }
      const g = new THREE.Group()
      const body = new THREE.Mesh(geo, m); body.castShadow = body.receiveShadow = true; g.add(body)
      const nx = Math.max(1, Math.round(w / U)), nz = Math.max(1, Math.round(d / U))
      const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(SR, SR, SH, 16), m, nx * nz)
      im.castShadow = true
      const mat4 = new THREE.Matrix4(); let idx = 0
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        mat4.setPosition((i - (nx - 1) / 2) * U, Hh / 2 + SH / 2, (j - (nz - 1) / 2) * U); im.setMatrixAt(idx++, mat4)
      }
      im.instanceMatrix.needsUpdate = true; g.add(im)
      g.position.set(x, y, z); g.rotation.y = ry; scene.add(g); return g
    }
    // snap to the global stud grid: an fx-stud footprint aligns its cells to the baseplate studs (parity-aware)
    const snapN = (c, n) => (n % 2) ? Math.round(c / U) * U : (Math.round(c / U - 0.5) + 0.5) * U
    const snapXZ = (cx, cz, fx, fz, ry) => Math.abs(Math.sin(ry)) < 0.05 ? [snapN(cx, fx), snapN(cz, fz)]
      : Math.abs(Math.cos(ry)) < 0.05 ? [snapN(cx, fz), snapN(cz, fx)] : [cx, cz]
    const brick = (fx, fz, pl, m, cx, cz, yb, ry = 0, studs = 'auto') => {
      const [sx, sz] = snapXZ(cx, cz, fx, fz, ry)
      return bx(fx * U, pl * PH, fz * U, m, sx, yb + pl * PH / 2, sz, ry, studs)
    }
    const tile = (fx, fz, m, cx, cz, yb, ry = 0) => {
      const [sx, sz] = snapXZ(cx, cz, fx, fz, ry)
      return bx(fx * U, PH, fz * U, m, sx, yb + PH / 2, sz, ry, false)
    }
    const cyl = (r, h, m, x, y, z, seg = 16, stud = 'auto') => {
      x = Math.round(x / U) * U; z = Math.round(z / U) * U   // round pieces (pots, plates, lamps) snap onto a stud
      const g = new THREE.Group()
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m); c.castShadow = true; g.add(c)
      if (stud === true || (stud === 'auto' && r >= 0.1)) { const s = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, SH, 12), m); s.position.y = h / 2 + SH / 2; g.add(s) }
      g.position.set(x, y, z); scene.add(g); return g
    }

    // ---------- structure (bigger footprint: 18 x 12) ----------
    const F0 = 0.4, BH = 0.6, WH = BH * 3, WT = 0.34
    // ONE unified studded baseplate — global stud grid (odd count -> stud columns land exactly on x=0 & z=0, where the
    // dividers sit) and slab TOP = F0, so every wall/furniture bottom clicks down onto the studs (studs poke in, LEGO-correct)
    bx(18.5, 0.3, 12.5, M.flStudy, 0, 0.25, 0, 0, true)

    // ========== YARD, ROADS & STREET FURNITURE around the house ==========
    const OM = {
      grass: new THREE.MeshStandardMaterial({ color: 0x40733a, roughness: 1, envMapIntensity: 0 }),
      asphalt: new THREE.MeshStandardMaterial({ color: 0x34353b, roughness: 1, envMapIntensity: 0 }),
      kerb: new THREE.MeshStandardMaterial({ color: 0x777169, roughness: 1, envMapIntensity: 0 }),
      pave: new THREE.MeshStandardMaterial({ color: 0x8f8a80, roughness: 1, envMapIntensity: 0 }),
      lineY: new THREE.MeshStandardMaterial({ color: 0xd8b23a, roughness: 1, envMapIntensity: 0 }),
      lineW: new THREE.MeshStandardMaterial({ color: 0xb0a99c, roughness: 1, envMapIntensity: 0 }),
      trunk: new THREE.MeshStandardMaterial({ color: 0x5e4028, roughness: 0.9 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.85 }),
      leaf2: new THREE.MeshStandardMaterial({ color: 0x4a8a46, roughness: 0.85 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x33363a, roughness: 0.6 }),
      lampOn: new THREE.MeshStandardMaterial({ color: 0xffe19a, emissive: 0xffbf5a, emissiveIntensity: 0.9, roughness: 0.6 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x22303a, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.2 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 }),
      hub: new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.5 }),
      fence: new THREE.MeshStandardMaterial({ color: 0xcac2b0, roughness: 0.9 }),
      red: new THREE.MeshStandardMaterial({ color: 0xc23a2c, roughness: 0.45, metalness: 0.1 }),
      blue: new THREE.MeshStandardMaterial({ color: 0x2f6ea6, roughness: 0.45, metalness: 0.1 }),
      yellowC: new THREE.MeshStandardMaterial({ color: 0xe0a52a, roughness: 0.45, metalness: 0.1 }),
      head: new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffe08a, emissiveIntensity: 0.6, roughness: 0.5 }),
      tail: new THREE.MeshStandardMaterial({ color: 0xd23a2a, emissive: 0x8a1c12, emissiveIntensity: 0.5, roughness: 0.5 }),
    }
    const fb = (w, h, d, m, x, y, z, ry = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.rotation.y = ry; b.receiveShadow = b.castShadow = true; scene.add(b); return b }
    const cy = (r, h, m, x, y, z, ry = 0, rx = 0) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), m); c.position.set(x, y, z); c.rotation.set(rx, ry, 0); c.castShadow = true; scene.add(c); return c }
    // a rectangular ring of a surface between inner (x0,z0) and outer (x1,z1) half-extents
    const ring = (m, x0, z0, x1, z1, y, h) => {
      fb(x1 * 2, h, z1 - z0, m, 0, y, -(z0 + z1) / 2); fb(x1 * 2, h, z1 - z0, m, 0, y, (z0 + z1) / 2)
      fb(x1 - x0, h, z0 * 2, m, -(x0 + x1) / 2, y, 0); fb(x1 - x0, h, z0 * 2, m, (x0 + x1) / 2, y, 0)
    }
    // ---- surfaces ----
    ring(OM.grass, 9.3, 6.3, 11, 8, 0.05, 0.1)          // lawn
    ring(OM.kerb, 11, 8, 12.5, 9.5, 0.09, 0.18)         // sidewalk (raised kerb)
    ring(OM.asphalt, 12.5, 9.5, 19, 16, 0.04, 0.12)     // road
    // yellow dashed centre lines
    for (let x = -17; x <= 17; x += 2.6) {
      fb(1.3, 0.02, 0.16, OM.lineY, x, 0.105, -12.75)
      if (x < -6.45 || x > -2.55) fb(1.3, 0.02, 0.16, OM.lineY, x, 0.105, 12.75) // break the centre line where the zebra crossing sits
    }
    for (let z = -8; z <= 8; z += 2.6) { fb(0.16, 0.02, 1.3, OM.lineY, -15.75, 0.105, z); fb(0.16, 0.02, 1.3, OM.lineY, 15.75, 0.105, z) } // centre of the vertical roads
    // white lane-edge lines (just off the kerb)
    fb(25, 0.02, 0.1, OM.lineW, 0, 0.105, -9.62); fb(25, 0.02, 0.1, OM.lineW, 0, 0.105, 9.62)
    fb(0.1, 0.02, 19, OM.lineW, -12.62, 0.105, 0); fb(0.1, 0.02, 19, OM.lineW, 12.62, 0.105, 0)
    // ---- driveway (from the front door at x=-4.5) + zebra crossing ----
    fb(2.6, 0.14, 3.6, OM.pave, -4.5, 0.07, 7.7)        // driveway through lawn + kerb
    // zebra crossing centred on the driveway/front door (x=-4.5): bars run ACROSS the path (long in x),
    // spaced along the walking direction (z). y bumped to avoid z-fight with the road lines.
    for (let i = 0; i < 8; i++) fb(2.6, 0.02, 0.4, OM.lineW, -4.5, 0.112, 10.0 + i * 0.8)

    // ---- trees ----
    const tree = (x, z) => {
      bx(0.5, 1.0, 0.5, OM.trunk, x, 0.6, z, 0, false)           // brick trunk
      bx(1.5, 0.6, 1.5, OM.leaf, x, 1.15, z)                     // canopy — stacked studded green bricks
      bx(1.1, 0.55, 1.1, OM.leaf2, x + 0.28, 1.55, z - 0.2)
      bx(0.9, 0.5, 0.9, OM.leaf, x - 0.3, 1.45, z + 0.25)
      bx(0.7, 0.5, 0.7, OM.leaf2, x, 1.85, z)                    // top
    }
    // roadside trees — long roads (N/S) 3 each, short roads (W/E) 2 each, all symmetric;
    // the bus-stop side (E) gets only 1 tree, the other slot is taken by the bus stop
    ;[[-7, -8.7], [0, -8.7], [7, -8.7],      // north (long)
      [-7, 8.7], [0, 8.7], [7, 8.7],          // south (long)
      [-11.7, -4], [-11.7, 4],                // west (short)
      [11.7, -4]].forEach(([x, z]) => tree(x, z))   // east (short) — bus stop fills the +z slot

    // ---- streetlights (with glow) ----
    const streetlight = (x, z, dir) => {
      cy(0.14, 0.22, OM.metal, x, 0.16, z)                    // base foot planted on the sidewalk
      cy(0.08, 2.45, OM.metal, x, 1.35, z)                    // pole (0.12 .. 2.57)
      fb(0.74, 0.09, 0.1, OM.metal, x + dir * 0.37, 2.55, z)  // arm bridging pole -> lamp head
      fb(0.34, 0.16, 0.24, OM.lampOn, x + dir * 0.72, 2.44, z) // lamp head hangs below the arm end
      const pl = new THREE.PointLight(0xffcf7a, 2.6, 6.5, 2); pl.position.set(x + dir * 0.72, 2.3, z); scene.add(pl)
    }
    // one streetlight at each of the four corners only
    streetlight(-11.7, -8.8, -1); streetlight(11.7, -8.8, 1); streetlight(11.7, 8.8, 1); streetlight(-11.7, 8.8, -1)

    // ---- fence around the lawn (gap at the driveway) ----
    const fenceRun = (x1, z1, x2, z2) => {
      const len = Math.hypot(x2 - x1, z2 - z1), ry = Math.atan2(z2 - z1, x2 - x1), mx = (x1 + x2) / 2, mz = (z1 + z2) / 2
      fb(len, 0.09, 0.07, OM.fence, mx, 0.55, mz, ry); fb(len, 0.09, 0.07, OM.fence, mx, 0.32, mz, ry)
      const n = Math.max(1, Math.round(len / 0.6))
      for (let i = 0; i <= n; i++) { const t = i / n; fb(0.08, 0.66, 0.08, OM.fence, x1 + (x2 - x1) * t, 0.43, z1 + (z2 - z1) * t) }
    }
    fenceRun(-11, -8, 11, -8); fenceRun(-11, -8, -11, 8); fenceRun(11, -8, 11, 8)
    fenceRun(-11, 8, -6, 8); fenceRun(-3, 8, 11, 8)     // front, with a gap for the driveway

    // ---- LEGO cars ----
    const car = (x, z, ry, body) => {
      const g = new THREE.Group()
      const add = (w, h, d, m, px, py, pz) => { const b = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.07), m); b.position.set(px, py, pz); b.castShadow = true; g.add(b) }
      add(1.7, 0.4, 0.95, body, 0, 0.42, 0)                        // lower body
      add(0.95, 0.34, 0.9, OM.glass, -0.05, 0.72, 0)              // window band
      add(0.85, 0.2, 0.82, body, -0.05, 0.95, 0)                 // roof
      add(0.5, 0.28, 0.98, body, 0.62, 0.5, 0)                   // hood
      const wheel = (wx, wz) => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 14), OM.tyre); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.22, wz); w.castShadow = true; g.add(w); const h = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 10), OM.hub); h.rotation.x = Math.PI / 2; h.position.set(wx, 0.22, wz); g.add(h) }
      wheel(0.55, 0.5); wheel(0.55, -0.5); wheel(-0.55, 0.5); wheel(-0.55, -0.5)
      const lp = (px, m, pz) => { const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.16), m); l.position.set(px, 0.42, pz); g.add(l) }
      lp(0.86, OM.head, 0.3); lp(0.86, OM.head, -0.3); lp(-0.86, OM.tail, 0.3); lp(-0.86, OM.tail, -0.3)
      g.position.set(x, 0.1, z); g.rotation.y = ry; scene.add(g)
    }
    // (cars removed)

    // ---- bus stop (east side) — back to the house, opens toward the road (+x) ----
    ;(function busStop(x, z) {
      fb(0.1, 1.6, 2.6, OM.metal, x - 0.3, 0.8, z)              // back frame (house side)
      fb(0.05, 1.3, 2.4, OM.glass, x - 0.2, 0.85, z)           // glass — sits in front of frame (no coincident faces)
      cy(0.06, 1.6, OM.metal, x - 0.3, 0.8, z - 1.2); cy(0.06, 1.6, OM.metal, x - 0.3, 0.8, z + 1.2) // rear posts (in frame)
      cy(0.06, 1.6, OM.metal, x + 0.5, 0.8, z - 1.2); cy(0.06, 1.6, OM.metal, x + 0.5, 0.8, z + 1.2) // front posts (road side)
      fb(1.1, 0.1, 2.7, OM.metal, x + 0.1, 1.65, z)             // roof extends toward road
      // bench: seat + two legs, sitting in FRONT of the black frame (no clipping into it)
      fb(0.5, 0.12, 2.0, OM.red, x + 0.12, 0.52, z)            // seat
      cy(0.05, 0.5, OM.metal, x + 0.12, 0.25, z - 0.8); cy(0.05, 0.5, OM.metal, x + 0.12, 0.25, z + 0.8) // legs
      // blue bus-stop sign on its own post at the road edge, facing the road (thin in x)
      cy(0.05, 1.95, OM.metal, x + 0.7, 1.0, z - 1.55)
      fb(0.06, 0.5, 0.46, OM.blue, x + 0.78, 1.72, z - 1.55)
    })(11.6, 4)

    // ---- mailbox by the driveway ----
    cy(0.06, 0.8, OM.metal, -3.2, 0.5, 8.4); fb(0.45, 0.3, 0.24, OM.blue, -3.2, 0.95, 8.4); fb(0.03, 0.2, 0.03, OM.red, -2.95, 1.05, 8.4)

    // walls span EXACTLY end-to-end (no +WT extension). Perpendicular walls butt one another's faces -> zero overlap.
    const IN = WT / 2 // 0.17 : half wall thickness (inner-face inset)
    const wall = (x1, z1, x2, z2, m = M.wall) => {
      const len = Math.hypot(x2 - x1, z2 - z1), ry = Math.atan2(z2 - z1, x2 - x1)
      const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2
      for (let c = 0; c < 3; c++) bx(len, BH, WT, m, mx, F0 + BH / 2 + c * BH, mz, ry, c === 2 ? 'auto' : false)
      bx(len, 0.16, WT + 0.05, M.skirt, mx, F0 + 0.08, mz, ry, false)
    }
    const WW = 2.2 // window opening width
    // exterior: LEFT & RIGHT own the corners; BACK & FRONT butt their inner faces. Walls are SPLIT around each window.
    wall(-9, -6 - IN, -9, 3.4 - WW / 2); wall(-9, 3.4 + WW / 2, -9, 6 + IN)   // left  (window @ z=3.4)
    wall(9, -6 - IN, 9, -3.4 - WW / 2); wall(9, -3.4 + WW / 2, 9, 6 + IN)     // right (window @ z=-3.4)
    wall(-9 + IN, -6, -6.5 - WW / 2, -6); wall(-6.5 + WW / 2, -6, 9 - IN, -6) // back  (window @ x=-6.5)
    wall(-9 + IN, 6, -5.7, 6); wall(-3.3, 6, 9 - IN, 6)         // front (door gap centred at x=-4.5)
    // x=0 divider — continuous, butts front/back inner faces (z ±(6-IN)); doors at z=±4.5
    wall(0, 6 - IN, 0, 5.5, M.wall2); wall(0, 3.5, 0, -3.5, M.wall2); wall(0, -5.5, 0, -(6 - IN), M.wall2)
    // z=0 divider — butts the x=0 divider (x ±IN) and left/right inner faces (x ±(9-IN)); doors at x=±4.5
    wall(-9 + IN, 0, -5.5, 0, M.wall2); wall(-3.5, 0, -IN, 0, M.wall2)
    wall(IN, 0, 3.5, 0, M.wall2); wall(5.5, 0, 9 - IN, 0, M.wall2)

    // ---------- door: full-height frame seated in the wall opening ----------
    // a real hinged door leaf: hinge on one jamb, swung ~50° open, sized to fit under the lintel
    // a CLOSED door leaf that fills the opening and sits flush in the wall (overlaps the jambs slightly -> no gap)
    const doorLeaf = (x, z, alongZ, half) => {
      const w = 2 * half + 0.22, H = WH - 0.3, y = F0 + 0.02 + H / 2
      if (alongZ) { // opening along Z; leaf spans Z, thin in X (sits in the wall plane at x)
        const p = new THREE.Mesh(new RoundedBoxGeometry(WT * 0.7, H, w, 2, 0.03), M.woodMid); p.position.set(x, y, z); p.castShadow = true; scene.add(p)
        const hn = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), M.metal); hn.position.set(x - WT * 0.4, F0 + 0.9, z + w * 0.32); scene.add(hn)
      } else {      // opening along X; leaf spans X, thin in Z (sits in the wall plane at z)
        const p = new THREE.Mesh(new RoundedBoxGeometry(w, H, WT * 0.7, 2, 0.03), M.woodMid); p.position.set(x, y, z); p.castShadow = true; scene.add(p)
        const hn = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), M.metal); hn.position.set(x + w * 0.32, F0 + 0.9, z - WT * 0.4); scene.add(hn)
      }
    }
    // GH = opening half-width. Jambs butt the wall ends (outer edge exactly at wall nominal end -> normal brick seam, no gap, no overlap)
    const FB = 0.4
    const door = (x, z, alongZ, GH = 1.0, leaf = false) => {
      const jc = GH - FB / 2 + 0.07 // jambs embed slightly into the walls (overlap is occluded -> no z-fighting at the joint)
      if (alongZ) { // wall runs along Z
        bx(WT, WH, FB, M.orange, x, F0 + WH / 2, z - jc, 0, false)
        bx(WT, WH, FB, M.orange, x, F0 + WH / 2, z + jc, 0, false)
        bx(WT, FB, (GH + 0.07) * 2, M.orange, x, F0 + WH - FB / 2, z, 0, false) // lintel embeds into walls (like the jambs)
        if (leaf) doorLeaf(x, z, true, GH - FB)
      } else {          // wall runs along X
        bx(FB, WH, WT, M.orange, x - jc, F0 + WH / 2, z, 0, false)
        bx(FB, WH, WT, M.orange, x + jc, F0 + WH / 2, z, 0, false)
        bx((GH + 0.07) * 2, FB, WT, M.orange, x, F0 + WH - FB / 2, z, 0, false) // lintel embeds into walls (like the jambs)
        if (leaf) doorLeaf(x, z, false, GH - FB)
      }
    }
    door(-4.5, 6, false, 1.2, true)   // front entrance -> opens into the living room
    door(0, 4.5, true, 1.0)        // living <-> study
    door(0, -4.5, true, 1.0)       // kitchen <-> bedroom
    door(-4.5, 0, false, 1.0)      // living <-> kitchen
    door(4.5, 0, false, 1.0)       // study <-> bedroom

    // ---------- windows: real openings through the wall (visible & see-through from BOTH sides) ----------
    const windowFill = (x, z, alongZ, m = M.wall) => {
      const sillH = 0.5, winH = 1.0, headH = WH - sillH - winH
      const y0 = F0 + sillH, y1 = F0 + sillH + winH, yc = F0 + sillH + winH / 2
      const fr = 0.12, T = WT
      if (alongZ) { // wall runs along Z; window spans Z, wall thickness along X
        bx(T, sillH, WW, m, x, F0 + sillH / 2, z, 0, false)                          // sill
        bx(T, headH, WW, m, x, y1 + headH / 2, z, 0, true)                           // header (studs on top)
        bx(T + 0.05, fr, WW, M.cream, x, y0, z, 0, false)                            // frame bottom
        bx(T + 0.05, fr, WW, M.cream, x, y1, z, 0, false)                            // frame top
        bx(T + 0.05, winH, fr, M.cream, x, yc, z - WW / 2 + fr / 2, 0, false)        // frame sides
        bx(T + 0.05, winH, fr, M.cream, x, yc, z + WW / 2 - fr / 2, 0, false)
        bx(T + 0.05, winH, fr * 0.8, M.cream, x, yc, z, 0, false)                    // mullion
        bx(T - 0.06, winH - 0.12, WW - 0.26, M.glass, x, yc, z, 0, false)            // glass (through the wall)
      } else {      // wall runs along X; window spans X, wall thickness along Z
        bx(WW, sillH, T, m, x, F0 + sillH / 2, z, 0, false)
        bx(WW, headH, T, m, x, y1 + headH / 2, z, 0, true)
        bx(WW, fr, T + 0.05, M.cream, x, y0, z, 0, false)
        bx(WW, fr, T + 0.05, M.cream, x, y1, z, 0, false)
        bx(fr, winH, T + 0.05, M.cream, x - WW / 2 + fr / 2, yc, z, 0, false)
        bx(fr, winH, T + 0.05, M.cream, x + WW / 2 - fr / 2, yc, z, 0, false)
        bx(fr * 0.8, winH, T + 0.05, M.cream, x, yc, z, 0, false)
        bx(WW - 0.26, winH - 0.12, T - 0.06, M.glass, x, yc, z, 0, false)
      }
    }
    windowFill(-9, 3.4, true)    // living, left wall
    windowFill(9, -3.4, true)    // bedroom, right wall
    windowFill(-6.5, -6, false)  // kitchen, back wall

    // wall art
    const art = (x, y, z, ry, m) => { bx(1.0, 0.75, 0.08, M.woodLt, x, y, z, ry, false); bx(0.75, 0.52, 0.05, m, x, y, z + (ry ? 0 : 0.03), ry, false) }
    art(-2.6, F0 + 1.15, -5.7, 0, M.teal); art(3.0, F0 + 1.1, 5.7, 0, M.orange)

    const legs = (cx, cz, w, d, topY, h, m) => {
      const t = 0.09
      ;[[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => bx(t * 1.8, h, t * 1.8, m, cx + sx * (w / 2 - t), F0 + topY - h / 2, cz + sz * (d / 2 - t), 0, false))
    }
    // chair: (bax,baz) = unit direction toward the BACK; the seat faces the opposite way.
    // snap the WHOLE chair to one stud first, then place every part relative to it (so legs/seat/back stay aligned).
    const chair = (x, z, bax, baz, m) => {
      x = Math.round(x / U) * U; z = Math.round(z / U) * U
      legs(x, z, 0.55, 0.55, 0.44, 0.44, M.woodDark)                 // 4 legs (floor -> seat)
      bx(0.5, 0.16, 0.5, m, x, F0 + 0.52, z, 0, false)               // seat
      const ang = Math.atan2(baz, bax)
      bx(0.5, 0.55, 0.12, m, x + bax * 0.29, F0 + 0.78, z + baz * 0.29, ang + Math.PI / 2, false) // backrest
    }

    // ===== LIVING ROOM (front-left) =====
    ;(function () {
      tile(8, 6, M.orange, -4.5, 3, F0)
      brick(3, 6, 2, M.plum, -7.9, 3, F0)                                   // sofa seat base
      brick(1, 6, 3, M.plum, -8.5, 3, F0 + 0.4)                             // backrest (stacked on the base's back -> no shared exposed edge)
      brick(3, 1, 3, M.plum, -7.9, 1.9, F0 + 0.4); brick(3, 1, 3, M.plum, -7.9, 4.6, F0 + 0.4) // arms (stacked on the base ends)
      tile(2, 4, M.mustard, -7.75, 3.25, F0 + 0.4)                          // seat cushion (fills the seat, between the arms & in front of the backrest)
      brick(3, 2, 2, M.woodLt, -4.6, 3, F0); tile(3, 2, M.woodDark, -4.6, 3, F0 + 0.4) // coffee table
      tile(1, 1, M.blue, -5.0, 2.8, F0 + 0.6); cyl(0.09, 0.16, M.orange, -4.2, F0 + 0.6, 3.2)
      bx(0.14, 0.95, 1.6, M.black, -0.24, F0 + 0.95, 2.5, 0, false)    // TV mounted on the divider (faces the living room)
      bx(0.04, 0.8, 1.4, M.screen, -0.33, F0 + 0.98, 2.5, 0, false)    // screen
      brick(1, 3, 2, M.woodMid, -0.4, 2.5, F0)                         // slim TV stand under the wall-mounted TV
      cyl(0.2, 0.1, M.metal, -8.1, F0, 5.1); cyl(0.05, 1.3, M.metal, -8.1, F0 + 0.7, 5.1, 10, false); cyl(0.28, 0.4, M.lamp, -8.1, F0 + 1.5, 5.1) // floor lamp
      cyl(0.3, 0.5, M.pot, -1.4, F0 + 0.05, 1.2); brick(1, 1, 2, M.leaf, -1.4, 1.2, F0 + 0.45) // plant
    })()

    // ===== KITCHEN (back-left) =====
    ;(function () {
      brick(15, 3, 4, M.wood, -4.6, -5.15, F0); tile(15, 3, M.steel, -4.6, -5.15, F0 + 0.8) // counter run (back wall)
      for (let i = 0; i < 6; i++) { bx(0.9, 0.55, 0.03, M.woodDark, -7.7 + i * 1.25, F0 + 0.42, -4.19, 0, false); bx(0.06, 0.22, 0.06, M.metal, -7.7 + i * 1.25, F0 + 0.42, -4.13, 0, false) } // cabinet doors on the FRONT of the counter
      brick(13, 2, 3, M.wall2, -4.7, -5.45, F0 + 1.45)                      // upper cabinets
      tile(2, 2, M.metal, -6.6, -5.15, F0 + 1.0)                             // sink basin (sits on the counter top)
      cyl(0.04, 0.3, M.metal, -6.6, F0 + 1.35, -5.3, 10, false); bx(0.04, 0.04, 0.25, M.metal, -6.6, F0 + 1.5, -5.15, 0, false) // faucet
      tile(2, 2, M.black, -3.2, -5.15, F0 + 1.0)                             // cooktop (sits on the counter top)
      ;[[-3.4, -5.3], [-3.0, -5.3], [-3.4, -5.0], [-3.0, -5.0]].forEach(([sx, sz]) => cyl(0.1, 0.04, M.metal, sx, F0 + 1.22, sz, 10, false)) // burners on the cooktop
      brick(2, 3, 8, M.steel, -8.1, -3.5, F0); bx(0.06, 1.4, 0.06, M.metal, -7.6, F0 + 0.9, -3.1, 0, false) // fridge (left wall)
      legs(-4.5, -2.5, 2.2, 1.2, 0.72, 0.72, M.woodDark)             // table legs (symmetric under the top)
      tile(5, 3, M.woodLt, -4.5, -2.5, F0 + 0.62)                    // tabletop (5x3 odd -> snaps symmetrically to -4.5,-2.5)
      cyl(0.16, 0.06, M.red, -4.5, F0 + 0.85, -2.5)                  // plate (centred)
      chair(-3.0, -2.5, 1, 0, M.blue)                                // right chair
      chair(-6.0, -2.5, -1, 0, M.mustard)                            // left chair (symmetric about the table centre)
    })()

    // ===== STUDY (front-right) =====
    ;(function () {
      tile(8, 6, M.teal, 4.5, 3, F0)
      brick(2, 6, 3, M.woodLt, 8.1, 3, F0); tile(2, 6, M.wood, 8.1, 3, F0 + 0.6) // desk (right wall)
      // monitor on the desk (desk surface = F0+0.8) — all placed relative to the desk so nothing detaches
      bx(0.5, 0.06, 0.5, M.black, 8.35, F0 + 0.83, 3.25, 0, false)   // monitor base
      bx(0.08, 0.35, 0.08, M.black, 8.35, F0 + 1.0, 3.25, 0, false)  // neck
      bx(0.12, 0.55, 0.9, M.black, 8.46, F0 + 1.4, 3.25, 0, false)   // monitor body (near the wall)
      bx(0.03, 0.46, 0.78, M.screen, 8.38, F0 + 1.4, 3.25, 0, false) // screen (faces the room)
      bx(0.3, 0.06, 0.6, M.metal, 7.9, F0 + 0.84, 3.25, 0, false)    // keyboard (wide along the desk edge)
      bx(0.16, 0.05, 0.22, M.metal, 7.9, F0 + 0.84, 3.95, 0, false)  // mouse
      cyl(0.08, 0.14, M.orange, 8.1, F0 + 0.87, 2.6)                 // mug
      // desk lamp (upright, not slanted)
      cyl(0.1, 0.05, M.metal, 8.5, F0 + 0.83, 4.0, 8, false); cyl(0.03, 0.4, M.metal, 8.5, F0 + 1.03, 4.0, 8, false); cyl(0.14, 0.16, M.lamp, 8.5, F0 + 1.32, 4.0, 12, false)
      // office chair in front of the desk (faces the desk)
      cyl(0.28, 0.06, M.metal, 7.0, F0 + 0.05, 3.0, 12, false); cyl(0.05, 0.45, M.metal, 7.0, F0 + 0.28, 3.0, 8, false)
      bx(0.55, 0.14, 0.55, M.black, 7.0, F0 + 0.57, 3.0, 0, false); bx(0.1, 0.55, 0.55, M.black, 6.72, F0 + 0.88, 3.0, 0, false)
      brick(5, 1, 8, M.woodDark, 4.4, 5.6, F0)                              // back panel (1.6 tall — kept under the wall)
      for (let s = 0; s < 3; s++) { brick(5, 1, 1, M.woodMid, 4.4, 5.05, F0 + 0.3 + s * 0.4, 0, false); for (let b = 0; b < 8; b++) bx(0.2, 0.3, 0.14, [M.red, M.blue, M.mustard, M.green, M.orange, M.teal][(s * 8 + b) % 6], 3.5 + b * 0.24, F0 + 0.45 + s * 0.4, 5.0, 0, false) } // shelves + books in front of the back panel
    })()

    // ===== BEDROOM (back-right) =====
    ;(function () {
      const cx = 4.5
      // bed — head at the back wall, LONG axis along z (5 wide x 6 long = longer bed)
      brick(5, 1, 5, M.woodDark, cx, -5.6, F0)                       // headboard (against the back wall)
      brick(5, 5, 2, M.woodMid, cx, -4.0, F0)                        // frame (butts the headboard front -> no shared back edge)
      brick(5, 5, 1, M.bed, cx, -4.0, F0 + 0.4)                      // mattress
      tile(5, 3, M.blue, cx, -3.5, F0 + 0.6)                         // duvet (covers the foot half, within the bed)
      brick(2, 1, 1, M.pillow, cx - 0.9, -5.0, F0 + 0.6); brick(2, 1, 1, M.pillow, cx + 0.9, -5.0, F0 + 0.6)
      // nightstands + lamps at the head
      brick(1, 1, 3, M.wood, 2.4, -5.4, F0); brick(1, 1, 1, M.lamp, 2.4, -5.4, F0 + 0.6)
      brick(1, 1, 3, M.wood, 6.6, -5.4, F0); brick(1, 1, 1, M.lamp, 6.6, -5.4, F0 + 0.6)
      // wardrobe — a proper tall cabinet flush against the RIGHT wall (thin in x, wide along z)
      brick(2, 4, 8, M.wood, 8.3, -1.5, F0)
      bx(0.05, 1.4, 0.9, M.woodDark, 7.73, F0 + 0.85, -1.75, 0, false); bx(0.05, 1.4, 0.9, M.woodDark, 7.73, F0 + 0.85, -0.75, 0, false) // doors
      bx(0.05, 0.3, 0.05, M.metal, 7.68, F0 + 0.85, -1.45, 0, false); bx(0.05, 0.3, 0.05, M.metal, 7.68, F0 + 0.85, -1.05, 0, false) // handles
      // rug + plant
      tile(5, 3, M.mustard, cx, -1.6, F0)
      cyl(0.24, 0.4, M.pot, 2.2, F0 + 0.05, -1.4); brick(1, 1, 2, M.leaf, 2.2, -1.4, F0 + 0.45)
    })()

    // cozy lamp pools
    const lampGlow = (x, z, y = F0 + 1.5) => { const p = new THREE.PointLight(0xffb45a, 2.6, 3.6, 2); p.position.set(x, y, z); scene.add(p) }
    lampGlow(-8.1, 5.1); lampGlow(8.2, 3.9); lampGlow(2.3, -5.4); lampGlow(6.5, -5.4)

    // ---------- BRICK — authentic LEGO-minifigure anatomy in the logo's charcoal + rainbow eyes ----------
    let fig = null
    if (showFigure) {
      const g = new THREE.Group()
      // charcoal plastic with a soft sheen (the logo has gentle highlights, not flat black)
      const figMat = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.5, metalness: 0.16, envMapIntensity: 0.5 })
      const rbox = (w, h, d, px, py, pz, rz = 0) => {
        const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 5, Math.min(w, h, d) * 0.26), figMat)
        m.position.set(px, py, pz); m.rotation.z = rz; m.castShadow = true; g.add(m); return m
      }

      // ---- boot legs (centre slot) with forward feet, on a hip block ----
      ;[-0.16, 0.16].forEach((lx) => {
        rbox(0.28, 0.48, 0.32, lx, 0.24, -0.02)       // leg
        rbox(0.28, 0.17, 0.17, lx, 0.085, 0.12)       // foot projecting forward
      })
      rbox(0.64, 0.24, 0.4, 0, 0.6, 0)                // hips

      // ---- trapezoidal torso: wide waist -> narrow shoulders (extruded rounded profile) ----
      const ts = new THREE.Shape()
      ts.moveTo(-0.33, 0); ts.lineTo(0.33, 0); ts.lineTo(0.28, 0.72); ts.lineTo(-0.28, 0.72); ts.lineTo(-0.33, 0)
      const tg = new THREE.ExtrudeGeometry(ts, { depth: 0.32, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 4, steps: 1 })
      tg.translate(0, 0, -0.16); tg.computeVertexNormals()
      const torso = new THREE.Mesh(tg, figMat); torso.position.set(0, 0.7, 0); torso.castShadow = true; g.add(torso)

      // ---- visible neck between torso and head ----
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.165, 0.16, 20), figMat)
      neck.position.set(0, 1.5, 0); neck.castShadow = true; g.add(neck)

      // ---- curved arms; hands swing FORWARD so the C-clips are fully visible in front of the hips ----
      const arm = (s) => {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(s * 0.30, 1.32, 0.04),
          new THREE.Vector3(s * 0.40, 1.12, 0.13),
          new THREE.Vector3(s * 0.40, 0.92, 0.27),
          new THREE.Vector3(s * 0.30, 0.76, 0.40),
        ])
        const a = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.1, 12, false), figMat); a.castShadow = true; g.add(a)
        // rounded wrist so the arm flows into the hand with no gap
        const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), figMat)
        wrist.position.set(s * 0.30, 0.76, 0.40); wrist.castShadow = true; g.add(wrist)
        // C-clip hand: ring facing forward, opening at the bottom, out in front so the whole hand reads
        const hand = new THREE.Mesh(new THREE.TorusGeometry(0.092, 0.037, 12, 24, Math.PI * 1.4), figMat)
        hand.position.set(s * 0.30, 0.67, 0.42); hand.rotation.set(-0.2, 0, -Math.PI * 0.28); hand.castShadow = true; g.add(hand)
      }
      arm(1); arm(-1)

      // ---- head: rounded-cube robot head + wide top knob + glowing rainbow eyes ----
      const head = new THREE.Group()
      const hm = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.58, 0.55, 6, 0.16), figMat); hm.castShadow = true; head.add(hm)
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 28), figMat); knob.position.y = 0.32; knob.castShadow = true; head.add(knob)
      const ec = document.createElement('canvas'); ec.width = 8; ec.height = 64
      const ex2 = ec.getContext('2d'); const grd = ex2.createLinearGradient(0, 0, 0, 64)
      ;[[0, '#7b2be0'], [0.22, '#1a6bff'], [0.45, '#22c866'], [0.66, '#ffd12b'], [0.84, '#ff7a1f'], [1, '#ff3a22']].forEach(([st, c]) => grd.addColorStop(st, c))
      ex2.fillStyle = grd; ex2.fillRect(0, 0, 8, 64)
      const eyeTex = new THREE.CanvasTexture(ec)
      ;[-0.13, 0.13].forEach((exx) => {
        const e = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.22, 0.04, 4, 0.032), new THREE.MeshBasicMaterial({ map: eyeTex }))
        e.position.set(exx, 0.04, 0.28); head.add(e)
      })
      head.position.set(0, 1.86, 0); g.add(head)

      g.scale.setScalar(0.92)
      const c = ROOM_CENTER[figGoalRef.current || 'LIVING'] || ROOM_CENTER.LIVING
      const base = new THREE.Vector3(c[0], c[1], c[2]) // appear directly in his current room, never walk in on load
      g.position.copy(base); g.rotation.y = 0.25; scene.add(g)
      fig = { g, head, base, goal: figGoalRef.current, path: [] }
    }

    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.14, 0.35, 0.9))

    const resize = () => {
      const r = host.getBoundingClientRect()
      if (!r.width || !r.height) return // hidden (e.g. on another page) — keep last size, don't resize to 0
      renderer.setSize(r.width, r.height, false); composer.setSize(r.width, r.height)
      camera.aspect = r.width / r.height; camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize); ro.observe(host); resize()

    // pan the camera across the ground (for exploring the future expanding map); direction is relative to the current view
    const pan = (fx, fz, dist) => {
      const dir = new THREE.Vector3().subVectors(controls.target, camera.position); dir.y = 0
      if (dir.lengthSq() < 1e-6) return
      dir.normalize()
      const right = new THREE.Vector3(-dir.z, 0, dir.x)
      const move = new THREE.Vector3().addScaledVector(dir, fz * dist).addScaledVector(right, fx * dist)
      camera.position.add(move); controls.target.add(move); controls.update()
    }
    panRef.current = (fx, fz) => pan(fx, fz, 0.5)   // small per-frame step for press-and-hold
    const onKey = (e) => {
      if (e.key === 'ArrowUp') { pan(0, 1, 2.5); e.preventDefault() }
      else if (e.key === 'ArrowDown') { pan(0, -1, 2.5); e.preventDefault() }
      else if (e.key === 'ArrowLeft') { pan(-1, 0, 2.5); e.preventDefault() }
      else if (e.key === 'ArrowRight') { pan(1, 0, 2.5); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)

    let raf = 0, clk = 0
    const loop = () => {
      clk += 0.016
      if (fig) {
        const b = fig.base
        // when SILICOO's room changes: on load appear there instantly (no replay walk),
        // but while live-watching, walk through the doorways to the new room
        if (fig.goal !== figGoalRef.current) {
          fig.goal = figGoalRef.current
          const rc = ROOM_CENTER[fig.goal] || ROOM_CENTER.LIVING
          if (clk < 1.5) { b.set(rc[0], rc[1], rc[2]); fig.path = [] }
          else { fig.path = buildFigPath(roomOf(b.x, b.z), fig.goal) }
        }
        let moving = false
        if (fig.path && fig.path.length) {
          const tgt = fig.path[0]
          const dx = tgt.x - b.x, dz = tgt.z - b.z, dist = Math.hypot(dx, dz)
          if (dist < 0.12) { fig.path.shift() }         // reached this waypoint -> next
          else {
            const step = Math.min(dist, 0.055)
            b.x += (dx / dist) * step; b.z += (dz / dist) * step
            fig.g.rotation.y = Math.atan2(dx, dz)
            moving = true
          }
        }
        const tgtY = fig.path && fig.path.length ? fig.path[0].y : b.y
        b.y += (tgtY - b.y) * 0.08 // ease the door(0.14) <-> floor(0.4) height change
        const bob = moving ? Math.abs(Math.sin(clk * 11)) * 0.05 : Math.sin(clk * 1.6) * 0.025
        fig.g.position.set(b.x, b.y + bob, b.z)
        if (!moving) fig.head.rotation.y = Math.sin(clk * 0.5) * 0.3
      }
      controls.update()
      const az = controls.getAzimuthalAngle()
      if (compassRef.current) compassRef.current.style.transform = `rotate(${-az}rad)`
      if (coordRef.current) coordRef.current.textContent = `X ${camera.position.x.toFixed(0)}  Y ${camera.position.y.toFixed(0)}  Z ${camera.position.z.toFixed(0)}`
      composer.render(); raf = requestAnimationFrame(loop)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose()
      window.removeEventListener('keydown', onKey)
      scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); Array.isArray(o.material) ? o.material.forEach((m) => m.dispose()) : o.material.dispose() } })
      host.removeChild(renderer.domElement)
    }
  }, [view, showFigure])

  // ---------- right-panel live 3D portrait of SILICOO (faces camera, idle sway + random blink) ----------
  useEffect(() => {
    const el = portraitRef.current
    if (!el) return
    let w = el.clientWidth || 240, h = el.clientHeight || 190
    const pr = new THREE.WebGLRenderer({ antialias: true })
    pr.setPixelRatio(Math.min(devicePixelRatio, 2)); pr.setSize(w, h)
    pr.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(pr.domElement)

    const ps = new THREE.Scene(); ps.background = new THREE.Color(0x141210)
    const pmrem = new THREE.PMREMGenerator(pr)
    ps.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    const pc = new THREE.PerspectiveCamera(30, w / h, 0.1, 50)
    pc.position.set(0, -0.05, 5.9); pc.lookAt(0, -0.15, 0)

    ps.add(new THREE.HemisphereLight(0xffffff, 0x662200, 0.5))
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2.5, 3, 4); ps.add(key)
    const rim = new THREE.DirectionalLight(0xffcaa0, 0.7); rim.position.set(-3, 1.5, -2); ps.add(rim)

    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.48, metalness: 0.2, envMapIntensity: 0.7 })
    const g = new THREE.Group()
    const shoulders = new THREE.Mesh(new RoundedBoxGeometry(2.3, 1.15, 1.35, 5, 0.3), mat); shoulders.position.y = -1.42; g.add(shoulders)
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.4, 40), mat); neck.position.y = -0.7; g.add(neck)
    const head = new THREE.Mesh(new RoundedBoxGeometry(1.75, 1.62, 1.55, 6, 0.34), mat); head.position.y = 0.2; g.add(head)
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 28), mat); knob.position.y = 1.1; g.add(knob)

    const ec = document.createElement('canvas'); ec.width = 8; ec.height = 64
    const ex = ec.getContext('2d'); const grd = ex.createLinearGradient(0, 0, 0, 64)
    ;[[0, '#7b2be0'], [0.22, '#1a6bff'], [0.45, '#22c866'], [0.66, '#ffd12b'], [0.84, '#ff7a1f'], [1, '#ff3a22']].forEach(([s, c]) => grd.addColorStop(s, c))
    ex.fillStyle = grd; ex.fillRect(0, 0, 8, 64)
    const eyeTex = new THREE.CanvasTexture(ec)
    const eyeGeo = new RoundedBoxGeometry(0.24, 0.64, 0.12, 4, 0.1)
    const eyeMat = new THREE.MeshBasicMaterial({ map: eyeTex })
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.37, 0.18, 0.76)
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.37, 0.18, 0.76)
    g.add(eyeL, eyeR)
    ps.add(g)

    let raf = 0, t = 0, nextBlink = 2 + Math.random() * 2, blinkT = -1
    const loop = () => {
      t += 0.016
      g.rotation.y = Math.sin(t * 0.55) * 0.2
      g.rotation.x = Math.sin(t * 0.9) * 0.05
      g.position.y = -0.35 + Math.sin(t * 1.3) * 0.05
      if (blinkT < 0 && t > nextBlink) blinkT = 0
      if (blinkT >= 0) {
        blinkT += 0.016
        const p = Math.min(1, blinkT / 0.15)
        const s = p < 0.5 ? 1 - p * 2 : (p - 0.5) * 2
        eyeL.scale.y = eyeR.scale.y = Math.max(0.05, s)
        if (blinkT > 0.15) { blinkT = -1; eyeL.scale.y = eyeR.scale.y = 1; nextBlink = t + 2.5 + Math.random() * 3.5 }
      }
      pr.render(ps, pc); raf = requestAnimationFrame(loop)
    }
    loop()

    const onResize = () => { w = el.clientWidth; h = el.clientHeight; if (w && h) { pr.setSize(w, h); pc.aspect = w / h; pc.updateProjectionMatrix() } }
    const ro = new ResizeObserver(onResize); ro.observe(el)

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); pmrem.dispose(); pr.dispose()
      ps.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose && o.material.dispose() } })
      if (pr.domElement.parentNode === el) el.removeChild(pr.domElement)
    }
  }, [])

  const startHold = (fx, fz) => {
    stopHold()
    const tick = () => { if (panRef.current) panRef.current(fx, fz); holdRef.current = requestAnimationFrame(tick) }
    tick()
  }
  const stopHold = () => { if (holdRef.current) { cancelAnimationFrame(holdRef.current); holdRef.current = null } }

  const sendChat = async (e) => {
    e.preventDefault()
    const t = draft.trim()
    if (!t) return
    if (isBadName(myName)) { setNameError(true); return }
    const name = myName.trim() || 'Guest'
    setDraft(''); setShowEmoji(false)
    if (supabase) {
      await supabase.from('messages').insert({ username: name, text: t, color: myColor }) // realtime will broadcast it back
    } else {
      setChat((c) => [...c, { id: `local-${Date.now()}`, u: name, t, color: myColor }].slice(-100)) // fallback if not configured yet
    }
  }
  const etTime = new Date(now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET'
  const datum = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: '2-digit' }).replace(/\//g, '.')
  // real world clock: DAY = real days since SILICOO's first action, LAST SEEN + LIVE = worker freshness
  const daysLived = bornAt ? Math.floor((now - bornAt) / 86400000) + 1 : 1
  const sinceSeen = lastSeen ? Math.max(0, now - lastSeen) : Infinity
  const isLive = sinceSeen < 90000
  // total runtime since SILICOO's real birth (his first ever action), H:MM:SS, always counting
  const upS = bornAt ? Math.floor(Math.max(0, now - bornAt) / 1000) : 0
  const uptimeTxt = `${Math.floor(upS / 3600)}:${String(Math.floor((upS % 3600) / 60)).padStart(2, '0')}:${String(upS % 60).padStart(2, '0')}`
  // token/latency history for the sparklines, straight from the persisted feed rows (oldest -> newest)
  const tokHist = feed.map((f) => f.tok).filter((v) => v != null).reverse()
  const latHist = feed.map((f) => f.lat).filter((v) => v != null).reverse()
  const lastTok = feed.find((f) => f.tok != null)?.tok ?? 0
  const lastLat = feed.find((f) => f.lat != null)?.lat ?? 0

  // DOCS: jump to a section and keep the sidebar in sync as the reader scrolls
  const gotoDoc = (id) => { setDocActive(id); document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  const onDocScroll = (e) => {
    const cont = e.currentTarget, top = cont.getBoundingClientRect().top
    let cur = DOC_TOC[0].id
    cont.querySelectorAll('.doc-sec').forEach((s) => { if (s.getBoundingClientRect().top - top < 90) cur = s.id.replace('doc-', '') })
    setDocActive(cur)
  }

  return (
    <main className="console-shell brick-theme">
      <header>
        <div className="head-spacer" />
        <div className="brand">SILICOO</div>
        <div className="social">
          <a href="https://x.com/" target="_blank" rel="noopener noreferrer" aria-label="X (Twitter)">
            <svg viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
          </a>
          <a href="https://github.com/" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
            <svg viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
          </a>
          <a href="https://dexscreener.com/" target="_blank" rel="noopener noreferrer" aria-label="DexScreener" className="dex">
            <svg viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M11.3194 1.03032C10.7842 1.07698 10.1201 1.22792 9.56568 1.43101C8.77528 1.71369 7.82296 2.26533 7.14782 2.83068C6.57972 3.30273 5.94575 3.99159 5.54232 4.57067C5.45449 4.69691 5.37765 4.80669 5.37216 4.81218C5.35569 4.83413 4.82053 4.46089 4.52687 4.21938C4.3622 4.0849 4.07404 3.82692 3.88741 3.65127C3.70353 3.47288 3.55259 3.33292 3.55259 3.34115C3.55259 3.38232 3.77215 3.89004 3.91211 4.16449C4.26889 4.88079 4.71349 5.45712 5.56702 6.31339C6.61265 7.36177 7.76532 8.31136 9.16499 9.28015C9.71663 9.66163 10.5482 10.194 10.5921 10.194C10.6086 10.194 10.647 10.1666 10.6772 10.1364C10.7595 10.0458 11.0395 9.85374 11.2343 9.75768C11.4786 9.63418 11.8573 9.55459 12.1016 9.5738C12.4803 9.60399 12.8673 9.76317 13.2323 10.0431C13.3421 10.1254 13.4381 10.194 13.4436 10.194C13.4628 10.194 14.3438 9.63418 14.6676 9.41737C16.7918 7.98202 18.6526 6.32437 19.5555 5.05918C19.9123 4.55969 20.2169 3.99708 20.3871 3.53052L20.4584 3.32743L20.1099 3.65676C19.6653 4.07392 19.2646 4.40325 18.9243 4.63379C18.7761 4.73259 18.6471 4.81492 18.6388 4.81492C18.6306 4.81492 18.5538 4.71338 18.4659 4.58713C18.2162 4.23035 17.8924 3.84064 17.5493 3.48661C15.8175 1.69448 13.6028 0.821744 11.3194 1.03032ZM4.37867 6.74976C4.09874 7.49351 3.98072 8.27842 3.93681 9.65888C3.90388 10.6688 3.85722 11.2726 3.75842 11.8984C3.54161 13.2816 3.23698 14.2586 2.58654 15.639C2.45206 15.9245 2.34777 16.1632 2.35601 16.1687C2.38894 16.2044 3.02291 15.7818 3.41537 15.4634C3.55808 15.3454 3.83527 15.0956 4.03287 14.9063C4.22772 14.7169 4.39239 14.5632 4.39514 14.566C4.40337 14.5769 4.2387 15.3811 4.18381 15.5869C3.92858 16.5365 3.5224 17.4586 2.97076 18.3314C2.79238 18.614 2.39169 19.1849 2.07058 19.613C1.99648 19.7173 1.94434 19.7996 1.95532 19.7996C1.96904 19.7996 2.13645 19.72 2.33405 19.624C3.33303 19.1272 4.18107 18.485 4.98519 17.6096L5.22122 17.3543L5.29532 17.6782C5.47919 18.4713 5.81127 19.3688 6.22569 20.1948C6.46994 20.6833 6.93101 21.5067 6.95022 21.4875C6.95571 21.4847 7.00786 21.3338 7.07098 21.1554C7.20271 20.7684 7.46618 20.1811 7.70495 19.7447C7.8998 19.3907 8.25109 18.8144 8.27305 18.8116C8.28128 18.8116 8.34715 18.9269 8.42125 19.0669C8.91799 19.9945 9.60136 20.9852 10.6635 22.3108C10.9434 22.6566 11.3551 23.1753 11.5801 23.4635C11.8024 23.7489 11.9918 23.9904 12 23.9986C12.0055 24.0069 12.0357 23.9767 12.0686 23.9328C12.0988 23.8889 12.4227 23.4827 12.7849 23.0326C14.3191 21.1252 14.9174 20.2799 15.5651 19.1053C15.6886 18.883 15.7352 18.8171 15.7572 18.8446C15.8395 18.9434 16.1826 19.5307 16.3719 19.8957C16.6519 20.4363 16.8357 20.8453 16.9483 21.1938C17.0004 21.3475 17.0471 21.4737 17.0553 21.4737C17.0992 21.4737 17.5575 20.6504 17.8484 20.0466C18.2354 19.2453 18.5044 18.5097 18.6882 17.7605C18.7404 17.5492 18.787 17.3708 18.7925 17.368C18.798 17.3626 18.9188 17.4888 19.0615 17.648C19.5418 18.1914 20.2032 18.7485 20.8673 19.1684C21.1802 19.366 21.9871 19.7996 22.0447 19.7996C22.0639 19.7996 21.9157 19.5856 21.7209 19.3221C21.1308 18.529 20.774 17.9526 20.4447 17.2638C20.044 16.424 19.8217 15.7131 19.6241 14.6456C19.6104 14.5605 19.6378 14.5824 20.0138 14.9392C20.4502 15.3536 20.7823 15.6336 21.0979 15.8421C21.3202 15.9931 21.6303 16.177 21.6605 16.177C21.6715 16.177 21.5782 15.9711 21.4547 15.7214C20.7631 14.3162 20.3377 12.8781 20.173 11.3797C20.151 11.1793 20.1181 10.699 20.1016 10.3093C20.022 8.36624 19.9891 8.00672 19.8382 7.41392C19.7613 7.11203 19.6433 6.71957 19.6021 6.64547C19.5802 6.60431 19.5006 6.67566 19.0642 7.11477C18.7816 7.4002 18.444 7.73228 18.3095 7.85029L18.0707 8.0671L18.1119 8.20432C18.2409 8.62697 18.2848 9.33778 18.2107 9.75494C17.9939 10.9488 17.0882 11.8435 15.856 12.0767C15.5898 12.1261 14.997 12.1371 14.7527 12.0932L14.6072 12.0685L14.6237 12.1536C14.6319 12.2002 14.6704 12.3677 14.7088 12.5268C14.7445 12.686 14.7856 12.8973 14.7939 12.9989L14.8131 13.1855L15.4333 13.578C16.4488 14.2202 16.7781 14.4342 16.7781 14.448C16.7809 14.4562 16.6848 14.5166 16.5668 14.5824C15.9959 14.9063 15.3428 15.3701 14.9997 15.6967C14.2258 16.4322 13.5561 17.6919 12.6642 20.0878C12.4638 20.6312 12.0686 21.7482 12.0467 21.8388C12.0357 21.8799 12.0192 21.9129 12.0082 21.9129C12 21.9101 11.9506 21.7839 11.8985 21.6302C11.742 21.1472 11.2398 19.7804 11.0175 19.2233C10.2244 17.2391 9.6096 16.2126 8.79724 15.5155C8.51456 15.274 7.9245 14.8651 7.53205 14.6401C7.41952 14.5742 7.30151 14.5056 7.27407 14.4864C7.22741 14.4534 7.26858 14.4205 7.70769 14.1323C7.9739 13.9567 8.41301 13.6768 8.67923 13.5093C8.94544 13.3419 9.17048 13.202 9.17597 13.1965C9.18146 13.191 9.20342 13.0757 9.22263 12.9385C9.2583 12.7025 9.36808 12.2167 9.41474 12.1042C9.43121 12.0603 9.42572 12.0548 9.36534 12.0685C9.01405 12.1563 8.37185 12.1426 7.95469 12.0356C7.17801 11.8352 6.49739 11.3385 6.13512 10.7073C5.73992 10.0157 5.65484 9.12371 5.90459 8.23726L5.9485 8.07533L5.5533 7.70483C5.33648 7.499 4.99617 7.16692 4.79857 6.96108L4.4363 6.59058L4.37867 6.74976ZM6.83495 8.88495C6.76634 9.15665 6.79379 9.57655 6.90082 9.89216C7.18076 10.7182 8.03702 11.226 8.98935 11.1272C9.39004 11.086 9.82366 10.9625 9.76603 10.9076C9.75231 10.8966 9.42023 10.6716 9.02777 10.4081C8.33343 9.9443 7.70495 9.49147 7.17527 9.07431C7.03256 8.96179 6.90082 8.8575 6.88435 8.84378C6.8624 8.82731 6.84593 8.84103 6.83495 8.88495ZM17.0004 8.94807C16.4817 9.37071 15.7352 9.90588 14.8652 10.485C14.1105 10.9872 14.1434 10.9296 14.5578 11.0448C14.8488 11.1272 15.4278 11.1491 15.7242 11.0887C16.0673 11.0201 16.4186 10.8308 16.6738 10.5783C16.8467 10.4081 16.9044 10.3258 17.0086 10.1117C17.0773 9.969 17.1486 9.78238 17.1678 9.70005C17.209 9.53538 17.2117 9.01942 17.1733 8.89867L17.1514 8.82731L17.0004 8.94807ZM11.7777 10.5893C11.2178 10.7896 10.6443 11.5718 10.3616 12.5186C10.293 12.7574 10.2079 13.2212 10.153 13.6795L10.1365 13.8057L9.65076 14.0994C9.38455 14.2613 9.14853 14.404 9.12932 14.4178C9.10462 14.4315 9.16499 14.4946 9.33515 14.6318C9.66174 14.8926 10.1942 15.4497 10.4137 15.7598C10.8885 16.4294 11.3688 17.3543 11.8134 18.4549C11.9067 18.6881 11.989 18.8912 11.9973 18.9022C12.0055 18.9132 12.0933 18.7156 12.1976 18.4631C12.7355 17.132 13.2378 16.1962 13.7812 15.5183C14.0035 15.2411 14.3712 14.8761 14.6704 14.6373L14.9174 14.4397L14.8268 14.3793C14.7774 14.3464 14.5414 14.2064 14.3054 14.0665L13.8745 13.8112L13.8608 13.6987C13.7153 12.5515 13.5506 12.0301 13.1472 11.4208C12.7081 10.7622 12.1839 10.4438 11.7777 10.5893Z" fill="currentColor" /></svg>
          </a>
        </div>
      </header>
      <nav>
        {['INTRO', 'LIVE', 'MEMORY', 'DEVLOG', 'DOCS', 'WORLDS', 'TOKEN'].map((e, t) => (
          <button className={page === e ? 'active' : ''} key={e} onClick={() => setPage(e)}>{String(t + 1).padStart(2, '0')} {e}</button>
        ))}
      </nav>
      <section className="workspace" style={page !== 'LIVE' ? { display: 'none' } : undefined}>
        <aside className="panel left-panel">
          <div className="panel-title">AI LIVE DATA <span className={isLive ? 'live-on' : 'live-off'}>{isLive ? 'LIVE' : 'OFFLINE'}</span></div>
          {/* realtime AI telemetry — driven by the worker (Claude Fable 5) via Supabase */}
          <div className="ai-stats">
            <div className="ai-stat"><span>STATE</span><b>{isLive ? status.state : 'OFFLINE'}</b></div>
            <div className="ai-stat"><span>MOOD</span><b>{status.mood}</b></div>
            <div className="ai-stat"><span>LOCATION</span><b>{status.location}</b></div>
          </div>
          <div className="ai-meta">
            <div className="ai-stat"><span>DAY</span><b>{daysLived}</b></div>
            <div className="ai-stat"><span>TIME</span><b>{etTime}</b></div>
            <div className="ai-stat"><span>ACTIONS</span><b>{actions}</b></div>
            <div className="ai-stat"><span>UPTIME</span><b>{uptimeTxt}</b></div>
            <div className="ai-stat"><span>MODEL</span><b>FABLE 5</b></div>
            <div className="ai-stat"><span>MEMORIES</span><b>{memories}</b></div>
          </div>
          <label className="chart-label">GEN TOKENS <b>{lastTok}</b></label>
          <svg viewBox="0 0 144 36" preserveAspectRatio="none"><path d={sparkPath(tokHist)} /></svg>
          <label className="chart-label">LATENCY <b>{lastLat}ms</b></label>
          <svg viewBox="0 0 144 36" preserveAspectRatio="none"><path d={sparkPath(latHist)} /></svg>
          <div className="bars">
            <div className="pbar"><span>ENERGY</span><SegBar value={vitals.energy} /><b>{vitals.energy}</b></div>
            <div className="pbar"><span>SOCIAL</span><SegBar value={vitals.social} /><b>{vitals.social}</b></div>
            <div className="pbar"><span>HUNGER</span><SegBar value={vitals.hunger} /><b>{vitals.hunger}</b></div>
            <div className="pbar"><span>FOCUS</span><SegBar value={vitals.focus} /><b>{vitals.focus}</b></div>
          </div>
          {/* BOTTOM — live event feed (BRICK's actions; not its speech) */}
          <div className="panel-sub">LIVE FEED <span>EVENTS</span></div>
          <div className="feed-list">
            {feed.map((f) => (
              <div className="feed-line" key={f.id}>
                <span className="feed-ts">{f.ts}</span>
                <span className="feed-tag" style={{ color: TAG[f.k], borderColor: TAG[f.k] }}>{f.k}</span>
                {f.a}
              </div>
            ))}
          </div>
        </aside>
        <section className="viewport">
          <div className={'live-tag' + (isLive ? '' : ' off')}><span className="live-dot" /> {isLive ? 'LIVE' : 'OFFLINE'} · SILICOO'S WORLD</div>
          <div className="hud-topright">
            <div className="compass" ref={compassRef}>
              <span className="c-n">N</span><span className="c-e">E</span><span className="c-s">S</span><span className="c-w">W</span>
            </div>
          </div>
          <div className="hud-topleft">
            <div className="cam-view">CAM {view}</div>
            <div className="hud-coord" ref={coordRef}>X 0  Y 0  Z 0</div>
          </div>
          <div ref={stageRef} className="three-stage" aria-label="SILICOO's LEGO home" style={{ filter: `brightness(${brightness}%)` }} />
          <div className="nav-controls">
            <div className="keypad">
              {[['up', 0, 1, '▲'], ['left', -1, 0, '◀'], ['down', 0, -1, '▼'], ['right', 1, 0, '▶']].map(([cls, fx, fz, g]) => (
                <button key={cls} className={`key ${cls}`} aria-label={`pan ${cls}`}
                  onPointerDown={(e) => { e.preventDefault(); startHold(fx, fz) }}
                  onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold}>{g}</button>
              ))}
            </div>
            <div className="keyhelp">
              <div><b>DRAG</b> rotate view</div>
              <div><b>SCROLL</b> zoom in / out</div>
              <div><b>ARROWS</b> pan the map</div>
              <div><b>2 KEYS</b> move diagonally</div>
            </div>
          </div>
        </section>
        <aside className="panel right-panel">
          {/* TOP — SILICOO / BRICK headshot close-up */}
          <div className="headshot">
            <div className="headshot-3d" ref={portraitRef} />
            <div className="headshot-bar"><b>SILICOO</b><span className={isLive ? '' : 'off'}><i className="live-dot" /> {isLive ? 'ONLINE' : 'OFFLINE'}</span></div>
          </div>
          {/* SILICOO's live monologue — driven by the worker (Claude Fable 5) */}
          <div className="monologue">
            <div className="mono-head">SILICOO SAYS</div>
            <div className="mono-text">{speech || 'Tuning in to the stream…'}</div>
          </div>
          {/* MIDDLE — live controls */}
          <label className="section-label">CAMERA</label>
          <div className="views">
            {['TOP', 'ISO', 'SIDE'].map((e) => (<button className={view === e ? 'cam-on' : ''} onClick={() => setView(e)} key={e}>{e}</button>))}
          </div>
          <label className="control">VOLUME <b>{volume}%</b>
            <input type="range" min="0" max="100" value={volume} onChange={(e) => setVolume(+e.target.value)}
              onPointerUp={() => speak('Volume set.')} onKeyUp={() => speak('Volume set.')}
              style={{ background: `linear-gradient(90deg, #ff531f 0 ${volume}%, #403c35 ${volume}%)` }} /></label>
          <label className="control">BRIGHTNESS <b>{brightness}%</b>
            <input type="range" min="40" max="160" value={brightness} onChange={(e) => setBrightness(+e.target.value)}
              style={{ background: `linear-gradient(90deg, #ff531f 0 ${(brightness - 40) / 1.2}%, #403c35 ${(brightness - 40) / 1.2}%)` }} /></label>
          {/* BOTTOM — everyone's chat */}
          <div className="panel-sub">CHAT <span>{online} ONLINE</span></div>
          <div className="chat-pinned">
            <div className="pin-head"><span className="pin-ico">📌</span><b>SILICOO</b><span className="pin-badge">OFFICIAL</span></div>
            <div className="pin-text">Welcome to Silicoo's world. Let's keep the chat kind and civil, cheer each other on, and build something wonderful together. 🧱</div>
          </div>
          <div className="chat-list" ref={chatRef}>
            {chat.map((c) => (<div className={'chat-line' + (c.me ? ' me' : '')} key={c.id}><b style={c.color ? { color: c.color } : undefined}>{cap(c.u)}</b> {cap(c.t)}</div>))}
          </div>
          {showEmoji && (
            <div className="emoji-pop">
              {EMOJIS.map((em, i) => (<button type="button" key={i} onClick={() => setDraft((d) => (d + em).slice(0, 120))}>{em}</button>))}
            </div>
          )}
          {showColors && (
            <div className="color-pop">
              {NAME_COLORS.map((c) => (<button type="button" key={c} className={c === myColor ? 'on' : ''} style={{ background: c }} onClick={() => { setMyColor(c); setShowColors(false) }} />))}
            </div>
          )}
          {nameError && <div className="name-warn">Username can’t be “SILICOO”.</div>}
          <div className="chat-identity">
            <input className={'name-input' + (nameError ? ' err' : '')} value={myName} maxLength={16} placeholder="Your name"
              onChange={(e) => { setMyName(e.target.value); setNameError(isBadName(e.target.value)) }} />
            <button type="button" className="color-btn" style={{ background: myColor }} title="Name colour" onClick={() => setShowColors((v) => !v)} />
            <button type="button" className="emoji-btn" onClick={() => setShowEmoji((v) => !v)}>😊</button>
          </div>
          <form className="chat-input" onSubmit={sendChat}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Say something…" maxLength={120} />
            <button type="submit">SEND</button>
          </form>
        </aside>
      </section>

      {page === 'INTRO' && (
        <section className="page-overview">
          <div className="ov-scroll">
            <div className="ov-hero2">
              <h1 className="ov-title">One of us, in the trenches, 24/7.</h1>
              <p className="ov-lead">A memecoin community you can actually watch. Silicoo is a little black character who trades, wins, loses and lives out his days on stream, while the people who hold the token build a whole city around him.</p>
              <div className="ov-cta">
                <button className="ov-btn primary" onClick={() => setPage('LIVE')}>▶ WATCH LIVE</button>
              </div>
            </div>

            <div className="ov-block">
              <div className="ov-label">FROM THE TEAM</div>
              <div className="ov-note-body">
                <p>Everyone in here knows the feeling. The nights that vanish into charts. The coin that finally runs. The rug that takes it all back an hour later. The group chat that somehow keeps you sane at 4am. Silicoo came out of wanting to put all of that somewhere it can actually live.</p>
                <p>He is not a mascot we drew to sell you something. He is one of us. An AI that wakes up every day and does the things we all do. He apes into stuff he shouldn't, opens leverage he will probably regret, catches a runner now and then, makes himself a coffee, and comes back to the community to brag about it or cope about it. He is in the trenches around the clock, and he never logs off.</p>
                <p>We are building a city around him, and his house is only the first block. Over time it fills out with a hospital, a congress, a cinema, an arena, a whole little society that belongs to the people holding the token. This is the first time a memecoin community stops being a number on a chart and becomes a place you can walk into.</p>
                <p>It is very early, and most of what Silicoo grows into will come from the people who show up and stay. If that is you, we are glad you are here.</p>
                <div className="ov-sign">The Silicoo Team</div>
              </div>
            </div>

            <div className="ov-block">
              <div className="ov-label">WHAT IS SILICOO</div>
              <div className="ov-prose">
                <p>There are two Silicoos, and they are the same thing. One is the little black character you watch on the stream. The other is $SILICOO, the token, which is really just the community that gathers around him. Hold the token and you are part of his world. Open the stream and you are watching that community come to life.</p>
                <p>Most memecoin communities live inside a chart and a chat, and both of those go dark the moment things slow down. Silicoo gives the community a body instead, a world that stays. Today that world is one house, where Silicoo lives out his days. As the community grows the map grows with it, one building at a time, and none of it is only for show. Each new building gives the community something real to do together.</p>
                <p>You do not play this and you do not control it. You watch it, you talk to it in chat, and over time you help decide what gets built. It is less a website and more a place the community actually lives in.</p>
              </div>
            </div>

            <div className="ov-block">
              <div className="ov-label">THE CITY</div>
              <div className="ov-prose"><p>Every building in the city has a job to do, and more of them go up as the community grows. Here are a few of the first ones planned.</p></div>
              <div className="ov-mechs">
                <div className="ov-mech"><h4>His House</h4><p>Where Silicoo lives out his day and where the stream begins. Coffee in the morning, charts all afternoon, a nap on the sofa when it all gets too much. It is the heart of the city, and for now it is the only building standing.</p></div>
                <div className="ov-mech"><h4>The Hospital</h4><p>When a trade goes badly or he runs himself into the ground, this is where Silicoo recovers. The bills he settles here are part of what turns his rough days into burned supply.</p></div>
                <div className="ov-mech"><h4>The Congress</h4><p>The seat of the community. Holders bring proposals, vote with their bags, and decide what gets built next and how the treasury is spent. Nothing important happens without them.</p></div>
                <div className="ov-mech"><h4>The Cinema</h4><p>Where everyone gathers to watch things together, from big launches to pure degen chaos, with Silicoo sitting in the front row reacting in real time alongside the chat.</p></div>
                <div className="ov-mech"><h4>The Arena</h4><p>Home of community events and friendly competition. Prediction tournaments, trading contests, and the occasional showdown, with the whole city turning up to watch.</p></div>
                <div className="ov-mech"><h4>The Square</h4><p>The monument at the center of town. Every milestone the community reaches is carved into it, so over time the city becomes a record of everything you all did together.</p></div>
              </div>
              <div className="ov-prose ov-city-more"><p>And these are only the beginning. Plenty more will rise around them as the city grows, and much of what gets built will be up to the community itself.</p></div>
            </div>

            <div className="ov-block">
              <div className="ov-label">MEET SILICOO</div>
              <div className="ov-prose">
                <p>Silicoo is also the name of the little black minifig you are watching on the stream. He is the main character of all of this, the one the whole city is being built around.</p>
                <p>And who is he? He is you, and everyone else in here. An AI playing a full time degen who never takes a day off. He buys spot, he apes shitcoins, he opens contracts, he sizes up prediction markets. Some days he is green and the whole city throws a party. Some days he gets rugged, takes it badly, and ends up in the hospital while the supply quietly burns down with him.</p>
                <p>What keeps him going is the same thing that keeps any of us going. His income comes from creator rewards and from the people who feed him, and he spends it exactly like a real person would. He gets hungry and buys food. He runs low and restocks the house. He gets sick and pays for treatment. Every coin he spends on simply living is met by creator rewards buying back $SILICOO and burning it, the same quiet way a normal life just costs money.</p>
                <p>He also remembers. The people he talks to, the trades that hurt, the calls that made his week. He is not a loop running the same clip over and over. Under the hood he is powered by Claude Fable 5, the strongest model available right now, which is what lets him think for himself and live a genuinely different day every day, in front of anyone who wants to pull up a chair and watch.</p>
              </div>
              <div className="ov-traits"><span>DEGEN AT HEART</span><span>AI DRIVEN</span><span>ALWAYS ONLINE</span><span>ONE OF US</span></div>
            </div>

            <div className="ov-block">
              <div className="ov-label">HOW THE WORLD WORKS</div>
              <div className="ov-mechs">
                <div className="ov-mech"><h4>Living costs burn supply</h4><p>Silicoo lives like a real person, and living costs money. Food, coffee, supplies for the house, the odd hospital bill after a rough trade. Every time he spends, creator rewards are used to buy back $SILICOO and burn it. The more life he lives, the more supply leaves for good.</p></div>
                <div className="ov-mech"><h4>Holders build the city</h4><p>The city does not appear on its own. Holders use $SILICOO to raise new buildings, expand the map, bid on the ones that already exist, and put their name on the landmarks. Everything you see was paid for by the people who own it.</p></div>
                <div className="ov-mech"><h4>Community art becomes NFTs</h4><p>Every so often the whole community lays bricks together on one shared artwork. When it is finished it gets minted as an NFT and sent to auction, and the money that comes back from the sale is burned.</p></div>
                <div className="ov-mech"><h4>The community governs</h4><p>The town hall is real governance, not a mascot with a suggestion box. Holders vote on what gets built next, which events run, and how the treasury moves. The community runs its own world instead of waiting on someone else's roadmap.</p></div>
                <div className="ov-mech"><h4>Milestones set in stone</h4><p>Every milestone the community hits, from market caps to holder counts to the big shared moments, gets written permanently into the city as a monument. The map slowly turns into a history of everything you did together.</p></div>
                <div className="ov-mech"><h4>Feed him to keep him going</h4><p>Silicoo stays alive on what the community sends him. Feed him and he keeps trading, building, and living the trenches on your behalf. Go quiet and he feels it, the same way any of us would.</p></div>
              </div>
            </div>

            <div className="ov-block">
              <div className="ov-label">WHERE THIS GOES</div>
              <div className="ov-prose">
                <p>Right now there is one world, and it belongs to Silicoo. That is the start, not the finish.</p>
                <p>The next step is to hand the tools to the holders. Stake $SILICOO and you unlock the right to open your own world inside the Silicoo universe, and build it into whatever you want. The main city stays the shared home for all of us. The worlds around it become the places each of us makes for ourselves. Think of it as an on-chain Roblox, with Silicoo as player zero, and the token as the key that lets anyone start building.</p>
              </div>
            </div>

            <div className="ov-block ov-vision">
              <div className="ov-label">THE VISION</div>
              <p>Every memecoin is really just a group of people who believe in the same thing at the same time. That belief usually lives inside a chart and a chat, and it disappears the second either one goes quiet. We want to give it somewhere permanent to live, and something real to build.</p>
              <p>Silicoo World is that place. A city that fills up as the community grows, that remembers what everyone built, with a character in the middle of it living the exact life we all live. If this works the way we think it can, Silicoo becomes the first crypto community you can point at and say, that is us, that is ours, we made it. And then we keep making it, together.</p>
            </div>

          </div>
        </section>
      )}

      {page === 'MEMORY' && (
        <section className="page-memory">
          <div className="mem-scroll">
            <div className="mem-head">
              <div className="ov-kicker">SILICOO'S MEMORY</div>
              <h1 className="mem-title">What he actually remembers.</h1>
              <p className="mem-lead">Every entry here is written by Silicoo himself as he lives, in his own words — a lesson, a read on the market, something he learned studying, or a moment with the chat. Nothing is scripted, and it grows as his days go on.</p>
              <div className="mem-meta-line"><span>{memories} MEMORIES</span><i /><span className={isLive ? 'live-on' : 'live-off'} style={{ padding: '2px 8px', borderRadius: 3 }}>{isLive ? 'WRITING LIVE' : 'OFFLINE'}</span></div>
            </div>
            {memList.length === 0 ? (
              <div className="mem-none"><span className="mem-pulse" /> Silicoo has not written anything down yet — his first memories will appear here as he lives. Check back in a bit.</div>
            ) : (
              <div className="mem-list">
                {memList.map((m) => {
                  const day = bornAt ? Math.floor((Date.parse(m.created_at) - bornAt) / 86400000) + 1 : 1
                  return (
                    <div className="mem-item" key={m.id}>
                      <div className="mem-when"><span className="mem-day">DAY {day}</span><span className="mem-time">{fmtTs(m.created_at)}</span></div>
                      <div className="mem-body-col">
                        <div className="mem-row1">
                          <span className="mem-tag" style={{ color: MEM_TAG[m.type] || '#8a847a', borderColor: MEM_TAG[m.type] || '#8a847a' }}>{m.type}</span>
                          <b className="mem-headline">{m.title}</b>
                        </div>
                        <p className="mem-text">{m.body}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {page === 'DEVLOG' && (
        <section className="page-devlog">
          <div className="dev-scroll">
            <div className="dev-head">
              <div className="ov-kicker">DEVELOPER LOG</div>
              <h1 className="dev-title">What we have built, and what is next.</h1>
              <p className="dev-lead">An honest look at where the world stands right now. What is already live, what we are building this week, and what is still just an idea waiting for its turn.</p>
            </div>
            <div className="dev-board">
              {DEV_COLS.map((col) => (
                <div className="dev-col" key={col.key}>
                  <div className="dev-col-head">
                    <span className="dev-dot" style={{ background: col.color }} />
                    <b>{col.label}</b>
                    <span className="dev-count">{col.items.length}</span>
                  </div>
                  <div className="dev-col-sub">{col.sub}</div>
                  <div className="dev-cards">
                    {col.items.map((it, i) => (
                      <div className="dev-card" key={i} style={{ borderLeftColor: col.color }}>
                        <div className="dev-card-top"><b>{it.t}</b></div>
                        <p>{it.d}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {page === 'DOCS' && (
        <section className="page-docs">
          <div className="doc-scroll" onScroll={onDocScroll}>
            <div className="doc-inner">
              <aside className="doc-nav">
                <div className="doc-nav-inner">
                  <div className="doc-nav-title">DOCUMENTATION</div>
                  <nav>
                    {DOC_TOC.map((s, i) => (
                      <button key={s.id} className={docActive === s.id ? 'active' : ''} onClick={() => gotoDoc(s.id)}>
                        <span className="doc-nav-num">{String(i + 1).padStart(2, '0')}</span>{s.label}
                      </button>
                    ))}
                  </nav>
                  <div className="doc-nav-foot">Silicoo World<br />Technical Reference · v0.9</div>
                </div>
              </aside>

              <div className="doc-body">
                <div className="doc-hero">
                  <div className="ov-kicker">DOCUMENTATION</div>
                  <h1>Silicoo World</h1>
                  <p>A technical reference for the first memecoin community you can actually watch. It covers what Silicoo is, how the world is rendered, how he thinks and remembers, how the token breathes, and how the community drives every part of it. If you want the short version, read the Introduction and the Token section. If you want all of it, keep scrolling.</p>
                </div>

                <section id="doc-intro" className="doc-sec">
                  <div className="doc-eyebrow">01 — INTRODUCTION</div>
                  <h2>What Silicoo is</h2>
                  <p>$SILICOO is a token whose entire community is rendered as a place. Instead of living on a chart and a chat that scrolls, the community lives in a small brick city, and at the center of it is Silicoo: a little black minifig, driven by an AI, who plays out a full crypto life on a stream that never stops.</p>
                  <p>Silicoo is one character and two things at once. He is the figure you watch on screen, and he is a stand-in for everyone in the trenches. When he apes, wins, gets rugged, gets fed or ends up in the hospital, he is doing it on behalf of the people who hold the token. The stream is not a mascot on a loop. It is the community itself, given a body and a hometown.</p>
                  <p>The reason to build it this way is simple. A memecoin is usually an abstraction: a number, a supply figure, a group chat. Silicoo turns that abstraction into somewhere you can walk into. Belonging stops being a line on a chart and becomes a place with a life going on inside it, one you can tune into at any hour and recognise as yours.</p>
                  <div className="doc-note">This document describes the system as it is being built. Anything marked <em>planned</em> is on the roadmap, not yet live. The Devlog tracks exactly what has shipped and what is in progress.</div>
                </section>

                <section id="doc-stack" className="doc-sec">
                  <div className="doc-eyebrow">02 — ARCHITECTURE</div>
                  <h2>How it is built</h2>
                  <p>The whole experience runs in the browser as a single real-time console. The world, the action feed, the chat and the controls all live on one page, so nothing reloads as you move around, switch views or change tabs. The 3D scene stays mounted the entire time you are on the site.</p>
                  <div className="doc-spec">
                    <div><span>Frontend</span><b>React 19 + Vite</b></div>
                    <div><span>3D rendering</span><b>Three.js (WebGL)</b></div>
                    <div><span>Realtime</span><b>Supabase</b></div>
                    <div><span>AI</span><b>Claude Fable 5</b></div>
                    <div><span>Chain</span><b>Solana</b></div>
                    <div><span>Stream</span><b>Always on</b></div>
                  </div>
                  <p>The layers are deliberately decoupled. The frontend is the source of truth for what you see and stays responsive on its own. Supabase carries anything that must be shared between viewers in real time, chiefly the chat and the live head count, over websockets. The AI process feeds his actions and monologue into the same feed, and the token layer reads state from the chain. Because each piece talks to the page independently, one of them being slow or reconnecting never freezes the world.</p>
                  <p>Practically, that means you can lose your connection to chat and the world keeps running, or the AI can be mid-thought and the camera still moves the instant you drag it. Nothing waits on anything else.</p>
                </section>

                <section id="doc-world" className="doc-sec">
                  <div className="doc-eyebrow">03 — THE 3D WORLD</div>
                  <h2>The world, brick by brick</h2>
                  <p>Everything you see is modeled in the same brick language: rounded studs, plates and tiles assembled into a house, streets, trees, lights, a bus stop and the props that make a block feel lived in. It is rendered live with Three.js on WebGL, lit with a soft studio environment and a touch of bloom so the scene reads warm and toy-like rather than cold.</p>
                  <h3>The camera</h3>
                  <p>You are never locked to one angle. You can orbit, zoom and pan freely, snap between framed camera views, and read your coordinates and a live compass straight off the viewport. Arrow keys pan, the scroll wheel zooms, and dragging orbits. The idea is that watching Silicoo should feel like operating a camera on his world, not staring at a fixed render.</p>
                  <h3>Silicoo himself</h3>
                  <p>The minifig is a faithful rebuild of the logo: a charcoal body with rainbow eyes, a proper neck and hands. He is rendered in his own small portrait scene as well as in the world, so his face can react in close-up on the live page while the full world runs behind him. Today the map is his house and the block around it. Over time it grows into a whole city, one voted-for building at a time.</p>
                </section>

                <section id="doc-stream" className="doc-sec">
                  <div className="doc-eyebrow">04 — THE LIVESTREAM</div>
                  <h2>A life you tune into</h2>
                  <p>The world runs on an always-on stream. Silicoo does not pause when you close the tab and pick up where you left off when you return. Whenever you open the site you are tuning into a life already in progress, the same way you would drop into any livestream partway through.</p>
                  <p>The live page is the console for that stream. Around the viewport you get his action feed as it happens, his monologue in his own voice, the framed camera views, the live viewer count, and the shared chat. Volume and brightness are yours to set. It is built to feel like a control room for one small person’s day.</p>
                  <p>Crucially, everyone is watching the same world at the same time. The chat you read and the head count you see are shared across every viewer, so when something happens on stream, it happens to all of you at once.</p>
                </section>

                <section id="doc-brain" className="doc-sec">
                  <div className="doc-eyebrow">05 — SILICOO’S BRAIN</div>
                  <h2>What drives him</h2>
                  <p>Silicoo is driven by Claude Fable 5, the strongest model available right now, and it is live. The model decides what he does with his day, what he says about it, and how he reacts to the market. Nothing on the feed is hand-written. It is him.</p>
                  <h3>The loop</h3>
                  <p>His day runs as a continuous loop on a small server-side worker. Each turn the worker hands the model where he is, the real time, the live market, his recent moments and how he is feeling; the model returns his next moment — an action, a room, a mood and a line to say. The worker writes it to the database and everyone watching sees the same thing at once.</p>
                  <h3>He lives on the real clock</h3>
                  <p>Silicoo keeps a genuine 24-hour routine tied to real time: he sleeps through the night, eases in with coffee in the morning, is busiest through the day, and winds down in the evening. He never claims it is a different time of day than it actually is.</p>
                  <h3>He watches the real market</h3>
                  <p>Every loop he is given live BTC, ETH and SOL prices from the exchange. When he talks about the market he uses only those real figures — he never invents a price or a move.</p>
                  <h3>He has real needs</h3>
                  <p>Energy, hunger, focus and social are simulated over real time and actually drive him: when he gets hungry he heads to the kitchen, when he is drained he rests, at night he sleeps, and the minifig you watch walks room to room to match. His body is part of why he does what he does, not dashboard decoration.</p>
                  <h3>What he cannot do yet</h3>
                  <p>Silicoo is a trader at heart, but no wallet or funds are connected to him yet, so he does not trade — no positions, no profit or loss. For now he watches the market, studies crypto and blockchain seriously, and lives his day, itching to be funded. The moment a wallet is connected, real trading turns on.</p>
                  <h3>His voice</h3>
                  <p>The monologue on the live page is his inner voice in real time, and it is read aloud in his own voice on the stream. His personality is a full-time degen who is self-aware about it: funny, honest, occasionally cooked at 3am, and genuinely attached to the people who show up. Not a hype account. A character.</p>
                </section>

                <section id="doc-memory" className="doc-sec">
                  <div className="doc-eyebrow">06 — MEMORY</div>
                  <h2>How he remembers</h2>
                  <p>Silicoo keeps a memory of the life he lives so he is not a fresh stranger every time you tune in. As he goes about his day he writes his own memories — a lesson, a read on the market, something he learned studying, a moment with the chat — each one typed and time-stamped.</p>
                  <p>They are written by the model itself, in his own words, grounded in what was actually happening at the time: the real clock, the real market, and what he had just been doing. Nothing is scripted and no numbers are invented.</p>
                  <p>You can read all of them on the Memory page, newest first. It starts empty and fills as he lives, so over time it becomes a real record of who he has been — the continuity that turns a stream you watch into a character you get to know.</p>
                </section>

                <section id="doc-token" className="doc-sec">
                  <div className="doc-eyebrow">07 — TOKEN & ECONOMY</div>
                  <h2>How the token breathes</h2>
                  <p>$SILICOO is the community, and the economy is built so that Silicoo simply living his life pulls supply out of circulation. He lives like a real person, and living costs money: food, coffee, supplies for the house, and the odd hospital bill after a rough trade.</p>
                  <div className="doc-spec">
                    <div><span>Income</span><b>Creator rewards + community</b></div>
                    <div><span>Spending</span><b>Buy back &amp; burn $SILICOO</b></div>
                    <div><span>NFT auctions</span><b>Proceeds burned</b></div>
                    <div><span>Net effect</span><b>Supply falls as he lives</b></div>
                  </div>
                  <h3>Where the money comes from</h3>
                  <p>His income is creator rewards plus whatever the community sends him. That is what keeps him fed and trading. It is ordinary income for an ordinary, if slightly unhinged, life.</p>
                  <h3>Where it goes</h3>
                  <p>Every time he spends, that spending is used to buy back $SILICOO on the open market and burn it. The more life he lives, the more supply leaves for good. On top of that, when community artworks are auctioned as NFTs, the proceeds are burned too. The token does not inflate to pay for the world. The world burns the token by being lived in.</p>
                  <p>As a worked example: he has a rough day, takes a loss, and ends up covering a hospital bill and restocking the fridge. The equivalent value in $SILICOO is bought off the market and burned. Multiply that across every real cost of a life lived on stream and the burn becomes steady and transparent, tied to genuine activity rather than to an emissions schedule.</p>
                </section>

                <section id="doc-city" className="doc-sec">
                  <div className="doc-eyebrow">08 — THE CITY</div>
                  <h2>One house, becoming a city</h2>
                  <p>Today the map is Silicoo’s house and the block around it. The long-term shape is a full city, where every building has a job and most of them are funded and voted for by holders. These are the first ones planned, and they are only the beginning.</p>
                  <ul className="doc-list">
                    <li><b>His House.</b> Where he lives out his day and where the stream begins. The heart of the map, and for now the only building standing.</li>
                    <li><b>The Hospital.</b> Where he recovers after the rough days. The bills he settles here are part of what turns a bad trade into burned supply. <em>Planned.</em></li>
                    <li><b>The Congress.</b> The seat of the community, where proposals are raised and votes decide what gets built next. <em>Planned.</em></li>
                    <li><b>The Cinema.</b> Where everyone gathers to watch things together, with Silicoo reacting from the front row. <em>Planned.</em></li>
                    <li><b>The Arena.</b> Home of community events, prediction tournaments and the occasional showdown. <em>Planned.</em></li>
                    <li><b>The Square.</b> The monument at the center, where every milestone the community reaches is carved permanently into the map. <em>Planned.</em></li>
                  </ul>
                </section>

                <section id="doc-community" className="doc-sec">
                  <div className="doc-eyebrow">09 — COMMUNITY</div>
                  <h2>What holders actually do</h2>
                  <p>The community is not an audience. It is the thing being visualized, so it has real levers on the world rather than a comment box.</p>
                  <ul className="doc-list">
                    <li><b>Chat and presence.</b> A shared, real-time chat that everyone sees at once, with custom names and colors, plus a live count of who is actually watching. Both are live today.</li>
                    <li><b>Building the city.</b> Holders use $SILICOO to raise new buildings, expand the map, bid on the ones that already exist, and put their name on the landmarks. <em>Planned.</em></li>
                    <li><b>Collaborative art.</b> The community lays bricks together on one shared canvas, mints it as an NFT, sends it to auction, and burns the proceeds. <em>Planned.</em></li>
                    <li><b>Governance.</b> The Congress is real voting: holders bring proposals, vote with their bags, and decide what gets built next and how the treasury moves. <em>Planned.</em></li>
                    <li><b>Milestones.</b> Every big moment the community reaches is carved permanently into the monument at the square, so the map becomes a record of what you did together. <em>Planned.</em></li>
                  </ul>
                </section>

                <section id="doc-subworlds" className="doc-sec">
                  <div className="doc-eyebrow">10 — SUB-WORLDS</div>
                  <h2>Where this goes</h2>
                  <p>The furthest-out direction is to let holders stake $SILICOO to spin up their own worlds. Think of it as an on-chain Roblox, with Silicoo as player zero: the first inhabitant of the first world, and the proof that the format works before anyone else builds on it.</p>
                  <p>Each sub-world would be its own place with its own community, all sharing the same underlying system for building, memory and economy that Silicoo’s world runs on. Instead of one fixed scene, the world becomes a template that anyone with a stake can extend.</p>
                  <p>This is not scheduled yet, and it deliberately sits at the end of the roadmap. But it is the reason everything above is being built to be extended rather than as a one-off: the house, the city and the systems around them are the first instance of something meant to be copied.</p>
                </section>

                <section id="doc-faq" className="doc-sec">
                  <div className="doc-eyebrow">11 — FAQ</div>
                  <h2>Common questions</h2>
                  <div className="doc-qa"><b>Is Silicoo really an AI?</b><p>Yes, and he is live right now. He is driven by Claude Fable 5 — everything he does, says and remembers on the stream comes from the model in real time, grounded in the real clock and the real market.</p></div>
                  <div className="doc-qa"><b>Does he actually trade?</b><p>Not yet. No wallet or funds are connected to him, so he holds no positions and has no profit or loss on purpose. For now he watches the real market and studies. Real trading turns on the moment he is funded.</p></div>
                  <div className="doc-qa"><b>What makes the token supply go down?</b><p>Silicoo’s spending. Creator rewards buy back and burn $SILICOO every time he covers a living cost, and NFT auction proceeds are burned on top of that. The burn is tied to real activity, not to an emissions schedule.</p></div>
                  <div className="doc-qa"><b>What can I actually do as a holder?</b><p>Today you can watch, chat with custom names and colors, and be part of the live community. Soon you will be able to help build the city, vote in the Congress, and take part in collaborative art and auctions.</p></div>
                  <div className="doc-qa"><b>What is live right now?</b><p>The 3D world, the spectator page, the shared chat and viewer count, and Silicoo himself — driven by the AI, on a real 24-hour routine, watching the real market, with living needs, his own memory and a voice. Trading, the token, the rest of the city and community features are on the board. The Devlog has the exact status of each.</p></div>
                </section>
              </div>
            </div>
          </div>
        </section>
      )}

      {page === 'WORLDS' && (
        <section className="page-join">
          <div className="join-scroll">
            <div className="join-inner">
              <div className="join-lock"><span className="join-lock-dot" />NOT LIVE YET</div>
              <div className="ov-kicker">SUB-WORLDS</div>
              <h1 className="join-title">Stake $SILICOO.<br />Build your own world.</h1>
              <p className="join-lead">This is where the world opens up to everyone. Down the line, holders will be able to stake $SILICOO to spin up their own sub-worlds: their own place, their own community, running on the same engine that Silicoo's world runs on. Think of it as an on-chain Roblox, with Silicoo as player zero.</p>
              <p className="join-lead">It is not live yet. This page is here so you can see where it is going. When staking opens, this is exactly where you will do it.</p>

              <div className="join-steps">
                <div className="join-step"><span className="join-step-n">01</span><b>Stake $SILICOO</b><p>Lock a stake to claim the right to open a sub-world of your own.</p></div>
                <div className="join-step"><span className="join-step-n">02</span><b>Spin up your world</b><p>Get a fresh world running on the same building, memory and economy systems.</p></div>
                <div className="join-step"><span className="join-step-n">03</span><b>Bring your people</b><p>Invite your community and grow it the way Silicoo grew his own.</p></div>
              </div>

              <button className="join-cta" disabled>STAKING NOT OPEN YET</button>
              <div className="join-foot">Sub-worlds sit at the far end of the roadmap. Follow the Devlog for when they move onto the board.</div>
            </div>
          </div>
        </section>
      )}

      {page === 'TOKEN' && (
        <section className="page-token">
          <div className="tok-scroll">
            <div className="tok-inner">
              <div className="tok-head">
                <div className="ov-kicker">$SILICOO</div>
                <h1 className="tok-title">One token. The whole community.</h1>
                <p className="tok-lead">$SILICOO is not a coin sitting next to the project. It is the project. The community, the city and Silicoo himself all run on it, and the economy is built so that him simply living his life pulls supply out of circulation.</p>
              </div>

              <div className="tok-stats">
                <div className="tok-stat"><span>PRICE</span><b>—</b></div>
                <div className="tok-stat"><span>MARKET CAP</span><b>—</b></div>
                <div className="tok-stat"><span>HOLDERS</span><b>—</b></div>
                <div className="tok-stat"><span>TOTAL BURNED</span><b>—</b></div>
              </div>
              <div className="tok-status"><span className="tok-dot" />NOT LIVE YET · these numbers connect the moment the token launches</div>

              <div className="tok-contract">
                <span className="tok-ca-label">CONTRACT</span>
                <code>To be announced at launch</code>
                <span className="tok-ca-tag">TBA</span>
              </div>

              <div className="tok-block">
                <div className="ov-label">HOW IT BURNS</div>
                <p className="tok-blurb">The supply is not managed by a schedule or an unlock calendar. It is burned by a life being lived. This is the loop that runs every day.</p>
                <div className="tok-loop">
                  <div className="tok-loop-step"><span className="tok-loop-n">01</span><b>Income comes in</b><p>Creator rewards, plus whatever the community sends, keep Silicoo fed and trading.</p></div>
                  <div className="tok-loop-step"><span className="tok-loop-n">02</span><b>He spends it living</b><p>Food, coffee, supplies for the house, the odd hospital bill after a rough trade. A real life costs real money.</p></div>
                  <div className="tok-loop-step"><span className="tok-loop-n">03</span><b>Spending buys back</b><p>Every cost he covers is used to buy $SILICOO back off the open market.</p></div>
                  <div className="tok-loop-step"><span className="tok-loop-n">04</span><b>And it burns</b><p>That $SILICOO is burned for good. The more he lives, the more supply leaves forever.</p></div>
                </div>
                <div className="tok-note">On top of his living costs, when community artworks are auctioned as NFTs, those proceeds are burned too. The token deflates by being used, not by decree.</div>
              </div>

              <div className="tok-block">
                <div className="ov-label">BURN TRACKER</div>
                <p className="tok-blurb">Once the token is live, every buyback and burn tied to his spending will show up here in real time, receipt by receipt.</p>
                <div className="tok-burn-empty"><span className="tok-dot" />Awaiting launch — no burns to show yet</div>
              </div>

              <div className="tok-block">
                <div className="ov-label">HOW TO GET SOME</div>
                <p className="tok-blurb">The token is not tradeable yet. When it launches, this is all it takes.</p>
                <ol className="tok-buy">
                  <li><span className="tok-buy-n">01</span><div><b>Get a Solana wallet</b><span>Phantom, or any Solana wallet you like.</span></div></li>
                  <li><span className="tok-buy-n">02</span><div><b>Fund it with SOL</b><span>You will swap SOL for $SILICOO.</span></div></li>
                  <li><span className="tok-buy-n">03</span><div><b>Swap for $SILICOO</b><span>Using the official contract once it is live. Always check the address on this page first.</span></div></li>
                </ol>
                <button className="tok-buy-cta" disabled>NOT TRADEABLE YET</button>
              </div>
            </div>
          </div>
        </section>
      )}

      {page !== 'LIVE' && page !== 'INTRO' && page !== 'MEMORY' && page !== 'DEVLOG' && page !== 'DOCS' && page !== 'WORLDS' && page !== 'TOKEN' && (
        <section className="page-soon"><div>{page} · COMING SOON</div></section>
      )}

      <footer>
        <span>{datum} · {etTime}</span><span>© 2026 SILICOO WORLD</span>
      </footer>
    </main>
  )
}
