"""
Second lead source: companies that posted a WEBSITE job on Indeed, Naukri and LinkedIn (free python-jobspy library).
Every lead comes with the company's real business name. Agencies / IT firms are removed by name, only website-type
job titles are kept, and the companies are sent to the Lead desk (/api/ingest).
"""
import json
import os
import random
import re
import sys
import time
import urllib.request

from jobspy import scrape_jobs

APP = os.environ["APP_URL"].rstrip("/")
KEY = os.environ["INGEST_SECRET"]
RUN_ID = "jobs_" + os.environ.get("RUN_ID", str(int(time.time())))
SITES = [x.strip() for x in os.environ.get("SITES", "indeed,linkedin").split(",") if x.strip()]
COUNTRY = os.environ.get("COUNTRY", "India")
MAX_MINUTES = 8

# Only companies whose NAME contains one of these words/phrases are removed.
# Matching is case-insensitive and whole-word, so "AI" blocks "AI Labs" but not "Rai Salon",
# and "X" blocks "Hotel X" but not "Maxwell Clinic".
BLOCK_WORDS = [
    "Technologies", "Solutions", "Systems", "Digital", "Innovations", "Enterprises", "Networks",
    "Consulting", "Services", "Tech", "Labs", "AI", "AI Labs", "Automations", "Robotics",
    "Intelligence", "Software", "Digital Labs", "Techworks", "Media", "Creative", "Studios",
    "Marketing", "Interactive", "Agency", "Designs", "Productions", "Communications", "Growth",
    "Web", "Webworks", "Web Solutions", "Web Technologies", "Web Studio", "Webcraft",
    "Digital Works", "Codeworks", "DevLabs", "Web Systems", "Ventures", "Global", "Group",
    "Works", "Collective", "Dynamics", "Nexus", "Sphere", "Forge", "Edge", "Orbit", "X", "One",
    "AI Solutions", "Automation Labs", "AI Systems", "Intelligent Systems", "Agentic AI",
    "AI Works", "Neural", "Autopilot", "Intelligence Labs", "AI Innovations", "Co.", "HQ", "IO",
    "OS", "Hub", "Flow", "Stack", "Sync", "Base", "Cloud", "Grid",
]
BAD_NAME = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    + "|".join(re.escape(w).replace(r"\ ", r"\s+") for w in sorted(BLOCK_WORDS, key=len, reverse=True))
    + r")(?![A-Za-z0-9])",
    re.I,
)


JOB_TITLES = [
    "website developer", "website designer", "wordpress developer", "shopify developer",
    "ecommerce website developer", "web designer", "freelance website developer", "web developer",
]
WEB_TITLE = re.compile(r"\b(web|website|websites|wordpress|woocommerce|shopify|wix|webflow|magento|e-?commerce)\b", re.I)
NOT_WEB_TITLE = re.compile(
    r"\b(graphic|video|editor|seo|marketing|sales|software\s+engineer|java|python|data|android|ios|mobile|"
    r"intern|trainee|manager|executive|telecaller|content|social\s+media|full[\s-]?stack|devops)\b", re.I)


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        APP + path,
        data=data,
        method=method,
        headers={"content-type": "application/json", "x-ingest-key": KEY, "user-agent": "leaddesk-action"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"{}")


def clean(v):
    if v is None or (isinstance(v, float) and v != v):
        return ""
    return str(v).strip()


def slug(x):
    return re.sub(r"[^a-z0-9]+", "-", x.lower()).strip("-")


def main():
    try:
        cfg = http("GET", "/api/config")
    except Exception as e:  # keep going with defaults if the app is unreachable
        print("Could not read settings from the app:", e)
        sys.exit(1)

    per_day = int(cfg.get("perDay", 50))
    cities = cfg.get("cities") or ["Raipur"]
    terms = JOB_TITLES
    print(f"Target {per_day} leads | {len(cities)} cities | {len(terms)} job titles | sites {SITES}")

    combos = [(t, c) for t in terms for c in cities]
    random.shuffle(combos)

    found = {}  # company slug -> lead
    sent = set()
    state = {"added": 0, "full": False, "pre": 0}

    def send(force=False):
        """Send companies as soon as there are a few, so nothing is lost if the run is stopped."""
        todo = [k for k in found if k not in sent]
        while todo and (force or len(todo) >= 8) and not state["full"]:
            keys, todo = todo[:15], todo[15:]
            try:
                res = http("POST", "/api/ingest", {"runId": RUN_ID, "leads": [found[k] for k in keys], "preFiltered": 0 if state["pre"] else prefiltered})
            except Exception as e:
                print("Send failed:", e)
                return
            state["pre"] = 1
            sent.update(keys)
            state["added"] = res.get("added", state["added"])
            state["full"] = bool(res.get("full"))
            print(f"  sent {len(sent)} | saved so far: {state['added']}")

    blocked = {}  # company slug -> name (unique companies removed by the name filter)
    raw_rows = 0
    rows_by_site = {s: 0 for s in SITES}
    prefiltered = 0
    started = time.time()
    want = per_day  # stop searching once enough companies were found

    for term, city in combos:
        if len(found) >= want or time.time() - started > MAX_MINUTES * 60:
            break
        for site in SITES:
            try:
                df = scrape_jobs(
                    site_name=[site],
                    search_term=term,
                    location=f"{city}, {COUNTRY}",
                    results_wanted=15,
                    hours_old=24 * 7,
                    country_indeed=COUNTRY,
                )
            except Exception as e:
                print(f"  {site} failed for '{term}' in {city}: {str(e)[:100]}")
                continue
            if df is None or len(df) == 0:
                continue
            rows = df.to_dict("records")
            raw_rows += len(rows)
            rows_by_site[site] = rows_by_site.get(site, 0) + len(rows)
            for row in rows:
                name = clean(row.get("company"))
                title = clean(row.get("title"))
                if not name or not WEB_TITLE.search(title) or NOT_WEB_TITLE.search(title):
                    continue
                key = slug(name)
                if key in found or key in blocked:
                    continue
                if BAD_NAME.search(name):
                    blocked[key] = name
                    prefiltered = len(blocked)
                    continue
                found[key] = {
                    "name": name,
                    "city": city,
                    "jobTitle": clean(row.get("title")),
                    "source": site,
                    "jobUrl": clean(row.get("job_url")),
                    "email": clean(row.get("emails")).split(",")[0].strip(),
                }
            time.sleep(1)
        print(f"{term} / {city}: {len(found)} companies so far")
        send()

    leads = list(found.values())
    print(f"Job posts scanned: {raw_rows} {rows_by_site}")
    print(f"Collected {len(leads)} companies, {prefiltered} blocked by name filter before sending")
    if blocked:
        print("  Sample BLOCKED names:", " | ".join(list(blocked.values())[:25]))
    if leads:
        print("  Sample KEPT names:", " | ".join(l["name"] for l in leads[:25]))
    if raw_rows == 0:
        print("  WARNING: the job sites returned 0 posts. They may be blocking GitHub's servers, or the job titles/cities in Settings are wrong.")

    send(force=True)
    if not found:
        http("POST", "/api/ingest", {"runId": RUN_ID, "leads": [], "preFiltered": prefiltered})
    added = state["added"]
    print("Done. Leads saved:", added)


if __name__ == "__main__":
    main()
