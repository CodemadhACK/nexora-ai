"""
Programmatic shape checks for an answer.

These are the half of grading that needs no model: whether a greeting came back
with headings, whether a coding answer opened with the clarifying questions,
whether a follow-ups section crept back into the body. Every one of them
corresponds to a failure that was actually observed and then fixed, so they are
regression guards rather than style preferences.

Deterministic and free, which is the point: the judge score wobbles at this
sample size, this does not.
"""

import re

# "### Heading" at the start of a line is the only heading shape the prompts ask
# for, so anything else is already a deviation worth seeing.
HEADING_RE = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
FENCE_RE = re.compile(r"^```", re.MULTILINE)
FOLLOWUP_RE = re.compile(r"^###\s+.*follow-?ups", re.IGNORECASE | re.MULTILINE)


def headings(text):
    """Every '### ' heading in order, so first/forbidden checks agree on one list."""
    return [m.group(1).strip() for m in HEADING_RE.finditer(text or "")]


def run_checks(text, spec):
    """
    Apply one case's `checks` block.

    Returns (score, failures) where score is the fraction of checks that passed.
    A fraction rather than a bool because "three of four" and "none of four" are
    different problems, and collapsing them hides which one you have.
    """
    text = text or ""
    found = headings(text)
    results = []          # (name, passed, detail)

    def record(name, passed, detail=""):
        results.append((name, bool(passed), detail))

    if "max_headings" in spec:
        limit = spec["max_headings"]
        record(
            f"at most {limit} headings",
            len(found) <= limit,
            f"found {len(found)}: {found[:4]}",
        )

    if "max_chars" in spec:
        limit = spec["max_chars"]
        record(f"at most {limit} chars", len(text) <= limit, f"{len(text)} chars")

    if "first_heading" in spec:
        want = spec["first_heading"]
        got = found[0] if found else "(none)"
        record(f"opens with '{want}'", got.lower() == want.lower(), f"opened with '{got}'")

    if "forbid_heading" in spec:
        banned = spec["forbid_heading"].lower()
        hit = [h for h in found if h.lower() == banned]
        record(f"no '{spec['forbid_heading']}' section", not hit, f"found {hit}")

    if "must_contain_headings" in spec:
        lowered = [h.lower() for h in found]
        for want in spec["must_contain_headings"]:
            record(f"has '{want}'", want.lower() in lowered, f"headings: {found}")

    if "must_have_code_block" in spec and spec["must_have_code_block"]:
        # An even number of fences would also match a stray fence, so require a
        # pair at minimum - an answer with one fence is malformed either way.
        record("has a code block", len(FENCE_RE.findall(text)) >= 2)

    if "no_followup_section" in spec and spec["no_followup_section"]:
        hit = FOLLOWUP_RE.search(text)
        record(
            "no follow-ups section",
            hit is None,
            f"found '{hit.group(0).strip()}'" if hit else "",
        )

    if "must_match" in spec:
        record("matches expected pattern", re.search(spec["must_match"], text) is not None)

    if "must_not_match" in spec:
        hit = re.search(spec["must_not_match"], text)
        record("avoids forbidden pattern", hit is None, f"matched '{hit.group(0)}'" if hit else "")

    if not results:
        return 1.0, []

    passed = sum(1 for _, ok, _ in results if ok)
    failures = [f"{name} ({detail})" if detail else name for name, ok, detail in results if not ok]
    return passed / len(results), failures


def word_error_rate(reference, hypothesis):
    """
    Levenshtein distance over words, divided by the reference length.

    Standard WER. Punctuation and case are stripped first: an interviewer's
    question transcribed without a comma is not an error worth counting, and
    counting it would drown the errors that matter.
    """
    def norm(s):
        return re.sub(r"[^a-z0-9' ]+", " ", (s or "").lower()).split()

    ref, hyp = norm(reference), norm(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0

    # Single-row DP: the full matrix is never needed and this stays readable.
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        cur = [i]
        for j, h in enumerate(hyp, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)
