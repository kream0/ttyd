#!/usr/bin/env python3
# Puts the tty in raw mode and appends every byte it reads to a file as hex.
import os, sys, termios, tty

out = open(sys.argv[1], "a", buffering=1)
if len(sys.argv) > 2:
    sys.stdout.write(sys.argv[2].encode().decode("unicode_escape"))
    sys.stdout.flush()
tty.setraw(0)
print("ready", end="\r\n", flush=True)
while True:
    data = os.read(0, 4096)
    if not data:
        break
    out.write(data.hex() + "\n")
