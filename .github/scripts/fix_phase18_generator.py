from pathlib import Path

path = Path("scripts/generate-remote-control-action-registry.mjs")
text = path.read_text(encoding="utf-8")
old = "  const files = await walk(CLIENT_SRC);"
new = "  const files = (await walk(CLIENT_SRC)).filter((file) => !/\\.(?:test|spec)\\.[^.]+$/.test(file));"
if text.count(old) != 1:
    raise SystemExit(f"expected one scanner file-list assignment, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Excluded test/spec fixtures from remote-control production coverage scan")
