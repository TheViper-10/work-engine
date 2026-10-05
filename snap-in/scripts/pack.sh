#!/bin/sh
# Writes the two thin entry files next to dist/native.js and builds the tarball (v8 command, TC/README.md:49).
set -eu
cd "$(dirname "$0")/.."
[ -f dist/native.js ] || { echo "dist/native.js missing: run npm run snapin:build first" >&2; exit 1; }
mkdir -p dist/functions/work_engine dist-tarballs
printf '"use strict";\n\nmodule.exports = require("./native");\n' > dist/index.js
printf "exports.run = require('../../native').functionFactory.work_engine;\n" > dist/functions/work_engine/index.js
OUT=dist-tarballs/work-engine-qa-v7.tgz
rm -f "$OUT"
tar --no-xattrs -cf - manifest.yaml package.json dist/index.js dist/native.js dist/functions/work_engine/index.js | gzip -n > "$OUT"
echo "$OUT"
shasum -a 256 "$OUT"
