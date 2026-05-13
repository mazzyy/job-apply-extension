"""Job-search analytics: funnels, response rates, gap aggregation."""
import json
from collections import Counter
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..database import get_db
from ..models import Application, ApplicationEvent, CV

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _ack_events_for(db: Session, app_id: int) -> list:
    return (
        db.query(ApplicationEvent)
        .filter(ApplicationEvent.application_id == app_id)
        .order_by(ApplicationEvent.created_at.asc())
        .all()
    )


@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    rows = db.query(Application).all()
    total = len(rows)

    by_status = Counter(a.status or "analyzed" for a in rows)
    by_source = Counter(a.source or "other" for a in rows)

    # Funnel
    funnel = {
        "analyzed": total,
        "applied": sum(1 for a in rows if (a.status or "") in {"applied", "interview", "offer", "rejected"}),
        "interview": sum(1 for a in rows if (a.status or "") in {"interview", "offer"}),
        "offer": sum(1 for a in rows if (a.status or "") == "offer"),
    }

    # Response rate = (interview + offer) / applied
    applied = funnel["applied"] or 1
    response_rate = round(100 * (funnel["interview"]) / applied, 1) if applied else 0.0
    offer_rate = round(100 * funnel["offer"] / applied, 1) if applied else 0.0

    # Avg fit by outcome
    fits = {"all": [], "interview": [], "rejected": [], "offer": []}
    for a in rows:
        if a.fit_score is None: continue
        fits["all"].append(a.fit_score)
        if a.status in fits:
            fits[a.status].append(a.fit_score)
    avg = lambda L: round(sum(L)/len(L), 1) if L else 0.0
    avg_fit = {k: avg(v) for k, v in fits.items()}

    # Time-to-first-response: applied → first email_received|interview_scheduled|rejected
    times = []
    for a in rows:
        events = _ack_events_for(db, a.id)
        applied_at = next((e.created_at for e in events if e.kind in ("applied", "autofilled")), a.created_at)
        first_resp = next(
            (e.created_at for e in events if e.kind in ("email_received", "interview_scheduled", "rejected", "offered") and e.created_at > applied_at),
            None,
        )
        if first_resp:
            times.append((first_resp - applied_at).total_seconds() / 86400.0)
    response_times = {
        "count": len(times),
        "avg_days": round(sum(times)/len(times), 1) if times else 0,
        "median_days": round(sorted(times)[len(times)//2], 1) if times else 0,
        "fastest_days": round(min(times), 1) if times else 0,
        "slowest_days": round(max(times), 1) if times else 0,
    }

    # Gap frequency across analyses
    gap_counter = Counter()
    for a in rows:
        try:
            gaps = json.loads(a.gaps or "[]")
            for g in gaps:
                key = (g or "").strip().lower()
                # collapse very long gap sentences to first 6 words
                short = " ".join(key.split()[:6])
                if short:
                    gap_counter[short] += 1
        except Exception:
            continue
    top_gaps = [{"gap": k, "count": v} for k, v in gap_counter.most_common(10)]

    # CV performance: rows grouped by CV, callback rate
    cv_perf = {}
    for a in rows:
        if not a.cv_id: continue
        d = cv_perf.setdefault(a.cv_id, {"used": 0, "applied": 0, "interview": 0, "offer": 0, "fit_sum": 0, "fit_n": 0})
        d["used"] += 1
        if a.status in {"applied", "interview", "offer", "rejected"}: d["applied"] += 1
        if a.status in {"interview", "offer"}: d["interview"] += 1
        if a.status == "offer": d["offer"] += 1
        if a.fit_score is not None:
            d["fit_sum"] += a.fit_score; d["fit_n"] += 1
    cv_labels = {c.id: c.label for c in db.query(CV).all()}
    cv_performance = []
    for cv_id, d in cv_perf.items():
        cv_performance.append({
            "cv_id": cv_id, "cv_label": cv_labels.get(cv_id, f"CV #{cv_id}"),
            "used": d["used"],
            "interview_rate": round(100 * d["interview"] / max(d["applied"], 1), 1),
            "offer_rate": round(100 * d["offer"] / max(d["applied"], 1), 1),
            "avg_fit": round(d["fit_sum"] / d["fit_n"], 1) if d["fit_n"] else 0,
        })
    cv_performance.sort(key=lambda x: x["interview_rate"], reverse=True)

    # Source effectiveness
    source_perf = {}
    for a in rows:
        s = a.source or "other"
        d = source_perf.setdefault(s, {"total": 0, "applied": 0, "interview": 0, "offer": 0})
        d["total"] += 1
        if a.status in {"applied", "interview", "offer", "rejected"}: d["applied"] += 1
        if a.status in {"interview", "offer"}: d["interview"] += 1
        if a.status == "offer": d["offer"] += 1
    source_effectiveness = [
        {"source": s, **d,
         "interview_rate": round(100 * d["interview"] / max(d["applied"], 1), 1),
         "offer_rate": round(100 * d["offer"] / max(d["applied"], 1), 1)}
        for s, d in source_perf.items()
    ]
    source_effectiveness.sort(key=lambda x: x["interview_rate"], reverse=True)

    # Language insights
    by_language = Counter()
    non_english_count = 0
    for a in rows:
        if a.requires_other_language:
            non_english_count += 1
            for lang in a.requires_other_language.split(","):
                by_language[lang.strip()] += 1

    # Activity over last 30 days (per day count)
    cutoff = datetime.utcnow() - timedelta(days=30)
    daily = Counter()
    for a in rows:
        if a.created_at and a.created_at >= cutoff:
            d = a.created_at.date().isoformat()
            daily[d] += 1
    daily_activity = [{"date": d, "count": c} for d, c in sorted(daily.items())]

    return {
        "totals": {"total": total, **by_status},
        "funnel": funnel,
        "rates": {"response_rate": response_rate, "offer_rate": offer_rate},
        "avg_fit_by_outcome": avg_fit,
        "response_times_days": response_times,
        "top_gaps": top_gaps,
        "cv_performance": cv_performance,
        "source_effectiveness": source_effectiveness,
        "language_demand": {"non_english_total": non_english_count, "by_language": dict(by_language)},
        "daily_activity": daily_activity,
    }


@router.get("/insights")
def insights(db: Session = Depends(get_db)):
    """Short-form, narrative insights drawn from the overview."""
    o = overview(db)
    notes = []
    rates = o.get("rates", {})
    funnel = o.get("funnel", {})
    if funnel.get("applied", 0) >= 5:
        if rates.get("response_rate", 0) < 10:
            notes.append(f"Your response rate ({rates['response_rate']}%) is below the typical 10–20% — consider tightening which roles you apply to or improving the CV.")
        elif rates.get("response_rate", 0) >= 20:
            notes.append(f"Strong response rate ({rates['response_rate']}%). Whatever you're doing is working.")
    fits = o.get("avg_fit_by_outcome", {})
    if fits.get("interview", 0) and fits.get("rejected", 0):
        if fits["interview"] - fits["rejected"] > 10:
            notes.append(f"You're getting interviews on higher-fit roles (avg {fits['interview']}) and rejected from lower-fit ones (avg {fits['rejected']}) — fit score is predictive for you.")
    top_gap = (o.get("top_gaps") or [{}])[0]
    if top_gap.get("count", 0) >= 5:
        notes.append(f"\"{top_gap['gap']}\" came up as a gap in {top_gap['count']} analyses — strong signal to focus there.")
    best_cv = (o.get("cv_performance") or [{}])[0]
    if best_cv.get("interview_rate", 0) > 0 and len(o.get("cv_performance", [])) > 1:
        notes.append(f"Your {best_cv['cv_label']} CV has the best interview rate ({best_cv['interview_rate']}%).")
    return {"notes": notes, "as_of": datetime.utcnow().isoformat()}
