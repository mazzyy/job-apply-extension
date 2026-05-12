"""Fast, dependency-free CV ↔ JD scorer.
Picks the best of N uploaded CVs without burning an LLM call.
"""
import re
from collections import Counter

# Common-English filler — words we don't want to count as meaningful matches
STOPWORDS = set("""
a an the and or but if of in on at to for with by from is are was were be been being
this that these those it its as our your you we they i me my his her him she he them
will can could should would may might must do does did done has have had not no nor
about above below up down over under out into onto off again further then once here
there when where why how all any both each few more most other some such only own same
so than too very s t just now per via etc role roles job jobs position positions
about responsibilities requirements work working experience experiences year years
company team teams who what where which while you'll well good great
""".split())

# Boost tech-y tokens that often define fit
TECH_HINTS = set("""
python java javascript typescript go golang rust ruby php scala kotlin swift c c++ csharp
react vue angular nextjs nuxt svelte node nodejs express fastapi django flask spring rails
aws azure gcp kubernetes k8s docker terraform ansible jenkins gitlab github actions argocd
postgres mysql mongodb redis kafka rabbitmq elasticsearch grafana prometheus datadog
ml ai llm pytorch tensorflow huggingface langchain rag etl airflow spark hadoop
devops sre platform backend frontend fullstack mobile ios android security cloud
graphql rest soap microservices serverless lambda eks aks gke ec2 s3 rds iam
ci cd tdd bdd agile scrum mlops dataops
""".split())


def tokenize(text: str) -> Counter:
    text = (text or "").lower()
    tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9+#./-]{1,29}", text)
    return Counter(t for t in tokens if t not in STOPWORDS and len(t) > 1)


def score_cv_against_jd(cv_text: str, jd_text: str) -> dict:
    jd = tokenize(jd_text)
    cv = tokenize(cv_text)
    if not jd or not cv:
        return {"score": 0.0, "overlap": [], "missing": []}
    overlap = []
    weighted = 0.0
    total_weight = 0.0
    for term, jd_count in jd.items():
        if jd_count < 1:
            continue
        weight = jd_count * (3.0 if term in TECH_HINTS else 1.0)
        total_weight += weight
        if term in cv:
            weighted += weight
            overlap.append(term)
    score = (weighted / total_weight) * 100 if total_weight else 0
    # Missing tech terms — most informative for the picker
    missing = sorted({t for t in jd if t in TECH_HINTS and t not in cv})
    return {
        "score": round(score, 1),
        "overlap": sorted(set(overlap))[:30],
        "missing": missing[:15],
    }


def pick_best_cv(cvs: list, jd_text: str) -> tuple:
    """Returns (best_cv_obj, list_of_(cv_id, score, overlap_count))."""
    scored = []
    for cv in cvs:
        s = score_cv_against_jd(cv.raw_text or "", jd_text)
        scored.append({
            "cv_id": cv.id, "label": cv.label, "tag": cv.tag,
            "score": s["score"], "overlap_count": len(s["overlap"]),
        })
    scored.sort(key=lambda x: x["score"], reverse=True)
    if not scored:
        return None, []
    best_id = scored[0]["cv_id"]
    best = next((c for c in cvs if c.id == best_id), None)
    return best, scored
