"""
Finds people and businesses that have POSTED a project on Freelancer.com asking for a
website (one-time build), using the official Freelancer.com Python SDK
(https://github.com/freelancer/freelancer-sdk-python), and sends them to your Lead desk
(/api/ingest). Each lead links to the project post. You add the phone number by hand.

FREELANCER_OAUTH_TOKEN (from developer.freelancer.com) is optional. Without it the script
calls the public, no-login search endpoint of the same API; with it, requests are authenticated.
"""
import json
import os
import random
import re
import sys
import time
import urllib.request

from freelancersdk.session import Session
from freelancersdk.resources.projects.projects import search_projects
from freelancersdk.resources.projects.exceptions import ProjectsNotFoundException
from freelancersdk.resources.projects.helpers import (
    create_search_projects_filter,
    create_get_projects_user_details_object,
)

APP = os.environ["APP_URL"].rstrip("/")
KEY = os.environ["INGEST_SECRET"]
TOKEN = os.environ.get("FREELANCER_OAUTH_TOKEN", "").strip()
RUN_ID = "run_" + os.environ.get("RUN_ID", str(int(time.time())))
# Buyer country codes to keep (Freelancer uses lowercase codes). Empty = worldwide.
COUNTRIES = [c.strip().lower() for c in os.environ.get("FL_COUNTRIES", "in").split(",") if c.strip()]
MAX_AGE_DAYS = int(os.environ.get("FL_MAX_AGE_DAYS", "14"))
PAGES = int(os.environ.get("FL_PAGES", "3"))  # pages of 50 results per search phrase
MAX_MINUTES = 20
BASE = "https://www.freelancer.com"

DEFAULT_QUERIES = [
    "need a website", "build a website", "website for my business", "business website",
    "wordpress website", "ecommerce website", "shopify store", "website redesign",
    "landing page", "company website", "portfolio website", "website development",
]

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


# The project must be asking for a website / web build...
WANTS_WEB = re.compile(
    r"\b(web\s?site|web\s?page|web\s?app|landing\s?page|wordpress|woocommerce|shopify|wix|webflow|squarespace|"
    r"e-?commerce|online\s+(store|shop)|web\s+(design|development|developer)|html|php|laravel|react|next\.?js)\b",
    re.I,
)
# ...and not an ongoing engagement, an agency outsourcing work, or something that is not a website.
NOT_ONE_TIME = re.compile(
    r"\b(full[\s-]?time|part[\s-]?time|long[\s-]?term|permanent|ongoing|monthly\s+retainer|white[\s-]?label|"
    r"outsourc\w*|reseller|resell|our\s+agency|my\s+agency|team\s+of\s+(developers|freelancers)|"
    r"looking\s+for\s+(an?\s+)?(agency|partner)|hire\s+(a\s+)?(dedicated|team)|dedicated\s+(developer|team)|"
    r"seo|backlinks?|logo|video|graphic|mobile\s+app|android|ios|game|wordpress\s+plugin|bug\s?fix|fix\s+(my\s+)?(bug|error))\b",
    re.I,
)


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


def buyer_name(u, owner_id):
    for k in ("public_name", "display_name", "username"):
        n = clean((u or {}).get(k))
        if n:
            return n
    return "Freelancer client %s" % owner_id


def buyer_place(u, proj):
    loc = (u or {}).get("location") or proj.get("location") or {}
    city = clean(loc.get("city"))
    country = clean((loc.get("country") or {}).get("name"))
    return ", ".join(x for x in (city, country) if x)


def main():
    try:
        cfg = http("GET", "/api/config")
    except Exception as e:
        print("Could not read settings from the app:", e)
        sys.exit(1)

    per_day = int(cfg.get("perDay", 100))
    queries = cfg.get("terms") or DEFAULT_QUERIES
    session = Session(oauth_token=TOKEN or "public")
    if not TOKEN:  # no token: use the public search endpoint without any login header
        session.session.headers.pop("Freelancer-OAuth-V1", None)
        print("No FREELANCER_OAUTH_TOKEN set: using the public search endpoint (no login).")
    print(f"Target {per_day} leads | {len(queries)} search phrases | countries {COUNTRIES or 'worldwide'}")

    queries = list(queries)
    random.shuffle(queries)
    found = {}  # buyer slug -> lead
    seen_projects = set()
    scanned = off_topic = blocked = old = 0
    started = time.time()
    cutoff = time.time() - MAX_AGE_DAYS * 86400
    want = per_day * 2
    errors = []
    sample_kept, sample_blocked = [], []

    for q in queries:
        if len(found) >= want or time.time() - started > MAX_MINUTES * 60:
            break
        for page in range(PAGES):
            flt = create_search_projects_filter(
                sort_field="time_updated",
                or_search_query=True,
                countries=COUNTRIES or None,
                project_types=["fixed"],
            )
            try:
                res = search_projects(
                    session,
                    query=q,
                    search_filter=flt,
                    project_details={"full_description": True},
                    user_details=create_get_projects_user_details_object(basic=True, location=True),
                    limit=50,
                    offset=page * 50,
                    active_only=True,
                )
            except ProjectsNotFoundException as e:
                errors.append(str(getattr(e, "message", e)))
                print(f"  search failed for '{q}': {errors[-1][:150]}")
                break
            except Exception as e:
                errors.append(str(e))
                print(f"  search error for '{q}': {str(e)[:150]}")
                break
            projects = (res or {}).get("projects") or []
            users = (res or {}).get("users") or {}
            if not projects:
                break
            for p in projects:
                pid = p.get("id")
                if pid in seen_projects:
                    continue
                seen_projects.add(pid)
                scanned += 1
                if (p.get("time_submitted") or 0) < cutoff:
                    old += 1
                    continue
                title = clean(p.get("title"))
                text = title + " " + clean(p.get("description") or p.get("preview_description"))[:1500]
                if not WANTS_WEB.search(title + " " + text) or NOT_ONE_TIME.search(text):
                    off_topic += 1
                    continue
                owner = p.get("owner_id")
                u = users.get(str(owner)) or users.get(owner) or {}
                name = buyer_name(u, owner)
                if BAD_NAME.search(name):
                    blocked += 1
                    if len(sample_blocked) < 8:
                        sample_blocked.append(name)
                    continue
                key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                if key in found:
                    continue
                if len(sample_kept) < 8:
                    sample_kept.append(name)
                seo = clean(p.get("seo_url"))
                found[key] = {
                    "name": name,
                    "city": buyer_place(u, p),
                    "jobTitle": title[:120],
                    "source": "freelancer",
                    "jobUrl": (BASE + "/projects/" + seo) if seo else (BASE + "/projects/" + str(pid)),
                    "email": "",
                }
            time.sleep(0.5)
            if len(projects) < 50:
                break
        print(f"'{q}': {len(found)} buyers so far")

    leads = list(found.values())
    random.shuffle(leads)
    print(f"Scanned {scanned} projects: {old} too old, {off_topic} not a one-time website request, {blocked} blocked by name")
    if sample_blocked:
        print("  sample blocked names:", sample_blocked)
    if sample_kept:
        print("  sample kept names:", sample_kept)
    print(f"Collected {len(leads)} buyers")
    if scanned == 0:
        print("WARNING: 0 projects came back. If errors mention 401/403/forbidden, Freelancer needs a token for this call; add FREELANCER_OAUTH_TOKEN. Otherwise check FL_COUNTRIES.", errors[:2])

    added = 0
    for i in range(0, len(leads), 15):
        batch = leads[i : i + 15]
        try:
            res = http("POST", "/api/ingest", {"runId": RUN_ID, "leads": batch, "preFiltered": blocked if i == 0 else 0})
        except Exception as e:
            print("Send failed:", e)
            continue
        added = res.get("added", added)
        print(f"Sent {i + len(batch)}/{len(leads)} | saved so far: {added}")
        if res.get("full"):
            break

    if not leads:
        http("POST", "/api/ingest", {"runId": RUN_ID, "leads": [], "preFiltered": blocked})
    print("Done. Leads saved:", added)
    if scanned == 0 and errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
