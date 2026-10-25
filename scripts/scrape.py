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
MAX_AGE_DAYS = int(os.environ.get("FL_MAX_AGE_DAYS", "30"))
PAGES = int(os.environ.get("FL_PAGES", "6"))  # pages of 50 results per search phrase
MAX_MINUTES = 28
BASE = "https://www.freelancer.com"
NAMELESS_MAX = int(os.environ.get("NAMELESS_MAX", "10"))  # website requests without a buyer name to add per run (0 = names only)
ENRICH_MAX = int(os.environ.get("ENRICH_MAX", "0"))  # how many website requests to look the buyer up for
# With a token the buyer's real profile name is visible, so use it; FL_ALLOW_PROFILE_NAME=0/1 overrides.
_apn = os.environ.get("FL_ALLOW_PROFILE_NAME", "")
ALLOW_PROFILE_NAME = (_apn == "1") if _apn else bool(os.environ.get("FREELANCER_OAUTH_TOKEN", "").strip())

DEFAULT_QUERIES = [
    "need a website", "build a website", "website for my business", "business website",
    "wordpress website", "ecommerce website", "shopify store", "website redesign",
    "landing page", "company website", "portfolio website", "website development",
    "create a website", "design a website", "new website", "website for my company",
    "online store website", "woocommerce website", "wix website", "webflow website",
    "restaurant website", "clinic website", "real estate website", "furniture website",
    "interior design website", "school website", "hotel website", "travel website",
    "small business website", "static website", "responsive website", "website revamp",
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
    r"\b(web\s?site|web\s?page|landing\s?page|wordpress|woocommerce|shopify|wix|webflow|squarespace|"
    r"e-?commerce|online\s+(store|shop)|web\s+(design|development|developer|designer))\b",
    re.I,
)
NOT_ONE_TIME = re.compile(  # ongoing work or agencies outsourcing (checked on title + description)
    r"\b(full[\s-]?time|part[\s-]?time|long[\s-]?term|permanent|ongoing|monthly\s+retainer|white[\s-]?label|"
    r"outsourc\w*|reseller|resell|our\s+agency|my\s+agency|team\s+of\s+(developers|freelancers)|"
    r"looking\s+for\s+(an?\s+)?(agency|partner)|hire\s+(a\s+)?(dedicated|team)|dedicated\s+(developer|team))\b",
    re.I,
)
NOT_WEBSITE = re.compile(  # not a website job (checked on the title only)
    r"\b(seo|backlinks?|logo|video|graphic|mobile\s+app|android|ios|game|plugin|bug\s?fix|fix\s+(my\s+)?(bug|error)|"
    r"web\s?app|saas|crm|erp|software|dashboard|api|chatbot|data\s+entry|translation|writing|article|"
    r"social\s+media|marketing|marketer|onboarding|agents?|sales|telecall\w*|caller|content|ads?|influencer|"
    r"instagram|facebook|youtube|manager|executive|recruit\w*|hiring|virtual\s+assistant|photograph\w*|editor|"
    r"blogs?|posts|cad|cads|apps?|testing|tester|reporting|platform|3d|jewel\w*|design\s+of|"
    r"advertis\w*|commercial|cinematic|reels?|animation|promo\w*)\b",
    re.I,
)


def fetch_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read().decode("utf-8", "replace")


def lookup_owner(seo, debug=False):
    """Find the buyer of a project from its public page: first the owner embedded in the page, else the public user lookup."""
    try:
        html = fetch_text(BASE + "/projects/" + str(seo).lstrip("/"))
    except Exception as e:
        if debug:
            print("  page fetch failed:", str(e)[:120])
        return None
    info = {}
    m = re.search(r'"(?:owner|employer|client)"\s*:\s*\{[^{}]{0,800}?"(?:public_name|display_name|name)"\s*:\s*"([^"]{3,60})"', html)
    if m:
        info["public_name"] = m.group(1)
    oid = re.search(r'"[A-Za-z_]*(?:owner|employer)[A-Za-z_]*"\s*:\s*(\d{5,})', html, re.I)
    if debug:
        print(f"  page {len(html)} bytes | owner block: {bool(m)} | owner id: {oid.group(1) if oid else None}")
        seen = 0
        for mm in re.finditer(r'.{0,70}(?:owner|employer|"username"|/u/[A-Za-z0-9_.-]{3,}).{0,110}', html, re.I):
            sn = re.sub(r"\s+", " ", mm.group(0))
            if "function" in sn or sn.count("{") > 8:
                continue
            print("    ~", sn[:200])
            seen += 1
            if seen >= 8:
                break
    if not info and oid:
        try:
            d = json.loads(fetch_text(f"{BASE}/api/users/0.1/users/{oid.group(1)}/?compact=true"))
            res = d.get("result") or {}
            info = {k: res.get(k) for k in ("public_name", "display_name", "username", "location")}
            if debug:
                print("  user lookup:", {k: v for k, v in info.items() if k != "location"})
        except Exception as e:
            if debug:
                print("  user lookup failed:", str(e)[:120])
    return info or None


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


URL_RE = re.compile(r"(?:https?://)?(?:www\.)?([a-z0-9][a-z0-9-]{1,40}(?:\.[a-z0-9-]{2,})*\.(?:com|in|co\.in|net|org|store|shop|co|biz|info|online|site))\b[^\s]*", re.I)
SKIP_DOMAINS = re.compile(
    r"freelancer|google|goo\.gl|facebook|fb\.|instagram|youtu|linkedin|wordpress|shopify|wix|github|gitlab|twitter|x\.com|whatsapp|wa\.me|"
    r"t\.me|telegram|canva|figma|dropbox|drive\.|docs\.|gmail|yahoo|outlook|example|loom|tinyurl|bit\.ly|bitly|zoom|calendly|"
    r"notion|trello|slack|behance|dribbble|pinterest|medium\.|wetransfer|onedrive|sharepoint|icloud|apple|amazon|flipkart|"
    r"upwork|fiverr|truelancer|envato|themeforest|squarespace|weebly|webflow|godaddy|hostinger|bluehost|vimeo|tiktok|snapchat|"
    r"reddit|quora|wikipedia|screenshot|prnt\.sc|imgur|postimg|ibb\.co|cutt\.ly|rebrand|lnkd|mailchi|typeform|jotform|airtable|miro|"
    r"codepen|codesandbox|replit|vercel|netlify|herokuapp|blogspot|wixsite|myshopify|\.gov|\.edu",
    re.I,
)
NAME_PATTERNS = [
    re.compile(r"(?i:(?:business|company|brand|firm|shop|store|clinic|hotel|restaurant|school|institute|startup)\s+name\s*(?:is|:|-)\s*)[\"'“]?([A-Z][\w&'-]*(?:\s+[A-Z&][\w&'-]*){0,3})"),
    re.compile(r"(?i:(?:we are|i am from|i'm from|i run|i own|we run|my company is|my business is|our company is|our business is|called)\s+)[\"'“]?([A-Z][\w&'-]*(?:\s+[A-Z&][\w&'-]*){0,3})"),
]
GENERIC = re.compile(r"^(a|an|the|i|we|my|our|looking|need|want|freelancer|client|small|new|online|website|business|company|startup|team)\b", re.I)


PHONE_RE = re.compile(r"(?<!\d)(?:\+?91[\s-]?)?0?([6-9]\d{4}[\s-]?\d{5})(?!\d)")


def find_phone(text):
    """An Indian mobile number written in the project text, as +91XXXXXXXXXX (or empty)."""
    m = PHONE_RE.search(text)
    return "+91" + re.sub(r"\D", "", m.group(1)) if m else ""


def find_site(text):
    for m in URL_RE.finditer(text):
        host = m.group(1).lower()
        if not SKIP_DOMAINS.search(host):
            return host
    return ""


def find_business_name(text):
    for rx in NAME_PATTERNS:
        for m in rx.finditer(text):
            n = m.group(1).strip(" .,-'\"")
            if 3 <= len(n) <= 40 and not GENERIC.match(n):
                return n
    return ""


def pretty_domain(host):
    stem = host.split(".")[0].replace("-", " ")
    return stem.title() if stem else ""


def profile_name(u):
    """A real name from the buyer's profile (not a bare username with digits)."""
    for k in ("public_name", "display_name"):
        n = clean((u or {}).get(k))
        if len(n) >= 3 and not re.fullmatch(r"[a-z0-9_.-]+\d+[a-z0-9_.-]*", n.lower()):
            return n
    n = clean((u or {}).get("username"))
    if len(n) >= 5 and not re.search(r"\d", n):
        return n
    return ""


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

    per_day = int(cfg.get("perDay", 50))
    queries = list(cfg.get("terms") or [])
    queries += [q for q in DEFAULT_QUERIES if q.lower() not in {x.lower() for x in queries}]
    session = Session(oauth_token=TOKEN or "public")
    if not TOKEN:  # no token: use the public search endpoint without any login header
        session.session.headers.pop("Freelancer-OAuth-V1", None)
        print("No FREELANCER_OAUTH_TOKEN set: using the public search endpoint (no login).")
    print(f"Target {per_day} leads with a business name | {len(queries)} search phrases | countries {COUNTRIES or 'worldwide'}")

    sent_keys = set()
    seen_projects = set()
    scanned = off_topic = blocked = old = no_name = not_india = 0
    started = time.time()
    cutoff = time.time() - MAX_AGE_DAYS * 86400
    errors = []
    printed_fields = False
    sample_kept, sample_blocked = [], []
    state = {"saved": 0, "full": False, "usedToday": 0, "prefiltered_sent": False, "sent": 0}
    pending = []
    fallback = []  # website requests from India without a business name/phone: used only if a run would otherwise give nothing

    def flush(force=False):
        """Send collected leads to the Lead desk; it saves them and tells us when today's target is reached."""
        while pending and (force or len(pending) >= 10) and not state["full"]:
            batch = pending[:15]
            del pending[:15]
            try:
                res = http("POST", "/api/ingest", {"runId": RUN_ID, "leads": batch, "preFiltered": 0 if state["prefiltered_sent"] else blocked})
            except Exception as e:
                print("Send failed:", e)
                continue
            state["prefiltered_sent"] = True
            state["sent"] += len(batch)
            state["saved"] = res.get("added", state["saved"])
            state["usedToday"] = res.get("usedToday", state["usedToday"])
            state["full"] = bool(res.get("full"))
            print(f"  sent {state['sent']} | saved this run: {state['saved']} | already in your list: {res.get('duplicates', 0)} | agencies: {res.get('skippedAgencies', 0)} | today {state['usedToday']}/{per_day}")

    for q in queries:
        if state["full"] or time.time() - started > MAX_MINUTES * 60:
            break
        for page in range(PAGES):
            if state["full"] or time.time() - started > MAX_MINUTES * 60:
                break
            flt = create_search_projects_filter(
                sort_field="time_updated",
                or_search_query=True,
                countries=COUNTRIES or None,
                project_types=["fixed", "hourly"],
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
                raw = clean(p.get("description") or p.get("preview_description"))
                text = title + " " + raw[:1500]
                if not WANTS_WEB.search(text) or NOT_ONE_TIME.search(text) or NOT_WEBSITE.search(title):
                    off_topic += 1
                    continue
                owner = p.get("owner_id")
                u = users.get(str(owner)) or users.get(owner) or {}
                if not printed_fields:
                    printed_fields = True
                    print("  project fields from Freelancer:", sorted(p.keys())[:30], "| owner_id:", owner, "| users returned:", len(users))
                site = find_site(raw)
                # A business name (written in the post or taken from a website link in it), or else a phone number in the post.
                name = find_business_name(raw) or (pretty_domain(site) if site else "")
                if not name and ALLOW_PROFILE_NAME:
                    name = profile_name(u)
                phone = find_phone(raw)
                if not name and phone:  # a phone number is enough: no business name needed
                    name = "Freelancer buyer %s" % pid
                if not name:
                    no_name += 1
                    fplace = buyer_place(u, p)
                    title_is_site = WANTS_WEB.search(title) or re.search(r"\b(sites?|stores?|shops?)\b", title, re.I)
                    if title_is_site and not (fplace and "india" not in fplace.lower()):
                        fseo = clean(p.get("seo_url"))
                        fallback.append({
                            "name": "", "_seo": fseo, "_pid": str(pid), "city": fplace, "website": site, "phone": "",
                            "jobTitle": title[:120], "source": "freelancer",
                            "jobUrl": (BASE + "/projects/" + fseo) if fseo else (BASE + "/projects/" + str(pid)),
                            "email": "", "_t": p.get("time_submitted") or 0,
                        })
                    continue
                place = buyer_place(u, p)
                if place and "india" not in place.lower():
                    not_india += 1
                    continue
                if BAD_NAME.search(name):
                    blocked += 1
                    if len(sample_blocked) < 8:
                        sample_blocked.append(name)
                    continue
                key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                if key in sent_keys:
                    continue
                sent_keys.add(key)
                if len(sample_kept) < 8:
                    sample_kept.append(name)
                seo = clean(p.get("seo_url"))
                pending.append({
                    "name": name,
                    "city": place,
                    "website": site,
                    "phone": phone,
                    "jobTitle": title[:120],
                    "source": "freelancer",
                    "jobUrl": (BASE + "/projects/" + seo) if seo else (BASE + "/projects/" + str(pid)),
                    "email": "",
                    "_score": (3 if phone else 0) + (2 if site else 0) + (1 if find_business_name(raw) else 0),
                })
            time.sleep(0.5)
            if len(projects) < 50:
                break
        print(f"'{q}': {len(sent_keys)} named buyers found so far")
    # Send the best first: a phone number, then a website, then a business name written in the post.
    pending.sort(key=lambda l: -l["_score"])
    for l in pending:
        l.pop("_score", None)
    flush(force=True)

    # Still short of today's target: look up WHO posted each remaining website request (public project page, then
    # the public user lookup). Only buyers with a real name become leads; nameless ones are never saved.
    fallback.sort(key=lambda l: -l["_t"])
    looked = named = 0
    for l in fallback:
        if state["full"] or time.time() - started > MAX_MINUTES * 60 or looked >= ENRICH_MAX:
            break
        looked += 1
        info = lookup_owner(l["_seo"] or l["_pid"], looked <= 2)
        nm = profile_name(info) if info else ""
        if not nm or BAD_NAME.search(nm):
            continue
        place = buyer_place(info, {})
        if place and "india" not in place.lower():
            continue
        key = re.sub(r"[^a-z0-9]+", "-", nm.lower()).strip("-")
        if key in sent_keys:
            continue
        sent_keys.add(key)
        named += 1
        l["name"] = nm
        l["city"] = place or l["city"]
        for k in ("_t", "_seo", "_pid"):
            l.pop(k, None)
        pending.append(l)
        flush(force=True)
    flush(force=True)
    print(f"Looked up {looked} more website requests for the buyer's name: {named} had a usable real name.")

    # Nothing (or little) new with a name: add the newest Indian website requests whose buyer name Freelancer hides.
    # They are named after the request itself, e.g. "Wants: Business Website Development Needed".
    if NAMELESS_MAX > 0:
        fb = sorted([l for l in fallback if not l.get("name")], key=lambda l: -l.get("_t", 0))[:NAMELESS_MAX]
        batch = []
        for l in fb:
            pid = l.pop("_pid", "")
            l.pop("_seo", None); l.pop("_t", None)
            l["name"] = ("%s #%s" % (l["jobTitle"][:60].strip(), pid[-5:])).strip()
            batch.append(l)
        if batch:
            try:
                res = http("POST", "/api/ingest", {"runId": RUN_ID, "leads": batch, "preFiltered": 0})
                state["saved"] = res.get("added", state["saved"])
                print(f"  website requests without a buyer name: sent {len(batch)} | saved this run: {state['saved']} | already in your list: {res.get('duplicates', 0)}")
            except Exception as e:
                print("Send failed:", e)

    print(f"Scanned {scanned} projects: {old} too old, {off_topic} not a website request, "
          f"{no_name} with no business name, {not_india} not in India, {blocked} blocked by name")
    if sample_blocked:
        print("  sample blocked names:", sample_blocked)
    if sample_kept:
        print("  sample kept names:", sample_kept)
    print(f"Found {len(sent_keys)} qualifying buyers in total, sent {state['sent']} to the Lead desk")
    if sent_keys == set() and not state["sent"]:
        try:
            http("POST", "/api/ingest", {"runId": RUN_ID, "leads": [], "preFiltered": blocked})
        except Exception as e:
            print("Send failed:", e)
    if not state["full"]:
        print(f"Searched everything available and found {state['usedToday']} of {per_day} for today.")
    if scanned == 0:
        print("WARNING: 0 projects came back. If errors mention 401/403/forbidden, Freelancer needs a token for this call; add FREELANCER_OAUTH_TOKEN. Otherwise check FL_COUNTRIES.", errors[:2])
    print("Done. Leads saved:", state["saved"])
    if scanned == 0 and errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
