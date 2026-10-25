// 資料表在第一次收到請求時自動建立,所以「一鍵部署」和手動部署都不需要另外跑 migration。
// 全部用 IF NOT EXISTS,重複執行無害。
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    days INTEGER NOT NULL DEFAULT 3,
    tips TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    start_date TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    lat REAL,
    lng REAL,
    url TEXT,
    note TEXT NOT NULL DEFAULT '',
    added_by TEXT NOT NULL DEFAULT '',
    time TEXT,
    kind TEXT NOT NULL DEFAULT 'place',
    fixed INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    geo_tried INTEGER NOT NULL DEFAULT 0,
    travel TEXT,
    stay INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS items_trip ON items(trip_id, day, position)',
];

// 舊版資料庫(沒有這些欄位)自動補上
const ADDED_COLUMNS = [
  ['items', 'time', 'TEXT'],
  ['items', 'kind', "TEXT NOT NULL DEFAULT 'place'"],
  ['items', 'fixed', 'INTEGER NOT NULL DEFAULT 0'],
  ['items', 'cost', 'REAL'],
  ['items', 'geo_tried', 'INTEGER NOT NULL DEFAULT 0'],
  ['items', 'travel', 'TEXT'],
  ['items', 'stay', 'INTEGER'],
  ['items', 'alias', 'TEXT'],
  ['items', 'kind_set', 'INTEGER NOT NULL DEFAULT 0'],
  ['trips', 'start_date', 'TEXT'],
  ['trips', 'code', 'TEXT'],
];

async function init(env) {
  await env.DB.batch(STATEMENTS.map((s) => env.DB.prepare(s)));
  for (const table of ['items', 'trips']) {
    const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
    const have = new Set(results.map((r) => r.name));
    for (const [t, name, def] of ADDED_COLUMNS) {
      if (t === table && !have.has(name)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`).run();
    }
  }
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS trips_code ON trips(code)').run();
}

let ready = null;

export function ensureSchema(env) {
  // 同一個 isolate 只做一次;失敗時清掉,下次請求再試
  ready ??= init(env).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}
