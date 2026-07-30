interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Washington State DMV MCP — the Department of Licensing's VIN-level electric-vehicle
 * population file and its monthly vehicle-registration transaction counts. Keyless.
 *
 * Washington has no agency called "the DMV": vehicle registration and driver licensing are
 * run by the Department of Licensing (DOL). Agents still search "WA DMV", so both names
 * appear throughout the tool descriptions.
 *
 * One pack per state agency: Washington's two files have two different grains, and neither
 * matches California's ZIP × fuel snapshot or New York's record-level registration file, so
 * Washington gets its own tools with its own real arguments.
 *
 * Sources (verified live 2026-07-29):
 *   data.wa.gov Socrata — f6w7-q2d2 Electric Vehicle Population Data (289,564 VIN-level rows,
 *                         a true fleet snapshot, refreshed 2026-07-16)
 *                       — hmzg-s6q4 Vehicle Registration Transactions by county, fuel and use
 *                         class, one row per month (refreshed 2026-07-22)
 *
 * The transaction file is the trap in this state: King County runs ~160,000 registration
 * transactions a month, so summing every month back to fiscal 2017 returns 17.6M — a real
 * sum of a quantity nobody asked for. Every query there is scoped to one fiscal year or one
 * month, and labelled as transactions rather than fleet size.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-wa-dmv/1.0 (+https://pipeworx.io)';
const DOMAIN = 'data.wa.gov';

const EV_RESOURCE = 'f6w7-q2d2';
const TXN_RESOURCE = 'hmzg-s6q4';

/** Exact `ev_type` labels the EV file publishes. */
const BEV_LABEL = 'Battery Electric Vehicle (BEV)';
const PHEV_LABEL = 'Plug-in Hybrid Electric Vehicle (PHEV)';

/** Plain words agents pass → the exact ev_type label. */
const EV_TYPE_ALIASES: Record<string, string> = {
  bev: BEV_LABEL, 'battery electric': BEV_LABEL, 'battery electric vehicle': BEV_LABEL,
  electric: BEV_LABEL, 'full electric': BEV_LABEL, 'all electric': BEV_LABEL,
  phev: PHEV_LABEL, 'plug-in hybrid': PHEV_LABEL, 'plug in hybrid': PHEV_LABEL,
  'plugin hybrid': PHEV_LABEL, 'plug-in hybrid electric vehicle': PHEV_LABEL,
};

const EV_GROUPS: Record<string, string> = {
  county: 'county',
  city: 'city',
  zip: 'zip_code',
  make: 'make',
  model: 'model',
  model_year: 'model_year',
  ev_type: 'ev_type',
  cafv_type: 'cafv_type',
  legislative_district: 'legislative_district',
  electric_utility: 'electric_utility',
};

/** Exact `fuel_type` labels in the transaction file, by descending row count. */
const TXN_FUELS = [
  'Gasoline', 'Unpowered', 'Diesel', 'Flex Fuel/Gasoline', 'Hybrid', 'Electric', 'Other',
  'Propane', 'Compressed Natural Gas', 'Liquefied Natural Gas', 'Steam', 'Butane',
  'Liquefied Petroleum Gas', 'Hydrogen Fuel Cell',
];

const TXN_FUEL_ALIASES: Record<string, string> = {
  gas: 'Gasoline', gasoline: 'Gasoline', petrol: 'Gasoline',
  diesel: 'Diesel',
  electric: 'Electric', ev: 'Electric', bev: 'Electric',
  hybrid: 'Hybrid',
  flex: 'Flex Fuel/Gasoline', 'flex-fuel': 'Flex Fuel/Gasoline', 'flex fuel': 'Flex Fuel/Gasoline',
  cng: 'Compressed Natural Gas', 'natural gas': 'Compressed Natural Gas',
  lng: 'Liquefied Natural Gas', lpg: 'Liquefied Petroleum Gas',
  propane: 'Propane', hydrogen: 'Hydrogen Fuel Cell', 'fuel cell': 'Hydrogen Fuel Cell',
  trailer: 'Unpowered', unpowered: 'Unpowered',
};

const TXN_GROUPS: Record<string, string> = {
  county: 'registered_owner_county',
  transaction_county: 'transaction_county_name',
  fuel: 'fuel_type',
  use_class: 'use_class',
  month: 'month',
  fiscal_year: 'fiscal_year',
};

const EARLIEST_FISCAL_YEAR = 2017;

/**
 * Socrata returns an average of all-zero values as the string "0E-24". govNumber strips
 * everything outside [0-9.-], which turns that into "0-24" and then NaN, so a real average
 * of zero would come back as "unknown". Parse the exponent form directly and round to a
 * tenth of a mile.
 */
function avgMiles(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function mapEvType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return EV_TYPE_ALIASES[raw.toLowerCase()] ?? raw;
}

function mapTxnFuel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return TXN_FUEL_ALIASES[raw.toLowerCase()] ?? raw;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'wa_dmv_ev_population',
    description:
      'Count electric vehicles currently registered in Washington State, from the Department of Licensing (Washington DMV) VIN-level Electric Vehicle Population file — one row per registered vehicle, so these are fleet counts rather than sales or transactions. Breaks down by county, city, ZIP code, make, model, model year, legislative district, electric utility, or vehicle type, and separates battery-electric (BEV) from plug-in hybrid (PHEV). Reports average and median electric range and clean-alternative-fuel-vehicle eligibility. Answers "how many EVs are registered in Washington", "how many Teslas are in King County", "EV count by ZIP in Seattle", "BEV versus PHEV split in Washington", and "which Washington legislative district has the most electric vehicles".',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'Washington county in plain mixed case, e.g. "King", "Pierce", "Snohomish", "Spokane".' },
        city: { type: 'string', description: 'City name in plain mixed case, e.g. "Seattle", "Bellevue", "Tacoma".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "98052".' },
        make: { type: 'string', description: 'Vehicle make, upper case in the source and matched as a substring, e.g. "TESLA", "CHEVROLET", "RIVIAN".' },
        model: { type: 'string', description: 'Model name, upper case in the source and matched as a substring, e.g. "MODEL 3", "BOLT EV", "LEAF".' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2025".' },
        ev_type: { type: 'string', description: `Drivetrain: "BEV" or "battery electric" for ${BEV_LABEL}, "PHEV" or "plug-in hybrid" for ${PHEV_LABEL}.` },
        legislative_district: { type: 'string', description: 'Washington legislative district number, e.g. "44".' },
        group_by: { type: 'string', description: `Breakdown dimension: ${Object.keys(EV_GROUPS).join(', ')}. Defaults to county.` },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200). Raise it to 39 to cover every Washington county.' },
      },
    },
  },
  {
    name: 'wa_dmv_registration_transactions',
    description:
      'Count Washington State vehicle registration transactions — original registrations and renewals processed by the Department of Licensing (Washington DMV) — for one fiscal year or one calendar month, broken down by county of the registered owner, county where the transaction happened, fuel type, use class, or month. Answers "how many vehicle registrations did King County process in fiscal 2026", "monthly registration volume in Washington", "diesel registration transactions by county", and "which Washington counties process the most registrations". Each transaction is an event, so a county with 1.9 million transactions in a year has far fewer vehicles than that; for the size of Washington\'s registered electric fleet use wa_dmv_ev_population.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'County of the registered owner, plain mixed case, e.g. "King", "Pierce", "Spokane".' },
        transaction_county: { type: 'string', description: 'County where the transaction was processed, plain mixed case, e.g. "King". Differs from `county` when an owner registers away from home.' },
        fuel_type: { type: 'string', description: `Fuel; plain words are mapped to the published labels, e.g. "gas" → Gasoline, "flex" → Flex Fuel/Gasoline, "cng" → Compressed Natural Gas. Published labels: ${TXN_FUELS.join(', ')}.` },
        use_class: { type: 'string', description: 'Use class as published, matched as a substring, e.g. "Passenger Car", "Truck", "Trailer", "Motorcycle".' },
        year: { type: 'string', description: `Four-digit state fiscal year from ${EARLIEST_FISCAL_YEAR} onward, e.g. "2026". Defaults to the latest year published.` },
        month: { type: 'string', description: 'A single calendar month as YYYY-MM, e.g. "2026-05". Takes precedence over `year`.' },
        group_by: { type: 'string', description: `Breakdown dimension: ${Object.keys(TXN_GROUPS).join(', ')}. Defaults to county.` },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200). Raise it to 39 to cover every Washington county.' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

interface EvStats {
  n?: string;
  avg_range?: string;
  max_range?: string;
}

async function evPopulation(args: Record<string, unknown>): Promise<unknown> {
  const groupKey = (govString(args, 'group_by') ?? 'county').toLowerCase();
  const col = EV_GROUPS[groupKey];
  if (!col) {
    return govNotFound(
      'unsupported_group_by',
      `Washington EV data supports group_by of ${Object.keys(EV_GROUPS).join(', ')}. Retry with group_by="county".`,
      { supported_group_by: Object.keys(EV_GROUPS) },
    );
  }

  const clauses: string[] = [];
  const county = govString(args, 'county');
  if (county) clauses.push(`upper(county)='${soqlEscape(county.toUpperCase())}'`);
  const city = govString(args, 'city');
  if (city) clauses.push(`upper(city)='${soqlEscape(city.toUpperCase())}'`);
  const zip = govString(args, 'zip');
  if (zip) clauses.push(`zip_code='${soqlEscape(zip)}'`);
  const make = govString(args, 'make');
  if (make) clauses.push(`upper(make) like '%${soqlEscape(make.toUpperCase())}%'`);
  const model = govString(args, 'model');
  if (model) clauses.push(`upper(model) like '%${soqlEscape(model.toUpperCase())}%'`);
  const modelYear = govString(args, 'model_year');
  if (modelYear) clauses.push(`model_year='${soqlEscape(modelYear)}'`);
  const evType = mapEvType(govString(args, 'ev_type'));
  if (evType) clauses.push(`ev_type='${soqlEscape(evType)}'`);
  const district = govString(args, 'legislative_district');
  if (district) clauses.push(`legislative_district='${soqlEscape(district)}'`);

  const where = clauses.length ? clauses.join(' AND ') : undefined;
  const limit = govLimit(args.limit, 25, 200);
  const applied = { county, city, zip, make, model, model_year: modelYear, ev_type: evType, legislative_district: district };

  const [rows, totals, typeRows] = await Promise.all([
    soqlRows<{ grouped?: string; n?: string; avg_range?: string }>(
      DOMAIN,
      EV_RESOURCE,
      {
        select: `${col} as grouped, count(1) as n, avg(electric_range) as avg_range`,
        where,
        group: col,
        order: 'count(1) DESC',
        limit,
      },
      { userAgent: UA },
    ),
    // Full scope total, independent of `limit`, so a truncated row list can never be
    // mistaken for the fleet size.
    soqlRows<EvStats>(
      DOMAIN,
      EV_RESOURCE,
      { select: 'count(1) as n, avg(electric_range) as avg_range, max(electric_range) as max_range', where },
      { userAgent: UA },
    ).catch(() => [] as EvStats[]),
    soqlRows<{ ev_type?: string; n?: string }>(
      DOMAIN,
      EV_RESOURCE,
      { select: 'ev_type, count(1) as n', where, group: 'ev_type', order: 'count(1) DESC' },
      { userAgent: UA },
    ).catch(() => [] as Array<{ ev_type?: string; n?: string }>),
  ]);

  if (!rows.length) {
    return govNotFound(
      'no_matching_records',
      'No Washington electric vehicles matched those filters. Counties and cities are plain mixed case ("King", "Seattle") while makes and models are upper case ("TESLA", "MODEL 3"); dropping `model` or `model_year` usually recovers rows.',
      { filters_applied: applied },
    );
  }

  const scopeTotal = govNumber(totals[0]?.n);
  const returned = rows.reduce((a, r) => a + (govNumber(r.n) ?? 0), 0);
  const truncated = rows.length >= limit;
  const bev = govNumber(typeRows.find((t) => t.ev_type === BEV_LABEL)?.n);
  const phev = govNumber(typeRows.find((t) => t.ev_type === PHEV_LABEL)?.n);
  const scopeLabel = [county ? `${county} County` : null, city, zip ? `ZIP ${zip}` : null]
    .filter(Boolean).join(', ') || 'all of Washington State';

  return {
    state: 'WA',
    grain: `count of registered electric vehicles by ${groupKey} for ${scopeLabel} (VIN-level fleet snapshot)`,
    as_of: await soqlUpdatedAt(DOMAIN, EV_RESOURCE, { userAgent: UA }),
    source: 'data.wa.gov — Washington State Department of Licensing (DOL) Electric Vehicle Population Data (f6w7-q2d2)',
    ...(scopeTotal !== null ? { total_electric_vehicles: scopeTotal } : {}),
    ...(bev !== null ? { battery_electric_vehicles: bev } : {}),
    ...(phev !== null ? { plug_in_hybrid_vehicles: phev } : {}),
    average_electric_range_miles: avgMiles(totals[0]?.avg_range),
    sum_of_returned_rows: returned,
    truncated,
    rows: rows.map((r) => ({
      [groupKey]: r.grouped ?? null,
      electric_vehicles: govNumber(r.n),
      average_electric_range_miles: avgMiles(r.avg_range),
    })),
    note:
      'One row per registered vehicle, so these are counts of the vehicles on the road today rather than sales or registration transactions. ' +
      'Roughly two-thirds of rows carry electric_range 0 because the state has not researched that VIN\'s battery, which drags the average range down. ' +
      'total_electric_vehicles counts the whole scope; sum_of_returned_rows covers only the rows returned here.',
  };
}

/**
 * These are registration TRANSACTIONS per month, not fleet size. King County alone runs
 * ~160,000 a month, so an unscoped sum over the whole file returns 17.6M for that county —
 * arithmetically correct and completely misleading. Every query is therefore pinned to one
 * fiscal year (the latest by default) or one calendar month.
 */
async function registrationTransactions(args: Record<string, unknown>): Promise<unknown> {
  const groupKey = (govString(args, 'group_by') ?? 'county').toLowerCase();
  const col = TXN_GROUPS[groupKey];
  if (!col) {
    return govNotFound(
      'unsupported_group_by',
      `Washington registration transactions support group_by of ${Object.keys(TXN_GROUPS).join(', ')}. Retry with group_by="county".`,
      { supported_group_by: Object.keys(TXN_GROUPS) },
    );
  }

  const clauses: string[] = [];
  const county = govString(args, 'county');
  if (county) clauses.push(`upper(registered_owner_county)='${soqlEscape(county.toUpperCase())}'`);
  const txnCounty = govString(args, 'transaction_county');
  if (txnCounty) clauses.push(`upper(transaction_county_name)='${soqlEscape(txnCounty.toUpperCase())}'`);
  const fuel = mapTxnFuel(govString(args, 'fuel_type'));
  if (fuel) clauses.push(`fuel_type='${soqlEscape(fuel)}'`);
  const useClass = govString(args, 'use_class');
  if (useClass) clauses.push(`upper(use_class) like '%${soqlEscape(useClass.toUpperCase())}%'`);

  const month = govString(args, 'month');
  let period: string;
  let periodKind: 'month' | 'fiscal_year';
  if (month) {
    const ym = month.replace('/', '-').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      return govNotFound(
        'unparsable_month',
        'Pass `month` as YYYY-MM, e.g. month="2026-05". Omit it to get a whole state fiscal year instead.',
        { requested_month: month },
      );
    }
    clauses.push(`date_trunc_ym(month)='${soqlEscape(ym)}'`);
    period = ym;
    periodKind = 'month';
  } else {
    const requested = govString(args, 'year');
    const latest = requested ?? (await soqlMax(DOMAIN, TXN_RESOURCE, 'fiscal_year', { userAgent: UA }));
    if (!latest || !/^\d{4}$/.test(latest) || Number(latest) < EARLIEST_FISCAL_YEAR) {
      return govNotFound(
        'year_unavailable',
        `Washington publishes state fiscal years from ${EARLIEST_FISCAL_YEAR} onward. Retry with year="2026", or pass month="2026-05" for a single month.`,
        { requested_year: requested ?? null, earliest_fiscal_year: String(EARLIEST_FISCAL_YEAR) },
      );
    }
    clauses.push(`fiscal_year='${soqlEscape(latest)}'`);
    period = `fiscal year ${latest}`;
    periodKind = 'fiscal_year';
  }

  const where = clauses.join(' AND ');
  const limit = govLimit(args.limit, 25, 200);
  const [rows, totals] = await Promise.all([
    soqlRows<{ grouped?: string; n?: string }>(
      DOMAIN,
      TXN_RESOURCE,
      {
        select: `${col} as grouped, sum(number_of_registrations) as n`,
        where,
        group: col,
        // A month series reads as a time series, so keep it chronological; every other
        // dimension is a ranking and belongs in descending order.
        order: groupKey === 'month' ? 'month ASC' : 'sum(number_of_registrations) DESC',
        limit,
      },
      { userAgent: UA },
    ),
    soqlRows<{ n?: string }>(
      DOMAIN,
      TXN_RESOURCE,
      { select: 'sum(number_of_registrations) as n', where },
      { userAgent: UA },
    ).catch(() => [] as Array<{ n?: string }>),
  ]);

  if (!rows.length) {
    return govNotFound(
      'no_matching_records',
      `No Washington registration transactions matched those filters for ${period}. Counties are plain mixed case ("King", "Pierce"), \`year\` is a four-digit fiscal year from ${EARLIEST_FISCAL_YEAR} onward, and \`month\` is YYYY-MM.`,
      { filters_applied: { county, transaction_county: txnCounty, fuel_type: fuel, use_class: useClass, period } },
    );
  }

  const scopeTotal = govNumber(totals[0]?.n);
  const returned = rows.reduce((a, r) => a + (govNumber(r.n) ?? 0), 0);
  const truncated = rows.length >= limit;
  const label = periodKind === 'month' ? `month ${period}` : period;

  return {
    state: 'WA',
    period: period,
    period_type: periodKind,
    grain: `vehicle registration transactions during ${label}, by ${groupKey}`,
    as_of: await soqlUpdatedAt(DOMAIN, TXN_RESOURCE, { userAgent: UA }),
    source: 'data.wa.gov — Washington State Department of Licensing (DOL) Vehicle Registration Transactions by County (hmzg-s6q4)',
    ...(scopeTotal !== null ? { total_transactions_in_period: scopeTotal } : {}),
    sum_of_returned_rows: returned,
    truncated,
    rows: rows.map((r) => ({
      // The `month` column stores the last day of the month; report the YYYY-MM the
      // `month` argument accepts rather than a date that reads as a deadline.
      [groupKey]: groupKey === 'month' && typeof r.grouped === 'string' ? r.grouped.slice(0, 7) : (r.grouped ?? null),
      transactions: govNumber(r.n),
    })),
    note:
      `These are registration transactions — new registrations and renewals — processed during ${label}, so a vehicle renewed once a year appears once a year and a county's yearly figure exceeds the number of vehicles it has. ` +
      'For the size of the registered electric fleet in Washington use wa_dmv_ev_population, which reads the VIN-level snapshot. ' +
      'Washington state fiscal years run July 1 to June 30, so fiscal 2026 covers July 2025 through June 2026.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'wa_dmv_ev_population': return await evPopulation(args);
      case 'wa_dmv_registration_transactions': return await registrationTransactions(args);
      default:
        return govNotFound('unknown_tool', `wa-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `wa-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.wa.gov timed out. Retry once, and add a `county` filter or lower `limit` to reduce the work upstream.'
        : 'data.wa.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new Socrata id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
