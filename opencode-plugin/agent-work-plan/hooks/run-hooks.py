#!/usr/bin/env python3
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

"""Runs several of the shared hook scripts on one event in one Python process.

    run-hooks.py <plans folder> <script>... < event.json

The OpenCode Agent Plus plugin calls this on a user message and after a compaction, for the work plan, the time-zone note and
the reply-image note together, instead of starting Python once for each. Each script's main() runs as if the script
had been started on its own: it gets the plans folder as its first argument and the event on standard input, and what
it prints is taken as its answer.
Prints {"texts": {"<script>": "<its additionalContext, or empty>"}}; a script that is missing, fails or says nothing
gives "". This file is the plugin's own, not one of the scripts copied from Agent Plus.
"""
import importlib.util
import io
import json
import os
import sys

# Set before the imports the scripts make: see inject-work-plan.py.
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Only these may be named: each reads one event and prints one hook answer.
ALLOWED = ("inject-work-plan.py", "resume-work-plan.py", "tell-time-zone.py", "tell-reply-images.py")


def run_one(name, payload, plans):
    path = os.path.join(HERE, name)
    if name not in ALLOWED or not os.path.isfile(path):
        return ""
    spec = importlib.util.spec_from_file_location("hook_" + name[:-3].replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    saved = (sys.argv, sys.stdin, sys.stdout)
    out = io.StringIO()
    try:
        sys.argv = [path, plans]
        sys.stdin = io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")
        sys.stdout = out
        spec.loader.exec_module(module)
        module.main()
    except SystemExit:
        pass
    except Exception as e:
        sys.stderr.write("%s failed: %s\n" % (name, e))
        return ""
    finally:
        sys.argv, sys.stdin, sys.stdout = saved
    text = out.getvalue().strip()
    if not text:
        return ""
    try:
        said = json.loads(text).get("hookSpecificOutput", {}).get("additionalContext")
    except Exception:
        return ""
    return said if isinstance(said, str) else ""


def main():
    if len(sys.argv) < 2:
        return 2
    plans, names = sys.argv[1], sys.argv[2:]
    payload = sys.stdin.buffer.read()
    texts = {}
    for name in names:
        texts[name] = run_one(name, payload, plans)
    print(json.dumps({"texts": texts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
