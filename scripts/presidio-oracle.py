#!/usr/bin/env python3
"""Run the real microsoft/presidio analyzer over docs/pii-corpus.json.

The browser app cannot ship Presidio (it needs Python and a spaCy model), so
this script is how the TypeScript port in `src/engine/presidio/` is checked
against the reference implementation: it writes `docs/presidio-oracle.json`,
which the unit tests then compare against.

Setup (Python 3.10+):
    pip install presidio-analyzer==2.2.366
    python -m spacy download en_core_web_sm

Usage:
    python3 scripts/presidio-oracle.py            # write the oracle file
    python3 scripts/presidio-oracle.py --check    # compare and exit non-zero on drift
"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS = ROOT / "docs" / "pii-corpus.json"
ORACLE = ROOT / "docs" / "presidio-oracle.json"

# Entities the TypeScript port also implements; the language-specific Korean
# set is intentionally absent because stock Presidio has no Korean recognizers.
SHARED = {
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "CREDIT_CARD",
    "IBAN_CODE",
    "IP_ADDRESS",
    "PERSON",
    "LOCATION",
    "DATE_TIME",
}


def build_engine():
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    configuration = {
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
    }
    provider = NlpEngineProvider(nlp_configuration=configuration)
    return AnalyzerEngine(nlp_engine=provider.create_engine(), supported_languages=["en"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail when the stored oracle is stale")
    parser.add_argument("--threshold", type=float, default=0.4)
    args = parser.parse_args()

    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    engine = build_engine()

    samples = []
    for sample in corpus["samples"]:
        if sample["language"] != "en":
            samples.append({"id": sample["id"], "results": [], "note": "stock Presidio has no Korean recognizers"})
            continue
        results = engine.analyze(
            text=sample["text"],
            language="en",
            score_threshold=args.threshold,
            entities=list(SHARED),
        )
        samples.append(
            {
                "id": sample["id"],
                "results": [
                    {
                        "entity_type": r.entity_type,
                        "start": r.start,
                        "end": r.end,
                        "score": round(r.score, 3),
                        "value": sample["text"][r.start : r.end],
                    }
                    for r in sorted(results, key=lambda r: r.start)
                ],
            }
        )

    oracle = {
        "generated_by": "scripts/presidio-oracle.py",
        "presidio_analyzer": metadata.version("presidio-analyzer"),
        "spacy_model": "en_core_web_sm",
        "score_threshold": args.threshold,
        "shared_entities": sorted(SHARED),
        "samples": samples,
    }

    if args.check:
        if not ORACLE.exists():
            print("missing docs/presidio-oracle.json", file=sys.stderr)
            return 1
        stored = json.loads(ORACLE.read_text(encoding="utf-8"))
        if stored.get("samples") != oracle["samples"]:
            print("oracle drift: docs/presidio-oracle.json no longer matches this Presidio run", file=sys.stderr)
            return 1
        print("oracle is current")
        return 0

    ORACLE.write_text(json.dumps(oracle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {ORACLE.relative_to(ROOT)} ({len(samples)} samples)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
