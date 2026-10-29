# @pipeworx/wa-dmv

Washington State DMV MCP — the Department of Licensing's VIN-level electric-vehicle population and its monthly vehicle-registration transaction counts. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

Washington has no agency called "the DMV": vehicle registration and driver licensing are run by the **Department of Licensing (DOL)**. Both names appear in the tool descriptions because agents search for "WA DMV".

## Tools

| Tool | What it returns |
|------|-----------------|
| `wa_dmv_ev_population(...)` | Counts of registered electric vehicles by county, city, ZIP, make, model, model year, legislative district, electric utility or drivetrain, with BEV/PHEV split and average electric range. A true fleet snapshot — one source row per registered vehicle. |
| `wa_dmv_registration_transactions(...)` | Registration transactions (new registrations and renewals) for one fiscal year or one calendar month, by owner county, transaction county, fuel type, use class or month. |

## Auth

Keyless. Both datasets are public Socrata resources on `data.wa.gov`; no app token is required at the volumes this pack issues.

## Per-state gotchas

- **`hmzg-s6q4` counts transactions, not vehicles.** This is the trap in this state. King County processes roughly 160,000 registration transactions a month, so summing every month back to fiscal 2017 returns 17.6M for one county — arithmetically correct and completely misleading. `wa_dmv_registration_transactions` therefore pins every query to one fiscal year (the latest by default) or one calendar month, and labels the result "registration transactions during \<period\>". For the size of a registered fleet, use `wa_dmv_ev_population`.
- **Washington fiscal years run July 1 – June 30.** Fiscal 2026 covers July 2025 through June 2026. Data starts at fiscal 2017.
- **The `month` column stores the last day of the month.** Filter it with `date_trunc_ym`, which the `month` argument (`YYYY-MM`) does for you; results are reported back as `YYYY-MM`.
- **Case differs by column.** Counties and cities are plain mixed case (`King`, `Seattle`); makes and models are upper case (`TESLA`, `MODEL 3`).
- **Roughly two-thirds of EV rows carry `electric_range` 0.** 188,456 of 289,564 vehicles sit in the "Eligibility unknown as battery range has not been researched" CAFV bucket with a literal zero range, which drags any average down. The genuinely researched vehicles average ~133 miles. Treat `average_electric_range_miles` as a floor, not a spec.
- **Socrata reports an all-zero average as the string `"0E-24"`.** The shared `govNumber` helper strips exponent notation into NaN, so this pack parses averages with its own `avgMiles`.
- **`ev_type` has exactly two values**, spelled in full: `Battery Electric Vehicle (BEV)` and `Plug-in Hybrid Electric Vehicle (PHEV)`. The `ev_type` argument accepts `BEV` / `PHEV` / plain phrases.
- **`sum_of_returned_rows` is not a total.** Row lists are cut off by `limit`; `total_electric_vehicles` and `total_transactions_in_period` are separate full counts over the same filters and are the figures to quote.

## Data sources

- EV population — https://data.wa.gov/resource/f6w7-q2d2.json (Electric Vehicle Population Data)
- Registration transactions — https://data.wa.gov/resource/hmzg-s6q4.json (Vehicle Registration Transactions by County)

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "wa-dmv": {
      "url": "https://gateway.pipeworx.io/wa-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/wa-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/wa_dmv_ev_population \
  -H 'Content-Type: application/json' \
  -d '{"county":"King","group_by":"make","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/wa_dmv_ev_population`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-wa-dmv` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/wa-dmv/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "wa-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-wa-dmv"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Wa Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
