# Leads-scrapers (website leads)

Same Lead desk as `Leads-scraper-`, retargeted at **website leads** instead of digital marketing leads.

A GitHub Action (`scripts/scrape.py`) uses the official [Freelancer.com Python SDK](https://github.com/freelancer/freelancer-sdk-python) to find people and businesses that **posted a project on Freelancer.com asking for a website**. Projects that look like ongoing hiring, agency outsourcing, or non-website work (logo, video, SEO, apps) are skipped, and agencies are removed by name. Each lead links to its Freelancer project post. Freelancer does not give out phone numbers, so you add each phone number by hand on the dashboard. Voice calling, call log, hot/warm/cold grading and auto-call work exactly as in the original.

Extra repo secret for the scraper: `FREELANCER_OAUTH_TOKEN` (token from developer.freelancer.com). Optional env vars on the workflow step: `FL_COUNTRIES` (default `in`, comma separated codes, empty = worldwide), `FL_MAX_AGE_DAYS` (default 14), `FL_PAGES` (default 3).

What differs from the digital marketing version:

- Default Freelancer.com search phrases in `lib/core.js` (`DEFAULT_SETTINGS.terms`), editable later in the dashboard Settings tab
- Call variables sent to Rasen/Vapi: `service_needed` is "Website design and development", `job_title` falls back to "a web role"
- Call grading prompt describes a website design and development service

Setup is the same as the original: see `.env.example`, add the Vercel env vars, and set the repo secrets `APP_URL` and `INGEST_SECRET` for the workflow in `.github/workflows/daily-leads.yml`.
