#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo 'Usage: npm run check:tla -- /path/to/tla2tools.jar' >&2
    exit 2
fi

jar="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/cu-tlc.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$root/formal/Lifecycle.tla" "$root/formal/Local.cfg" "$root/formal/Broker.cfg" "$work/"
cd "$work"

for config in Local Broker; do
    java -XX:+UseParallelGC -Xmx2g -Dtlc2.tool.fp.FPSet.impl=tlc2.tool.fp.MemFPSet \
        -cp "$jar" tlc2.TLC -fp 0 -fpbits 8 -workers 1 -lncheck final \
        -config "$config.cfg" -metadir "$work/$config" Lifecycle.tla
done
