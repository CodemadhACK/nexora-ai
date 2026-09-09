#!/usr/bin/env python3
"""
Runs the answer-quality eval and writes a report you can act on.

What it measures, per case:
  answer  - a judge model's 0-1 score against that case's rubric  (headline)
  shape   - the fraction of programmatic checks the answer passed
  wer     - word error rate of the transcription, on spoken cases only

Why three numbers rather than one: a regression in shape and a regression in
substance need different fixes, and a spoken case that scores badly could be a
bad answer or a bad transcript. Collapsing them would hide which.

The answer and the judge both go through evals/bridge.js, which runs the app's
own prompts.js and providers/ under Electron. Nothing here re-implements the
prompt - an eval that tests a copy passes while the app is broken.

Usage:
    python evals/run_eval.py --approve-harness      # first run only
    python evals/run_eval.py                        # full pass
    python evals/run_eval.py --limit 3              # cheap pilot
"""

import argparse
import hashlib
import json
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from checks import run_checks, word_error_rate  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
EVALS = REPO / "evals"
FLOW = REPO / ".claude" / "hillclimb" / "answer-quality"
ELECTRON = REPO / "node_modules" / "electron" / "dist" / "electron.exe"

# A different vendor from the model under test, so the judge has no stake in the
# phrasing it is grading. The same-family alternatives were tried first and are
# all rate-limited, 503-ing, or not on this key: gemini-3.8-flash and 3.7-flash
# both fail under load, and 2.5-flash is not available at all.
JUDGE_PROVIDER = "openai"
JUDGE_MODEL = "gpt-4.1-mini"

MODEL_UNDER_TEST = "gemini-3.5-flash-lite"
PROVIDER_UNDER_TEST = "gemini"


# ---------------------------------------------------------------------------
# Harness integrity
# ---------------------------------------------------------------------------

def harness_sha():
    """A digest over the files that decide what the number means."""
    h = hashlib.sha256()
    for rel in ["evals/run_eval.py", "evals/checks.py", "evals/bridge.js", "evals/cases.json"]:
        h.update((REPO / rel).read_bytes())
    return h.hexdigest()[:16]


def check_harness(state_path, approve):
    """
    Refuses to run when the harness changed under a set of results.

    Comparing round 3 against a baseline measured by different code is the
    quiet way an eval starts lying. Re-approval is the user's call, never mine.
    """
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    recorded = state.get("harness_sha")
    current = harness_sha()

    if approve or recorded is None:
        return current, True
    if recorded != current:
        print(
            f"harness changed since these results were recorded\n"
            f"  recorded: {recorded}\n  current:  {current}\n"
            f"Re-run with --approve-harness once you are happy the change is intended.",
            file=sys.stderr,
        )
        return current, False
    return current, True


# ---------------------------------------------------------------------------
# Audio fixtures
# ---------------------------------------------------------------------------

def synth_wav(text, path):
    """
    Speaks a case with Windows TTS so the transcription path gets real audio.

    Cleaner than a real interviewer through your speakers, so the WER here is
    optimistic. It catches regressions in the transcription path; it does not
    predict accuracy in a live call.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.SetOutputToWaveFile('{path}'); "
        f"$s.Speak('{text.replace(chr(39), chr(39) * 2)}'); "
        "$s.Dispose()"
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        check=True, capture_output=True, timeout=120,
    )
    return path


# ---------------------------------------------------------------------------
# The bridge
# ---------------------------------------------------------------------------

def run_bridge(jobs, tag, timeout_s, concurrency=1, pace_ms=4000):
    """
    Hands a batch to Electron and reads back one result per line.

    Results are keyed, not ordered: a batch that dies half way still yields the
    jobs that finished, which is what makes resume cheap.
    """
    if not jobs:
        return {}

    work = FLOW / "_work"
    work.mkdir(parents=True, exist_ok=True)
    jobs_file, out_file = work / f"{tag}.in.jsonl", work / f"{tag}.out.jsonl"
    jobs_file.write_text("\n".join(json.dumps(j) for j in jobs), encoding="utf-8")
    out_file.unlink(missing_ok=True)

    env_free = {"ELECTRON_RUN_AS_NODE": None}  # documented; cleared below
    import os
    env = {k: v for k, v in os.environ.items() if k not in env_free}

    try:
        subprocess.run(
            [str(ELECTRON), str(EVALS / "bridge.js"),
             "--jobs", str(jobs_file), "--out", str(out_file),
             "--concurrency", str(concurrency), "--pace-ms", str(pace_ms)],
            check=False, capture_output=True, timeout=timeout_s, env=env, cwd=str(REPO),
        )
    except subprocess.TimeoutExpired:
        print(f"  batch '{tag}' hit the {timeout_s}s ceiling; keeping whatever landed", file=sys.stderr)

    results = {}
    if out_file.exists():
        for line in out_file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                results[row["key"]] = row
    return results


def with_retries(jobs, tag, timeout_s, attempts=3, concurrency=1, pace_ms=4000):
    """
    Re-runs only what failed, backing off with jitter.

    A zero-delay retry loop turns one rate-limit into a torn-down batch and an
    invisible multiple of the bill, so the wait is real and the count is kept.
    """
    done, tries = {}, {}
    pending = list(jobs)
    for attempt in range(1, attempts + 1):
        got = run_bridge(pending, f"{tag}-a{attempt}", timeout_s, concurrency, pace_ms)
        still = []
        for job in pending:
            row = got.get(job["key"])
            tries[job["key"]] = attempt
            if row and row.get("ok"):
                done[job["key"]] = row
            else:
                still.append(job)
                if row:
                    done[job["key"]] = row       # keep the last error for the sidecar
        pending = still
        if not pending or attempt == attempts:
            break
        wait = min(30, 2 ** attempt) + random.uniform(0, 1.5)
        print(f"  {len(pending)} failed; retrying in {wait:.1f}s", file=sys.stderr)
        time.sleep(wait)
    return done, tries


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------

JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_judge(text):
    """Models mostly return the JSON they were asked for. Mostly is not a contract."""
    if not text:
        return None, "judge returned nothing"
    match = JSON_RE.search(text)
    if not match:
        return None, f"judge returned no JSON: {text[:80]}"
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError as err:
        return None, f"judge JSON did not parse: {err}"
    score = obj.get("score")
    if not isinstance(score, (int, float)):
        return None, f"judge gave no numeric score: {obj}"
    return max(0.0, min(1.0, float(score))), str(obj.get("reason", "")).strip()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Answer-quality eval for Nexora")
    ap.add_argument("--variant", default="baseline", help="baseline, v1, v2 ...")
    ap.add_argument("--model", default=MODEL_UNDER_TEST)
    ap.add_argument("--provider", default=PROVIDER_UNDER_TEST,
                    help="provider for the model under test; must match --model")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--timeout-s", type=int, default=300, help="per batch wall clock ceiling")
    ap.add_argument("--limit", type=int, default=0, help="first N cases only, for a pilot")
    ap.add_argument("--judge", default=f"{JUDGE_PROVIDER}:{JUDGE_MODEL}",
                    help="provider:model to grade answers, or none for shape checks only")
    ap.add_argument("--cases", default="evals/cases.json",
                    help="case file; the generated set is evals/cases.generated.json")
    ap.add_argument("--concurrency", type=int, default=1)
    ap.add_argument("--pace-ms", type=int, default=4000,
                    help="gap between calls; the free tier is rated per minute")
    ap.add_argument("--approve-harness", action="store_true")
    args = ap.parse_args()

    if not ELECTRON.exists():
        sys.exit(f"electron not found at {ELECTRON} - run npm install")

    out_dir = FLOW / args.variant
    (out_dir / "traces").mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"
    errors_path = out_dir / "errors.jsonl"
    state_path = FLOW / "_state.json"

    sha, ok = check_harness(state_path, args.approve_harness)
    if not ok:
        sys.exit(2)

    # The judge is optional on purpose. Every model available on this machine is
    # either the one under test, rate-limited, or out of credit - and a shape-only
    # eval that runs today beats a complete one that cannot run at all. Point
    # --judge at a working model and the answer column turns on.
    judging = args.judge.lower() != "none"
    judge_provider, judge_model = (args.judge.split(":", 1) if judging else (None, None))

    cases = json.loads((REPO / args.cases).read_text(encoding="utf-8"))["cases"]
    if args.limit:
        cases = cases[: args.limit]

    # Resume: whatever is already scored at this (case, rep) is left alone.
    have = set()
    if results_path.exists():
        for line in results_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                have.add((row["prompt_id"], row.get("rep", 0)))

    todo = [(c, r) for c in cases for r in range(args.reps) if (c["id"], r) not in have]
    if not todo:
        print("nothing to do - every case already has results (delete them to re-run)")
        return
    print(f"{len(todo)} case-reps to run ({len(cases)} cases x {args.reps} reps)")

    # --- 1. speak the spoken cases, once, and transcribe them --------------
    spoken = [c for c in cases if c.get("audio")]
    transcripts = {}
    if spoken:
        print(f"synthesising {len(spoken)} audio fixtures")
        jobs = []
        for case in spoken:
            wav = FLOW / "audio" / f"{case['id']}.wav"
            if not wav.exists():
                synth_wav(case["prompt"], wav)
            jobs.append({"key": f"tx::{case['id']}", "op": "transcribe", "wav_path": str(wav)})
        got, _ = with_retries(jobs, "transcribe", args.timeout_s, concurrency=args.concurrency, pace_ms=args.pace_ms)
        for case in spoken:
            row = got.get(f"tx::{case['id']}", {})
            transcripts[case["id"]] = row.get("text") if row.get("ok") else None

    # --- 2. answers --------------------------------------------------------
    def question_for(case):
        """A spoken case is answered from its transcript, as it would be live."""
        return transcripts.get(case["id"]) or case["prompt"]

    answer_jobs = [{
        "key": f"ans::{c['id']}::{r}",
        "op": "answer",
        "provider": args.provider,
        "model": args.model,
        "question": question_for(c),
        "temperature": 1,
    } for c, r in todo]

    print(f"asking {len(answer_jobs)} questions through the real prompt layer")
    answers, tries = with_retries(answer_jobs, "answer", args.timeout_s, concurrency=args.concurrency, pace_ms=args.pace_ms)

    # --- 3. judge ----------------------------------------------------------
    judge_jobs = []
    for case, rep in (todo if judging else []):
        row = answers.get(f"ans::{case['id']}::{rep}")
        if row and row.get("ok"):
            judge_jobs.append({
                "key": f"judge::{case['id']}::{rep}",
                "op": "judge",
                "provider": judge_provider,
                "model": judge_model,
                "question": question_for(case),
                "rubric": case["rubric"],
                "answer": row["text"],
            })
    if judging:
        print(f"judging {len(judge_jobs)} answers with {judge_model}")
    else:
        print("no judge configured - scoring shape and transcription only")
    judged, _ = with_retries(judge_jobs, "judge", args.timeout_s, concurrency=args.concurrency, pace_ms=args.pace_ms)

    # A judge that answers 200-with-no-text is not a failed call, so the retry
    # loop above never sees it - but an unparseable verdict is still a grader
    # failure. Re-ask for exactly those before anything is written.
    unparsed = [j for j in judge_jobs if parse_judge((judged.get(j["key"]) or {}).get("text"))[0] is None]
    if unparsed:
        print(f"  {len(unparsed)} judge replies did not parse; re-asking")
        again, _ = with_retries(unparsed, "judge-reask", args.timeout_s, attempts=2, concurrency=args.concurrency, pace_ms=args.pace_ms)
        judged.update({k: v for k, v in again.items() if parse_judge(v.get("text"))[0] is not None})

    # --- 4. write the contract --------------------------------------------
    with results_path.open("a", encoding="utf-8") as results_f, \
         errors_path.open("a", encoding="utf-8") as errors_f:

        for case, rep in todo:
            ans = answers.get(f"ans::{case['id']}::{rep}")
            if not ans or not ans.get("ok"):
                # A harness or serving failure must not occupy the (case, rep)
                # slot, or resume would skip it forever and score plumbing as a
                # model failure.
                errors_f.write(json.dumps({
                    "prompt_id": case["id"], "rep": rep,
                    "failure_class": "serving_error",
                    "error": (ans or {}).get("error", "no result returned"),
                    "attempts": tries.get(f"ans::{case['id']}::{rep}", 0),
                }) + "\n")
                continue

            text = ans["text"]
            shape, failures = run_checks(text, case.get("checks", {}))
            score, reason = None, ""
            if judging:
                score, reason = parse_judge((judged.get(f"judge::{case['id']}::{rep}") or {}).get("text"))

            if judging and score is None:
                # The answer may be perfect; we simply failed to grade it. Writing
                # a zero here would blame the model for the harness, and writing
                # any row at this key would stop resume ever retrying it.
                errors_f.write(json.dumps({
                    "prompt_id": case["id"], "rep": rep,
                    "failure_class": "grader_error",
                    "error": reason or "judge produced no usable score",
                    "shape": shape,
                }) + "\n")
                continue

            grade = {"shape": shape}
            explanation = {"shape": "; ".join(failures) or "all checks passed"}
            if score is not None:
                grade["answer"] = score
                explanation["answer"] = reason or ""

            if case.get("audio"):
                heard = transcripts.get(case["id"])
                grade["wer"] = word_error_rate(case["prompt"], heard) if heard else 1.0
                explanation["wer"] = f"heard: {heard!r}" if heard else "transcription failed"

            results_f.write(json.dumps({
                "prompt_id": case["id"],
                "rep": rep,
                "prompt": question_for(case),
                "tags": case["tags"],
                "model": ans.get("model"),
                "status": "ok",
                "stop_reason": "end_turn",
                "grade": grade,
                "explanation": explanation,
                "latency_s": round(ans.get("latency_s", 0), 2),
                "answer_chars": len(text),
                "meta": {"judge_model": JUDGE_MODEL, "spoken": bool(case.get("audio"))},
            }) + "\n")
            results_f.flush()

            trace = [
                {"role": "system", "content": f"(the app's real system instruction, {ans.get('system_chars')} chars)"},
                {"role": "user", "content": question_for(case)},
                {"role": "assistant", "content": text},
            ]
            (out_dir / "traces" / f"{case['id']}_rep{rep}.json").write_text(
                json.dumps(trace, indent=2), encoding="utf-8"
            )

    # --- 5. state + summary ------------------------------------------------
    state_path.write_text(json.dumps({
        "schema": "hillclimb/v2",
        "harness_sha": sha,
        "harness_paths": ["evals/run_eval.py", "evals/checks.py", "evals/bridge.js", "evals/cases.json"],
        # Order decides the headline metric. With no judge, shape leads: it is
        # the only quality number actually being measured, and declaring an
        # absent one would draw a column of dashes.
        "metrics": (
            [{"id": "answer", "label": "Answer", "kind": "judge", "scale": 1, "better": "higher"}]
            if judging else []
        ) + [
            {"id": "shape", "label": "Shape", "kind": "float", "scale": 1, "better": "higher"},
            {"id": "wer", "label": "WER", "kind": "float", "scale": 1, "better": "lower"},
        ],
        "perf_fields": [
            {"id": "latency_s", "label": "Latency s"},
            {"id": "answer_chars", "label": "Chars"},
        ],
        "variants": [{"id": args.variant, "label": args.variant}],
        "metrics_md": (
            "**answer** - judge score against each case's rubric (headline).\n\n"
            "**shape** - fraction of programmatic checks passed. Deterministic.\n\n"
            "**wer** - word error rate on spoken cases; lower is better.\n\n"
            f"Judge is `{JUDGE_MODEL}` (OpenAI) grading `{MODEL_UNDER_TEST}` (Google) - a "
            "different vendor, so the judge has no stake in the phrasing it grades. At 12 cases "
            "x 2 reps the noise floor on the answer score is roughly +/-14 points; treat smaller "
            "moves as noise and lean on **shape**, which is deterministic.\n\n"
            "Audio is Windows TTS, cleaner than a real call: WER here is optimistic."
        ),
    }, indent=2), encoding="utf-8")

    rows = [json.loads(l) for l in results_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if rows:
        mean = lambda k: sum(r["grade"].get(k, 0) for r in rows if k in r["grade"]) / max(
            1, sum(1 for r in rows if k in r["grade"]))
        n_err = sum(1 for l in errors_path.read_text(encoding="utf-8").splitlines() if l.strip()) if errors_path.exists() else 0
        print(f"\n{len(rows)} scored, {n_err} errored")
        present = [k for k in ("answer", "shape", "wer") if any(k in r["grade"] for r in rows)]
        print("  " + "   ".join(f"{k} {mean(k):.2f}" for k in present))
        worst = sorted(rows, key=lambda r: (r["grade"]["shape"], r["grade"].get("answer", 1)))[:3]
        for r in worst:
            print(f"  weakest: {r['prompt_id']:<22} shape {r['grade']['shape']:.2f}  "
                  f"{r['explanation']['shape'][:70]}")

    shutil.rmtree(FLOW / "_work", ignore_errors=True)
    print(f"\nresults: {results_path}")


if __name__ == "__main__":
    main()
