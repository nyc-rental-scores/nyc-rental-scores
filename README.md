# NYC Rental Scores

New York City rental listings, each graded A–F on its building's public record:

| Grade | What's counted (per apartment) | City dataset |
|---|---|---|
| Violations | Housing-code violations in the past 3 years, serious ones weighted more | HPD Violations |
| Bedbugs | Share of apartments owners reported infested, past 3 years | HPD Bedbug Reporting |
| Evictions | Marshal-executed residential evictions, past 3 years | NYC Marshal Evictions |
| Complaints | Tenant complaints to HPD, past 2 years | HPD Complaints and Problems |
| Landlord record | HPD housing-court cases, past 5 years (harassment ×3); city's distressed-buildings program | HPD Housing Litigations, AEP |

Grades compare each building with the 170,000+ NYC buildings that have 3 or more apartments:
A = best 40%, B = next 25%, C = next 20%, D = next 10%, F = worst 5%.

**Live site:** https://nyc-rental-scores.github.io/nyc-rental-scores/
**Setup steps:** see [SETUP.md](SETUP.md).

## How it fits together

```
StreetEasy / Craigslist / Zillow alert emails
        │  (Gmail)
        ▼
apps-script/ListingAlerts.gs  ── every 15 min ──▶  Google Sheet "Listings" (published as CSV)
                                                          │
GitHub Actions, hourly: scripts/update-listings.mjs ◀─────┘
   • finds each address (NYC GeoSearch → tax lot BBL)
   • grades each building (scoring/grades.js, NYC Open Data)
   • writes site/data/*.json and publishes site/ to GitHub Pages

GitHub Actions, monthly: scripts/calibrate.mjs → scoring/thresholds.json (A–F cutoffs)
```

The site shows each listing's address, price and size with a link back to the original listing. It never copies listing photos or descriptions.

## Files

- `scoring/grades.js`: the grading engine, shared by the website and the scripts
- `scoring/thresholds.json`: citywide A–F cutoffs, recalculated monthly
- `scripts/update-listings.mjs`: the hourly refresh
- `scripts/calibrate.mjs`: the monthly cutoff calculation
- `apps-script/ListingAlerts.gs`: reads alert emails into the Google Sheet
- `site/`: the website
- `data/manual-listings.csv`: optional; add listings by hand (columns: address, unit, price, beds, baths, neighborhood, url, received)
