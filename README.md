# @pipeworx/wa-dmv

Washington State DMV MCP — the Department of Licensing's VIN-level electric-vehicle population and its monthly vehicle-registration transaction counts. Keyless.

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

Or connect to the full Pipeworx gateway for access to all 1392+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Washington DMV (Dept of Licensing) data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
