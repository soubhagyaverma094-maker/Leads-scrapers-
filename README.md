# Leads-scrapers (website leads)

Same Lead desk as `Leads-scraper-`, retargeted at **website leads** instead of digital marketing leads.

A GitHub Action (`scripts/scrape.py`, python-jobspy) finds businesses hiring web developers, web designers, WordPress/Shopify developers or e-commerce staff on Indeed, Naukri and LinkedIn. A business hiring for these roles needs a website. Agencies, software and staffing companies are removed, then Google Places is used only to find each business's phone number and website (leads with no website are tagged "No website" on the dashboard). Voice calling, call log, hot/warm/cold grading and auto-call work exactly as in the original.

What differs from the digital marketing version:

- Default job titles in `lib/core.js` (`DEFAULT_SETTINGS.terms`), editable later in the dashboard Settings tab
- Call variables sent to Rasen/Vapi: `service_needed` is "Website design and development", `job_title` falls back to "a web role"
- Call grading prompt describes a website design and development service

Setup is the same as the original: see `.env.example`, add the Vercel env vars, and set the repo secrets `APP_URL` and `INGEST_SECRET` for the workflow in `.github/workflows/daily-leads.yml`.
