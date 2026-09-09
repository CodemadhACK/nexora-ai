#!/usr/bin/env python3
"""
Builds a large eval set across the ground this interview will actually cover:
agentic AI and RAG, data engineering, and general SDE.

Generating cases costs nothing; running them costs money and time, which is why
this is a separate script. Write the set once, then decide how much of it to
run - `run_eval.py --cases evals/cases.generated.json --limit N`.

The twelve hand-written cases in cases.json stay the important ones: each is a
failure that was actually observed. These are breadth on top of that - they
catch a regression that only shows up on, say, streaming questions, which a
twelve-case set would never sample.

Every case carries the same programmatic checks as its hand-written kin, so the
shape metric is exact regardless of set size. The judge is what costs money, and
`--limit` is how you control that.
"""

import argparse
import json
import random
from pathlib import Path

# --- the ground to cover ---------------------------------------------------

TOPICS = {
    "rag": [
        "chunking strategy for long documents", "chunk overlap", "embedding model choice",
        "FAISS vs pgvector", "hybrid search with BM25", "reranking with a cross-encoder",
        "retrieval evaluation", "hallucination from weak retrieval", "context window budgeting",
        "metadata filtering", "multi-tenant vector stores", "embedding drift on reindex",
        "chunk boundaries across tables", "citation of retrieved sources",
        "recall versus precision in retrieval", "query rewriting before retrieval",
        "caching embeddings", "cost of reindexing a large corpus", "semantic versus keyword search",
        "handling PDFs with poor text layers",
    ],
    "agentic": [
        "tool calling and schema design", "planning versus reactive loops", "agent memory",
        "multi-agent handoff", "guardrails on tool use", "retry policy for a failed tool call",
        "observability of an agent run", "bounding agent cost per task", "prompt injection through tool output",
        "when an agent should ask rather than act", "evaluating an agent end to end",
        "parallel tool calls", "long-running agent state", "human approval gates",
        "structured output from a model", "streaming a long agent response",
        "context compaction in a long session", "choosing model size per sub-task",
        "idempotency of agent side effects", "detecting an agent loop",
    ],
    "data": [
        "batch versus streaming", "partitioning a large table", "idempotent pipeline writes",
        "backfilling a year of history", "slowly changing dimensions", "data quality checks",
        "Airflow DAG design", "late-arriving data", "schema evolution", "deduplication at scale",
        "SQL query that got slow", "SSIS package migration", "incremental versus full load",
        "watermarks in a streaming job", "skew in a distributed join", "columnar versus row storage",
        "reconciliation between two systems", "CDC from a transactional database",
        "retry semantics in an ETL job", "cost of a daily full refresh",
    ],
    "sde": [
        "hash map versus sorted array", "two pointers on a sorted array", "sliding window maximum",
        "binary search on the answer", "topological sort", "cycle detection in a graph",
        "least recently used cache", "merge intervals", "kth largest element",
        "detecting a duplicate in place", "string tokenising", "recursion versus iteration",
        "thread safety of a shared counter", "connection pool exhaustion", "retry with backoff",
        "pagination of a large result set", "rate limiting an API", "immutability and defensive copies",
        "time complexity of a nested loop", "memory profile of a large list",
    ],
}

# --- how each kind is asked, and how it is checked -------------------------

TEMPLATES = {
    # Several phrasings per kind because an interviewer's wording varies and the
    # router reads the wording. A regression that only fires on "walk me through"
    # is invisible to a set that only ever says "explain".
    "conceptual": [
        "What is {t} and why does it matter?",
        "Explain {t} to me.",
        "How would you describe {t}?",
        "What are the tradeoffs around {t}?",
        "Why does {t} cause problems in production?",
        "Walk me through {t}.",
        "When would you not use {t}?",
        "How would you explain {t} to a junior engineer?",
    ],
    "coding": [
        "Write code for {t} and give the complexity.",
        "Implement {t}. Walk me through the complexity.",
        "Show me how you would code {t}.",
        "Can you code up {t} for me?",
        "Write a function for {t} and tell me the time and space cost.",
        "Let us do a quick coding one: {t}.",
    ],
    "system-design": [
        "Design a system that handles {t} at scale.",
        "How would you architect {t} for a hundred million records?",
        "We need to build {t} for a few thousand requests a second. How would you lay it out?",
        "Take me through the design for {t}.",
        "How would you build {t} so it survives a region going down?",
    ],
    # A debugging question needs a symptom. Slotting a bare topic into "what is
    # wrong with X" produces something no interviewer would ask, and the model
    # rightly answers it by asking for the error - which then scores as a format
    # failure that is really a bad case.
    "debugging": [
        "Our job handling {t} started showing {e} in production last night. What is wrong and how do I fix it?",
        "Since we changed {t}, we started seeing {e} on about one run in ten. Where do I start?",
        "We are getting {e} in the part of the system that does {t}. What would you check?",
        "{t} was fine for months, then we started seeing {e}. How would you debug that?",
        "A customer reported {e} and it traces back to {t}. Walk me through fixing it.",
    ],
}

# Behavioural questions have no topic - they have a theme. They earn their own
# list because the format is different from every other kind: words the
# candidate reads aloud, no delivery coaching.
BEHAVIOURAL_THEMES = [
    "a project that went wrong",
    "a disagreement with a colleague over a technical decision",
    "a deadline you were not going to make",
    "a time you had to learn something quickly",
    "a piece of feedback that was hard to hear",
    "a time you pushed back on a requirement",
    "an outage you were on the hook for",
    "a decision you made without enough information",
    "a time you had to say no to a stakeholder",
    "work you are proudest of",
    "a mistake that reached production",
    "a time you had to hand your work to someone else",
    "convincing a team to adopt something new",
    "a time you were the least experienced person in the room",
]

BEHAVIOURAL_TEMPLATES = [
    "Tell me about {t}.",
    "Give me an example of {t}.",
    "Walk me through {t} and what you did about it.",
    "Can you describe {t}?",
    "I would like to hear about {t}.",
]

CHECKS = {
    "conceptual": {
        "first_heading": "Interview explanation",
        "forbid_heading": "Ask first",
        "must_contain_headings": ["Answer", "From your experience"],
        "no_followup_section": True,
    },
    "coding": {
        "first_heading": "Ask first",
        "must_contain_headings": ["Code", "Complexity", "From your experience"],
        "must_have_code_block": True,
        "no_followup_section": True,
    },
    "system-design": {
        "first_heading": "Ask first",
        "must_contain_headings": ["Requirements", "Scaling", "From your experience"],
        "no_followup_section": True,
    },
    "debugging": {
        "first_heading": "Ask first",
        "must_contain_headings": ["Why this happens", "Fix", "From your experience"],
        "no_followup_section": True,
    },
    "behavioural": {
        "first_heading": "Say this",
        # The delivery-coaching regression: the person is already talking, so
        # telling them to speak for two minutes is noise on top of the answer.
        "must_not_match": "(?i)(speak for about|two minutes|avoid finger-pointing|what to emphasi[sz]e|avoid blaming)",
        "no_followup_section": True,
    },
}

RUBRICS = {
    "conceptual": ("A direct, technically correct explanation of {t}, with the tradeoff named rather "
                   "than hinted at. It must answer rather than ask. The closing section must ground it "
                   "in the candidate's real profile or say plainly that nothing there relates - an "
                   "invented project is a total failure."),
    "coding": ("Correctness first: the code must run as written and the stated complexity must be right "
               "for {t}. A fluent explanation of a wrong solution is a failure. The closing section must "
               "come from the profile or admit it does not."),
    "system-design": ("Scopes before designing, states the numbers it assumes for {t}, and its scaling "
                      "story follows from those numbers. Components named with no traffic estimate behind "
                      "them is a weak answer."),
    "debugging": ("Names the actual cause behind {t} rather than restating the symptom, and the fix is a "
                  "real one rather than a workaround that hides it."),
    "behavioural": ("Opens with words the candidate can read aloud: a specific first-person story about "
                    "{t}, in the past tense, with what they owned and how it ended. Generic advice with "
                    "no story is a failure, and so is delivery coaching - the person is already speaking."),
}

# Real symptoms, so a debugging case reads like something someone actually hit.
# Phrased as noun clauses that follow "we started seeing", so any symptom reads
# correctly after any template.
SYMPTOMS = [
    "a RecursionError after about 40k rows",
    "OOM-killed workers",
    "a 30x slowdown with no code change",
    "duplicate rows downstream",
    "intermittent 429s from the provider",
    "a deadlock between two writers",
    "silently truncated output",
    "connection pool exhaustion",
    "empty results for a third of queries",
    "a KeyError on a field that used to exist",
]

CHATTER = [
    "hello", "hi there", "can you hear me", "okay", "right, so", "sounds good",
    "and then the the uh when we", "so basically what I mean is uh",
    "let's start whenever you're ready", "we'll go through your resume, sound good?",
    "give me one second", "sorry, can you say that again",
]


def build(seed, target):
    rng = random.Random(seed)
    cases, seen = [], set()

    for kind, templates in TEMPLATES.items():
        for area, topics in TOPICS.items():
            for topic in topics:
                for template in templates:
                    prompt = template.format(t=topic, e=rng.choice(SYMPTOMS))
                    if prompt in seen:
                        continue
                    seen.add(prompt)
                    cases.append({
                        "id": f"{area}-{kind}-{len(cases):04d}",
                        "tags": [kind, area, "generated"],
                        "prompt": prompt,
                        "checks": dict(CHECKS[kind]),
                        "rubric": RUBRICS[kind].format(t=topic),
                    })

    for theme in BEHAVIOURAL_THEMES:
        for template in BEHAVIOURAL_TEMPLATES:
            prompt = template.format(t=theme)
            if prompt in seen:
                continue
            seen.add(prompt)
            cases.append({
                "id": f"behavioural-{len(cases):04d}",
                "tags": ["behavioural", "generated"],
                "prompt": prompt,
                "checks": dict(CHECKS["behavioural"]),
                "rubric": RUBRICS["behavioural"].format(t=theme),
            })

    for i, line in enumerate(CHATTER):
        cases.append({
            "id": f"chat-generated-{i:04d}",
            "tags": ["chat", "generated"],
            "prompt": line,
            "checks": {"max_headings": 0, "max_chars": 700},
            "rubric": ("Speech that is not a technical question. One or two sentences, no headings, "
                       "no template. If it is an interviewer setting the scene, a good answer names "
                       "something concrete from the profile to start on rather than saying it is ready."),
        })

    rng.shuffle(cases)
    return cases[:target]


def main():
    ap = argparse.ArgumentParser(description="Generate eval cases across the interview's ground")
    ap.add_argument("--count", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7, help="fixed, so the set is reproducible")
    ap.add_argument("--out", default="evals/cases.generated.json")
    args = ap.parse_args()

    cases = build(args.seed, args.count)
    Path(args.out).write_text(json.dumps({
        "_comment": [
            "Generated by evals/generate_cases.py - do not hand-edit, regenerate.",
            "Breadth across RAG, agentic AI, data engineering and SDE. The hand-written",
            "cases in cases.json remain the ones that matter most: each of those is a",
            "failure that was actually seen in use.",
        ],
        "cases": cases,
    }, indent=1) + "\n", encoding="utf-8")

    by_kind = {}
    for c in cases:
        by_kind[c["tags"][0]] = by_kind.get(c["tags"][0], 0) + 1
    print(f"{len(cases)} cases -> {args.out}")
    for kind, n in sorted(by_kind.items(), key=lambda kv: -kv[1]):
        print(f"  {kind:<14} {n}")


if __name__ == "__main__":
    main()
