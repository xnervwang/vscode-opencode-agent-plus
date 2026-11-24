#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# Builds build/<publisher>.<name>-<version>.vsix: the extension's own files plus the packages its "dependencies" need at
# run time. Nothing is published or installed.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec "${NODE:-node}" "$root/build/pack-vsix.js" "$root"
