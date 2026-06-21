"""Automated job discovery — pulls openings from free sources, fit-scores them
against the active CV, and queues the good matches into the apply pipeline.

Sources (no scraping, no paid keys required for the default):
  * Arbeitnow  — free, no auth, strong for Germany (keyword/location filtered locally)
  * Greenhouse — per target company: boards-api.greenhouse.io/v1/boards/{slug}/jobs
  * Lever      — per target company: api.lever.co/v0/postings/{slug}?mode=json
"""
import json
import logging
import re
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from ..models import Application, AppSettings, CV
from .cv_match import score_cv_against_jd

log = logging.getLogger("jaa.discovery")
UA = "Mozilla/5.0 (compatible; JobApplyAssistant/1.0)"
UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_AGG_HOSTS = ("jooble.org", "indeed.com", "glassdoor.", "stepstone.", "talent.com", "neuvoo", "adzuna.", "ziprecruiter.", "google.com/search")


def _is_aggregator(url: str) -> bool:
    low = (url or "").lower()
    return any(h in low for h in _AGG_HOSTS)


def resolve_job_url(url: str):
    """Follow aggregator links (esp. Jooble) to the real employer apply URL.
    Returns (resolved_url, changed). No-op for non-aggregator URLs."""
    if not url or not _is_aggregator(url):
        return url, False
    low = url.lower()
    try:
        with httpx.Client(timeout=12, follow_redirects=True, headers={"User-Agent": UA_BROWSER}) as c:
            target = url
            # Jooble: /desc/<id> is a description page; /away/<id> 302-redirects to the employer.
            if "jooble.org/desc/" in low:
                target = re.sub(r"/desc/", "/away/", url, count=1)
            r = c.get(target)
            final = str(r.url)
            if final and not _is_aggregator(final):
                return final, (final != url)
            # Fallback: scrape an outbound apply link from the page HTML.
            m = re.search(r'href="(https?://[^"]+)"[^>]*(?:class="[^"]*appl|data-[^=]*appl|>\s*appl)', r.text or "", re.I)
            if m and not _is_aggregator(m.group(1)):
                return m.group(1), True
    except Exception as e:
        log.warning("resolve_job_url(%s) failed: %s", url, e)
    return url, False


def _platform_for(url: str) -> str:
    low = (url or "").lower()
    if "greenhouse.io" in low: return "greenhouse"
    if "lever.co" in low: return "lever"
    if "ashbyhq.com" in low: return "ashby"
    if "personio." in low: return "personio"
    if "smartrecruiters.com" in low: return "smartrecruiters"
    if "workable.com" in low: return "workable"
    if "recruitee.com" in low: return "recruitee"
    if "myworkdayjobs.com" in low or "workday" in low: return "workday"
    return "manual"


def _clean(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text or "").replace("&nbsp;", " ").replace("&amp;", "&").strip()


def _parse_date(v):
    """Best-effort parse of a posting date -> epoch seconds (UTC), or None."""
    if v is None:
        return None
    try:
        if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip().isdigit()):
            x = float(v)
            if x > 1e12:           # milliseconds
                x /= 1000.0
            return x
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?", str(v))
        if m:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            hh, mm, ss = int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0)
            return datetime(y, mo, d, hh, mm, ss, tzinfo=timezone.utc).timestamp()
    except Exception:
        return None
    return None


def _age_days(ts):
    if not ts:
        return None
    try:
        return max(0, int((datetime.now(timezone.utc).timestamp() - ts) / 86400))
    except Exception:
        return None


def _first(d, *keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, dict): v = v.get("name") or v.get("displayName") or v.get("label")
        if v: return v
    return None


def _month():
    return datetime.utcnow().strftime("%Y-%m")


DEFAULT_SOURCES = {
    "jooble":   {"enabled": False, "key": "", "limit": 500, "used": 0, "month": ""},
    "rapidapi": {"enabled": False, "key": "", "limit": 100, "used": 0, "month": "", "country": "de"},
}


def load_sources(row) -> dict:
    try:
        saved = json.loads(getattr(row, "discovery_sources", None) or "{}")
    except Exception:
        saved = {}
    out = {}
    for k, d in DEFAULT_SOURCES.items():
        out[k] = {**d, **(saved.get(k) or {})}
    return out


def save_sources(db, row, sources: dict):
    row.discovery_sources = json.dumps(sources)
    db.commit()


def fetch_jooble(key, keywords, location):
    jobs = []
    try:
        with httpx.Client(timeout=15, trust_env=False, headers={"Content-Type": "application/json", "User-Agent": UA}) as c:
            r = c.post(f"https://jooble.org/api/{key}", json={"keywords": keywords or "", "location": location or ""})
            if r.status_code == 200:
                for j in (r.json().get("jobs") or []):
                    jobs.append({
                        "title": j.get("title"), "company": j.get("company"),
                        "url": j.get("link"), "location": j.get("location"),
                        "remote": "remote" in ((j.get("location") or "") + " " + (j.get("type") or "")).lower(),
                        "description": _clean(j.get("snippet"))[:8000], "tags": [], "_searched": True,
                        "posted_at": _parse_date(j.get("updated")),
                    })
    except Exception as e:
        log.warning("jooble fetch failed: %s", e)
    return jobs


def fetch_rapidapi(key, country, keywords, page=1):
    jobs = []
    try:
        params = {"format": "json", "countryCode": (country or "de"), "page": str(page)}
        if keywords:
            params["title"] = keywords
        with httpx.Client(timeout=18, trust_env=False, headers={
            "x-rapidapi-key": key,
            "x-rapidapi-host": "daily-international-job-postings.p.rapidapi.com",
        }) as c:
            r = c.get("https://daily-international-job-postings.p.rapidapi.com/api/v2/jobs/search", params=params)
            if r.status_code == 200:
                data = r.json()
                items = (data.get("result") or data.get("jobs") or data.get("data") or data.get("hits") or data.get("postings")) if isinstance(data, dict) else data
                for j in (items or []):
                    if not isinstance(j, dict):
                        continue
                    jobs.append({
                        "title": _first(j, "title", "jobTitle", "name", "position"),
                        "company": _first(j, "company", "companyName", "employer", "hiringOrganization", "organization"),
                        "url": _first(j, "url", "jobUrl", "link", "applyUrl", "redirect_url", "applicationUrl"),
                        "location": _first(j, "location", "city", "locationName", "country", "region"),
                        "remote": False,
                        "description": _clean(_first(j, "description", "jobDescription", "text", "summary") or "")[:8000],
                        "tags": [], "_searched": True,
                        "posted_at": _parse_date(_first(j, "datePosted", "pubDate", "date", "dateCreated", "created", "postedAt", "publishedAt")),
                    })
    except Exception as e:
        log.warning("rapidapi fetch failed: %s", e)
    return jobs


def fetch_arbeitnow(pages: int = 3) -> list:
    jobs = []
    try:
        with httpx.Client(timeout=12, trust_env=False, headers={"User-Agent": UA}) as c:
            for p in range(1, pages + 1):
                r = c.get("https://www.arbeitnow.com/api/job-board-api", params={"page": p})
                if r.status_code != 200:
                    break
                data = r.json().get("data", [])
                if not data:
                    break
                for j in data:
                    jobs.append({
                        "title": j.get("title"), "company": j.get("company_name"),
                        "url": j.get("url"), "location": j.get("location"),
                        "remote": bool(j.get("remote")),
                        "description": _clean(j.get("description"))[:8000],
                        "tags": j.get("tags") or [],
                        "posted_at": _parse_date(j.get("created_at")),
                    })
    except Exception as e:
        log.warning("arbeitnow fetch failed: %s", e)
    return jobs


def fetch_greenhouse(slug: str) -> list:
    jobs = []
    try:
        with httpx.Client(timeout=12, trust_env=False, headers={"User-Agent": UA}) as c:
            r = c.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs", params={"content": "true"})
            if r.status_code == 200:
                for j in r.json().get("jobs", []):
                    jobs.append({
                        "title": j.get("title"), "company": slug,
                        "url": j.get("absolute_url"),
                        "location": (j.get("location") or {}).get("name"),
                        "remote": False, "description": _clean(j.get("content"))[:8000], "tags": [], "posted_at": _parse_date(j.get("updated_at")),
                    })
    except Exception as e:
        log.warning("greenhouse %s: %s", slug, e)
    return jobs


def fetch_lever(slug: str) -> list:
    jobs = []
    try:
        with httpx.Client(timeout=12, trust_env=False, headers={"User-Agent": UA}) as c:
            r = c.get(f"https://api.lever.co/v0/postings/{slug}", params={"mode": "json"})
            if r.status_code == 200:
                for j in r.json():
                    jobs.append({
                        "title": j.get("text"), "company": slug,
                        "url": j.get("hostedUrl"),
                        "location": (j.get("categories") or {}).get("location"),
                        "remote": False,
                        "description": _clean(j.get("descriptionPlain") or j.get("description"))[:8000],
                        "tags": [],
                        "posted_at": _parse_date(j.get("createdAt")),
                    })
    except Exception as e:
        log.warning("lever %s: %s", slug, e)
    return jobs


def _kw_match(job: dict, keywords: list) -> bool:
    if not keywords:
        return True
    hay = ((job.get("title") or "") + " " + " ".join(job.get("tags") or []) + " " + (job.get("description") or "")[:600]).lower()
    return any(k.strip().lower() in hay for k in keywords if k.strip())


def _loc_match(job: dict, location: str) -> bool:
    if not location:
        return True
    return bool(job.get("remote")) or location.strip().lower() in (job.get("location") or "").lower()


def gather(db: Session, row: AppSettings, stats: dict = None) -> list:
    """Fetch + filter + fit-score (no queueing). Returns ranked job dicts."""
    keywords = [k for k in re.split(r"[,\n]", row.discovery_keywords or "") if k.strip()]
    location = row.discovery_location or ""
    min_fit = row.discovery_min_fit or 0
    max_age = getattr(row, "discovery_max_age_days", 0) or 0
    try:
        companies = json.loads(row.discovery_companies or "[]")
    except Exception:
        companies = []

    jobs = fetch_arbeitnow(pages=3)

    # Keyed APIs with a monthly request budget (server-side keyword search)
    sources = load_sources(row)
    kw_str = ", ".join(keywords)
    m = _month(); changed = False
    jb = sources["jooble"]
    if jb.get("enabled") and jb.get("key"):
        if jb.get("month") != m: jb["used"] = 0; jb["month"] = m; changed = True
        if (jb.get("used") or 0) < (jb.get("limit") or 0):
            jobs += fetch_jooble(jb["key"], kw_str, location); jb["used"] = (jb.get("used") or 0) + 1; changed = True
    rp = sources["rapidapi"]
    if rp.get("enabled") and rp.get("key"):
        if rp.get("month") != m: rp["used"] = 0; rp["month"] = m; changed = True
        if (rp.get("used") or 0) < (rp.get("limit") or 0):
            jobs += fetch_rapidapi(rp["key"], rp.get("country") or "de", kw_str); rp["used"] = (rp.get("used") or 0) + 1; changed = True
    if changed:
        save_sources(db, row, sources)

    for co in companies:
        ats = (co.get("ats") or "").lower().strip()
        slug = (co.get("slug") or "").strip()
        if not slug:
            continue
        if ats == "greenhouse":
            jobs += fetch_greenhouse(slug)
        elif ats == "lever":
            jobs += fetch_lever(slug)

    cv = (db.query(CV).filter(CV.is_active == True).first()  # noqa: E712
          or db.query(CV).order_by(CV.created_at.desc()).first())
    cv_text = (cv.raw_text if cv else "") or ""

    out, seen, old_hidden = [], set(), 0
    for j in jobs:
        url = (j.get("url") or "").split("?")[0].rstrip("/")
        if not url or url in seen:
            continue
        seen.add(url)
        age = _age_days(j.get("posted_at"))
        if max_age and age is not None and age > max_age:
            old_hidden += 1
            continue
        j["age_days"] = age
        if not j.get("_searched") and (not _kw_match(j, keywords) or not _loc_match(j, location)):
            continue
        score = 0
        if cv_text and j.get("description"):
            try:
                score = round(min(100, (score_cv_against_jd(cv_text, j["description"]).get("score", 0) or 0) * 100))
            except Exception:
                score = 0
        if min_fit and score < min_fit:
            continue
        j["fit"] = score
        j["platform"] = _platform_for(j.get("url"))
        out.append(j)
    out.sort(key=lambda x: x.get("fit", 0), reverse=True)
    out = out[:60]
    if stats is not None:
        stats.update({
            "old_hidden": old_hidden,
            "no_date": sum(1 for j in out if j.get("age_days") is None),
            "kept": len(out), "max_age": max_age,
        })
    return out


def discover_and_queue(db: Session) -> dict:
    """Run discovery and queue new matches as external jobs (status queued_manual)."""
    row = db.query(AppSettings).first()
    if not row:
        return {"ok": False, "error": "No settings row"}
    found = gather(db, row)
    queued = 0
    for j in found:
        base = (j.get("url") or "").split("?")[0].rstrip("/")
        if not base:
            continue
        if db.query(Application).filter(Application.url.like(base + "%")).first():
            continue  # already tracked
        a = Application(
            url=j.get("url"), company=j.get("company"), job_title=j.get("title"),
            location=j.get("location"), job_description=j.get("description"),
            fit_score=j.get("fit"), status="queued_manual",
            source="discovery:" + j.get("platform", "manual"),
        )
        db.add(a); db.commit()
        queued += 1
    row.discovery_last_run = datetime.utcnow()
    db.commit()
    return {"ok": True, "found": len(found), "queued": queued}
